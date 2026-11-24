// Finds LLM API call sites, resolves the model and the system prompt, and estimates tokens.
import path from 'node:path';
import type { CallSite, FunctionInfo, PromptInfo } from '../../../lib/types';
import type { SourceFile } from '../source';
import type { Structure } from '../parse';
import { enclosingFunction, resolveImport } from '../parse';
import { estimateTokens, indentOf, lineIndex, matchBracket } from '../text';

export const DEFAULT_CALLS_PER_MONTH = 10_000;
/** Documented assumption for user content per chat call when it cannot be resolved statically. */
export const ASSUMED_USER_TOKENS = 250;
export const ASSUMED_EMBED_TOKENS = 300;

interface Pattern { re: RegExp; provider: string; api: string; needs?: (pkgs: string[], f: SourceFile) => boolean; ctor?: boolean }
const has = (...names: string[]) => (pkgs: string[]) => names.some(n => pkgs.includes(n));

const PATTERNS: Pattern[] = [
  { re: /(?<!threads)\.chat\.completions\.create\s*\(/g, provider: 'OpenAI', api: 'chat.completions' },
  { re: /\.responses\.create\s*\(/g, provider: 'OpenAI', api: 'responses' },
  { re: /\.embeddings\.create\s*\(/g, provider: 'OpenAI', api: 'embeddings' },
  { re: /(?<!threads)\.messages\.(?:create|stream)\s*\(/g, provider: 'Anthropic', api: 'messages', needs: (p, f) => has('@anthropic-ai/sdk', 'anthropic')(p) || /anthropic/i.test(f.text) },
  { re: /\.(?:generateContent|generateContentStream|generate_content)\s*\(/g, provider: 'Google', api: 'generateContent', needs: (p, f) => p.some(x => x.startsWith('@google/') || x === 'google') || /genai|generativeai/i.test(f.text) },
  { re: /\b(?:generateText|streamText|generateObject|streamObject)\s*\(/g, provider: 'Vercel AI SDK', api: 'generateText', needs: has('ai') },
  { re: /\bembed(?:Many)?\s*\(\s*\{/g, provider: 'Vercel AI SDK', api: 'embed', needs: has('ai') },
  { re: /\b(?:new\s+)?Chat(?:OpenAI|Anthropic|GoogleGenerativeAI)\s*\(/g, provider: 'LangChain', api: 'chat model', ctor: true, needs: (p) => p.some(x => x.includes('langchain')) },
  { re: /\blitellm\.a?completion\s*\(/g, provider: 'LiteLLM', api: 'completion' },
  { re: /\b(?:fetch|axios\.post|axios|requests\.post|httpx\.post|client\.post|ky\.post|got\.post)\s*\(\s*(?:f?["'`])(?:https:\/\/(?:api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|openrouter\.ai|api\.groq\.com|api\.together\.xyz|api\.mistral\.ai|api\.deepseek\.com|api\.x\.ai|api\.perplexity\.ai|api\.fireworks\.ai)|[^"'`\n]*\/(?:chat\/completions|v1\/messages|completions)["'`])/g, provider: 'HTTP', api: 'raw request' },
];

export interface FoundPrompt { id: string; name: string; file: string; line: number; text: string; tokens: number; usedBy: string | null }

const PROMPT_NAME = /(system|prompt|instruction|persona|preamble|guideline)/i;

/**
 * Every system prompt in the code, whether or not a call site could be linked to it:
 * prompt-named constants holding long strings, and `{ role: "system", content: "..." }` literals.
 */
export function findPrompts(files: SourceFile[], sites: CallSite[]): FoundPrompt[] {
  const out: FoundPrompt[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (f.isTest) continue;
    const idx = lineIndex(f.text);
    const add = (name: string, at: number, expr: string) => {
      const v = stringValue(expr);
      if (!v || v.text.trim().length < 60) return;
      const key = v.text.trim().slice(0, 200);
      if (seen.has(key)) return;
      seen.add(key);
      const line = idx.lineOf(at);
      const used = sites.find(s => s.systemPrompt && s.systemPrompt.text.trim().slice(0, 200) === key);
      out.push({ id: `${f.path}:${line}`, name, file: f.path, line, text: v.text, tokens: estimateTokens(v.text), usedBy: used?.id ?? null });
    };
    for (const m of f.text.matchAll(/(?:^|\n)[ \t]*(?:export\s+)?(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?=[fFrR]?["'`])/g)) {
      if (PROMPT_NAME.test(m[1])) add(m[1], m.index! + m[0].length, takeExpr(f.text, m.index! + m[0].length));
    }
    for (const m of f.text.matchAll(/["']?role["']?\s*[:=]\s*["']system["']\s*,\s*["']?content["']?\s*[:=]\s*(?=[fFrR]?["'`])/g)) {
      add('role: system', m.index!, takeExpr(f.text, m.index! + m[0].length));
    }
  }
  return out.sort((a, b) => b.tokens - a.tokens);
}

/** OpenAI-compatible hosts reached through the OpenAI SDK (baseURL) or raw HTTP. */
const COMPAT: [RegExp, string][] = [
  [/openrouter\.ai|OPENROUTER|@openrouter\//i, 'OpenRouter'], [/api\.groq\.com|GROQ_API_KEY/, 'Groq'], [/api\.together\.xyz|TOGETHER_API_KEY/, 'Together'],
  [/api\.deepseek\.com|DEEPSEEK_API_KEY/, 'DeepSeek'], [/api\.mistral\.ai|MISTRAL_API_KEY/, 'Mistral'], [/api\.x\.ai|XAI_API_KEY/, 'xAI'],
  [/api\.perplexity\.ai|PERPLEXITY_API_KEY/, 'Perplexity'], [/api\.fireworks\.ai|FIREWORKS_API_KEY/, 'Fireworks'],
];
function compatProvider(text: string): string | null { for (const [re, name] of COMPAT) if (re.test(text)) return name; return null; }

const CLASSIFY_HINT = /\b(classif\w*|categor\w*|label\w*|sentiment|intent|route the|routing|yes or no|true or false|one word|single word|respond with only|reply with only|answer with only|score from)\b/i;

export interface DetectContext {
  files: SourceFile[];
  structure: Structure;
  readText(rel: string): Promise<string | null>;
}

export interface DetectedSite extends CallSite { argsText: string }

export async function detectCallSites(ctx: DetectContext): Promise<DetectedSite[]> {
  const out: DetectedSite[] = [];
  const ids = new Set<string>();
  const byPath = new Map(ctx.files.map(f => [f.path, f]));
  for (const f of ctx.files) {
    if (f.isTest) continue;
    const pkgs = ctx.structure.packages.get(f.path) ?? [];
    const fns = ctx.structure.functions.get(f.path) ?? [];
    const idx = lineIndex(f.text);
    const seenAt = new Set<number>();
    for (const p of PATTERNS) {
      if (p.needs && !p.needs(pkgs, f)) continue;
      for (const m of f.text.matchAll(p.re)) {
        const at = m.index!;
        if (seenAt.has(at)) continue;
        const line = idx.lineOf(at);
        const lineText = f.text.split('\n')[line - 1] ?? '';
        if (/^\s*(\/\/|#|\*|\/\*)/.test(lineText)) continue;
        const open = at + m[0].lastIndexOf('(');
        const close = open >= 0 ? matchBracket(f.text, open) : -1;
        if (close < 0) continue;
        seenAt.add(at);
        const args = f.text.slice(open + 1, close - 1);
        const endLine = idx.lineOf(close - 1);
        const fn = enclosingFunction(fns, line);
        let provider = p.provider;
        if (provider === 'OpenAI' && pkgs.includes('groq')) provider = 'Groq';
        if (provider === 'HTTP') provider = compatProvider(m[0] + args) ?? compatProvider(f.text) ?? (/anthropic|v1\/messages/.test(m[0]) ? 'Anthropic' : /googleapis/.test(m[0]) ? 'Google' : 'OpenAI-compatible');
        else if (provider === 'OpenAI' || provider === 'Vercel AI SDK') { const c = compatProvider(f.text); if (c) provider = provider === 'OpenAI' ? c : `${c} (AI SDK)`; }
        if (provider === 'LangChain') provider = /Anthropic/.test(m[0]) ? 'Anthropic (LangChain)' : /Google/.test(m[0]) ? 'Google (LangChain)' : 'OpenAI (LangChain)';
        const api = p.provider === 'Vercel AI SDK' ? /\w+/.exec(m[0])![0]
          : p.api === 'messages' && /stream/.test(m[0]) ? 'messages (stream)' : p.api;

        const model = resolveModel(args, f, fns, line, ctx, byPath);
        const maxTokens = numberArg(args, /\b(?:max_tokens|maxTokens|max_output_tokens|max_completion_tokens|maxOutputTokens|max_new_tokens)\s*[:=]\s*(\d[\d_]*)/);
        const streaming = /\bstream\s*[:=]\s*(true|True)\b/.test(args) || /stream/i.test(m[0]);
        const tools = /\btools\s*[:=]/.test(args);
        const hasTimeout = /\b(timeout|request_timeout|signal)\s*[:=]/.test(args) || /\b(?:OpenAI|Anthropic|AsyncOpenAI|AsyncAnthropic)\s*\([^)]*\btimeout\b/s.test(f.text);
        const officialSdk = ['OpenAI', 'Anthropic', 'Groq'].includes(provider) && p.provider !== 'HTTP';
        const hasRetry = officialSdk || /\b(maxRetries|max_retries|retry|retries|backoff|tenacity)\b/i.test(f.text);
        const systemPrompt = await resolveSystemPrompt(args, f, fns, line, ctx, byPath);
        const inLoop = isInLoop(f, fn, at, line);

        const isEmbed = /embed/i.test(api);
        const classifyLike = CLASSIFY_HINT.test(systemPrompt?.text ?? '') || CLASSIFY_HINT.test(args);
        const guess = isEmbed ? 0 : classifyLike ? 20 : 400;
        const outputTokens = isEmbed ? 0 : maxTokens != null ? Math.min(maxTokens, guess) : guess;
        const inputTokens = isEmbed ? ASSUMED_EMBED_TOKENS : (systemPrompt?.tokens ?? 0) + ASSUMED_USER_TOKENS;

        let id = `${f.path}#${fn?.name ?? '<module>'}`;
        if (ids.has(id)) id += `:${line}`;
        ids.add(id);
        const site: DetectedSite = {
          id, file: f.path, fn: fn?.name ?? '<module>', lines: [line, endLine], provider, api,
          model: model.value, modelResolved: model.how, inLoop, maxTokens, streaming, tools, hasTimeout, hasRetry,
          systemPrompt, inputTokens, outputTokens, outputTokensSource: maxTokens != null && maxTokens < guess ? 'max-tokens' : 'task-guess',
          callsPerMonth: DEFAULT_CALLS_PER_MONTH, callsSource: 'default', flags: [], quality: 'unvalidated', argsText: args,
        };
        out.push(site);
      }
    }
  }
  return out;
}

function numberArg(args: string, re: RegExp): number | null {
  const m = re.exec(args);
  return m ? Number(m[1].replace(/_/g, '')) : null;
}

/* ---------------- model ---------------- */

function resolveModel(args: string, f: SourceFile, fns: FunctionInfo[], line: number, ctx: DetectContext, byPath: Map<string, SourceFile>): { value: string; how: CallSite['modelResolved'] } {
  let m = /\bmodel(?:_name)?\s*[:=]\s*(?:openai|anthropic|google|azure|mistral|groq|openrouter|deepseek|xai|together)(?:\.\w+)?\(\s*(["'`])([^"'`$]+)\1/.exec(args);
  if (m) return { value: m[2], how: 'literal' };
  m = /\bmodel(?:_name)?\s*[:=]\s*(["'`])([^"'`${}]+)\1/.exec(args);
  if (m) return { value: m[2], how: 'literal' };
  // Inline env var with a default: os.getenv("X", "gpt-4o") / process.env.X ?? "gpt-4o"
  m = /\bmodel(?:_name)?\s*[:=]\s*(?:os\.getenv|os\.environ\.get)\(\s*["'][^"']+["']\s*,\s*(["'])([^"']+)\1/.exec(args)
    ?? /\bmodel(?:_name)?\s*[:=]\s*process\.env\.\w+\s*(?:\?\?|\|\|)\s*(["'`])([^"'`]+)\1/.exec(args);
  if (m) return { value: m[2], how: 'env-default' };
  const ident = /\bmodel(?:_name)?\s*[:=]\s*([A-Za-z_$][\w$.]*)/.exec(args)?.[1] ?? (/(?:^|[{,\s])model\s*(?:,|\})/.test(args) ? 'model' : null);
  if (ident) {
    const r = resolveValueOfIdent(ident, f, ctx, byPath);
    if (r) return r;
  }
  // Google: model set when the client model is created
  const g = /getGenerativeModel\(\s*\{\s*model\s*:\s*["'`]([^"'`]+)/.exec(f.text) ?? /GenerativeModel\(\s*(?:model_name\s*=\s*)?["']([^"']+)/.exec(f.text);
  if (g) return { value: g[1], how: 'literal' };
  return { value: 'dynamic', how: 'dynamic' };
}

function constRhs(name: string, text: string): string | null {
  const esc = name.replace(/[$]/g, '\\$');
  const re = new RegExp(`(?:^|\\n)[ \\t]*(?:export\\s+)?(?:const|let|var)?\\s*${esc}\\s*(?::[^=\\n]+)?=\\s*`, 'g');
  const m = re.exec(text);
  if (!m) return null;
  return takeExpr(text, m.index + m[0].length);
}

function resolveValueOfIdent(ident: string, f: SourceFile, ctx: DetectContext, byPath: Map<string, SourceFile>): { value: string; how: CallSite['modelResolved'] } | null {
  const name = ident.split('.').pop()!;
  const sources: SourceFile[] = [f];
  const imp = (ctx.structure.imports.get(f.path) ?? []).find(i => i.names.includes(ident.split('.')[0]) || i.names.includes(name));
  if (imp) { const to = resolveImport(f.path, imp.spec, f.language, new Set(byPath.keys())); if (to && byPath.get(to)) sources.push(byPath.get(to)!); }
  for (const s of sources) {
    const rhs = constRhs(name, s.text);
    if (!rhs) continue;
    const lit = /^(["'`])([^"'`${}]+)\1$/.exec(rhs.trim());
    if (lit) return { value: lit[2], how: s === f ? 'literal' : 'constant' };
    const env = /(?:\?\?|\|\|)\s*(["'`])([^"'`]+)\1/.exec(rhs) ?? /(?:getenv|environ\.get)\(\s*["'][^"']+["']\s*,\s*["']([^"']+)["']/.exec(rhs);
    if (env) return { value: env[2] ?? env[1], how: 'env-default' };
  }
  return null;
}

/* ---------------- expressions and prompts ---------------- */

/** Reads an expression starting at `start` until a top-level , ) } ] or a statement end. */
export function takeExpr(text: string, start: number): string {
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const tri = (c === '"' || c === "'") && text.startsWith(c.repeat(3), i);
      if (tri) { const e = text.indexOf(c.repeat(3), i + 3); i = e < 0 ? text.length : e + 3; continue; }
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') i++;
        else if (c === '`' && text[i] === '$' && text[i + 1] === '{') { const e = matchBracket(text, i + 1); i = e < 0 ? text.length : e - 1; }
        i++;
      }
      i++; continue;
    }
    if (c === '(' || c === '{' || c === '[') { const e = matchBracket(text, i); if (e < 0) return text.slice(start); i = e; continue; }
    if (c === ',' || c === ')' || c === '}' || c === ']' || c === ';') break;
    if (c === '\n') {
      const rest = text.slice(i + 1).trimStart();
      if (!/^[+.?:|&]/.test(rest) && !/[+(=,:?|&]\s*$/.test(text.slice(start, i))) break;
    }
    i++;
  }
  return text.slice(start, i).trim();
}

/** Turns a string expression into prompt text, marking dynamic parts as {{placeholder}}. */
export function stringValue(expr: string): { text: string; static: boolean } | null {
  const e = expr.trim();
  let m = /^[fFrRbB]{0,2}("""|''')([\s\S]*)\1$/.exec(e);
  if (m) { const fstr = /^[fF]/.test(e); return { text: fstr ? m[2].replace(/\{([^{}]+)\}/g, '{{$1}}') : m[2], static: !fstr || !/\{[^{}]+\}/.test(m[2]) }; }
  m = /^`([\s\S]*)`$/.exec(e);
  if (m) { const dyn = /\$\{/.test(m[1]); return { text: m[1].replace(/\$\{([^}]*)\}/g, '{{$1}}'), static: !dyn }; }
  m = /^([fF]?)(["'])((?:\\.|(?!\2).)*)\2$/.exec(e);
  if (m) {
    const t = m[3].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(["'\\])/g, '$1');
    return m[1] ? { text: t.replace(/\{([^{}]+)\}/g, '{{$1}}'), static: !/\{[^{}]+\}/.test(t) } : { text: t, static: true };
  }
  // concatenation of literals and identifiers
  if (/\+/.test(e)) {
    const parts = e.split(/\s*\+\s*/);
    let text = '', stat = true, any = false;
    for (const p of parts) {
      const v = stringValue(p);
      if (v) { text += v.text; stat &&= v.static; any = true; } else { text += `{{${p.trim()}}}`; stat = false; }
    }
    return any ? { text, static: stat } : null;
  }
  return null;
}

async function exprToPrompt(expr: string, f: SourceFile, ctx: DetectContext, byPath: Map<string, SourceFile>, depth = 0): Promise<PromptInfo | null> {
  if (!expr || depth > 3) return null;
  const e = expr.trim().replace(/\.trim\(\)$/, '').replace(/\s+as\s+\w+$/, '');
  const sv = stringValue(e);
  if (sv && sv.text.trim()) return { text: sv.text, tokens: estimateTokens(sv.text), tokensEstimated: true, source: 'inline', static: sv.static };
  // Prompt files read from disk
  const fileRef = /(?:readFileSync|readFile|open|Path|read_text)\s*\(([\s\S]*?)\)/.exec(e) ? /["'`]([^"'`]+\.(?:txt|md|prompt|j2|jinja|tmpl))["'`]/.exec(e) : null;
  if (fileRef) {
    const rel = fileRef[1].replace(/^\.\//, '');
    for (const cand of [path.posix.join(path.posix.dirname(f.path), rel), rel, ...(rel.includes('/') ? [] : ['prompts/' + rel])]) {
      const t = await ctx.readText(cand);
      if (t != null) return { text: t, tokens: estimateTokens(t), tokensEstimated: true, source: `file ${path.posix.normalize(cand)}`, static: !/\{\{|\$\{/.test(t) };
    }
  }
  // Identifier: constant in this file or imported from another
  const id = /^([A-Za-z_$][\w$]*)(?:\.[\w$]+)*$/.exec(e);
  if (id) {
    const name = id[1];
    const local = constRhs(name, f.text);
    if (local && local !== e) { const p = await exprToPrompt(local, f, ctx, byPath, depth + 1); if (p) return { ...p, source: p.source === 'inline' ? `constant ${name}` : p.source }; }
    const imp = (ctx.structure.imports.get(f.path) ?? []).find(i => i.names.includes(name));
    if (imp) {
      const to = resolveImport(f.path, imp.spec, f.language, new Set(byPath.keys()));
      const tf = to ? byPath.get(to) : undefined;
      if (tf) {
        const rhs = constRhs(name, tf.text);
        if (rhs) { const p = await exprToPrompt(rhs, tf, ctx, byPath, depth + 1); if (p) return { ...p, source: p.source === 'inline' ? `constant ${name} in ${tf.path}` : p.source }; }
      }
    }
  }
  return null;
}

async function resolveSystemPrompt(args: string, f: SourceFile, fns: FunctionInfo[], line: number, ctx: DetectContext, byPath: Map<string, SourceFile>): Promise<PromptInfo | null> {
  const tryKey = async (scope: string, re: RegExp) => {
    const m = re.exec(scope);
    if (!m) return null;
    return exprToPrompt(takeExpr(scope, m.index + m[0].length), f, ctx, byPath);
  };
  const keys = [
    /\b(?:system|instructions|systemInstruction|system_instruction|system_prompt)\s*[:=]\s*/,
    /["']?role["']?\s*[:=]\s*["']system["']\s*,\s*["']?content["']?\s*[:=]\s*/,
    /\bSystemMessage\(\s*(?:content\s*=\s*)?/,
    /\(\s*["']system["']\s*,\s*/,
  ];
  for (const k of keys) { const p = await tryKey(args, k); if (p) return p; }
  // Shorthand property: { system, messages }
  const short = /(?:^|[{,\s])(system|instructions|systemPrompt|system_prompt)\s*(?=[,}\n])/.exec(args);
  if (short) { const p = await exprToPrompt(short[1], f, ctx, byPath); if (p) return p; }
  // messages built elsewhere in the enclosing function, then anywhere in the file
  const fn = enclosingFunction(fns, line);
  const lines = f.text.split('\n');
  const scopes = [fn ? lines.slice(fn.lines[0] - 1, line).join('\n') : lines.slice(Math.max(0, line - 40), line).join('\n'), f.text];
  for (const s of scopes) for (const k of keys.slice(1)) { const p = await tryKey(s, k); if (p) return p; }
  return null;
}

/* ---------------- loops ---------------- */

function isInLoop(f: SourceFile, fn: FunctionInfo | null, at: number, line: number): boolean {
  const lines = f.text.split('\n');
  if (f.language === 'Python') {
    if (/\bfor\s+\w+\s+in\b/.test(lines[line - 1]) && /[\[(]/.test(lines[line - 1])) return true;
    let min = indentOf(lines[line - 1]);
    for (let i = line - 2; i >= 0; i--) {
      const l = lines[i];
      if (!l.trim() || l.trimStart().startsWith('#')) continue;
      const ind = indentOf(l);
      if (ind < min) {
        if (/^\s*(async\s+)?(for|while)\b/.test(l)) return true;
        if (/^\s*(async\s+)?def\b|^\s*class\b/.test(l)) return false;
        min = ind;
      }
    }
    return false;
  }
  const startIdx = fn ? lineStartIndex(f.text, fn.lines[0]) : Math.max(0, at - 4000);
  const scope = f.text.slice(startIdx, at);
  const loopRe = /\b(for\s*(?:await\s*)?\(|while\s*\(|\.(?:map|forEach|flatMap|reduce)\s*\(|Promise\.all(?:Settled)?\s*\()/g;
  for (const m of scope.matchAll(loopRe)) {
    const absolute = startIdx + m.index!;
    const paren = f.text.indexOf('(', absolute + m[0].length - 1);
    const pEnd = matchBracket(f.text, paren);
    if (pEnd < 0) continue;
    if (/^(for|while)/.test(m[1])) {
      let j = pEnd; while (/\s/.test(f.text[j] ?? '')) j++;
      if (f.text[j] === '{') { const bEnd = matchBracket(f.text, j); if (bEnd > at) return true; }
      else if (f.text.indexOf(';', j) > at) return true;
    } else if (pEnd > at) return true;
  }
  return false;
}

function lineStartIndex(text: string, line: number): number {
  let idx = 0;
  for (let i = 1; i < line; i++) { idx = text.indexOf('\n', idx) + 1; if (idx === 0) return 0; }
  return idx;
}
