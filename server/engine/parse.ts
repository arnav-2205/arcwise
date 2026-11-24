// Structural extraction: functions, imports, layers and side effects per file.
// ARCWISE: lightweight lexical extractor. The tree-sitter (web-tree-sitter WASM) extractor from
// Understand-Anything core can replace extractFunctions/extractImports behind the same interface.
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { FunctionInfo, GraphEdge, GraphNode, Layer, SideEffect } from '../../lib/types';
import type { SourceFile } from './source';
import { indentOf, lineIndex, matchBracket } from './text';

const JS_FN_DECL = /^[ \t]*(export\s+)?(?:default\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]/gm;
const JS_FN_ARROW = /^[ \t]*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(async\s+)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=>)/gm;
const JS_METHOD = /^[ \t]+(?:public\s+|private\s+|protected\s+|static\s+)*(async\s+)?([A-Za-z_$][\w$]*)\s*\([^)\n]*\)\s*(?::\s*[^{\n]+)?\{/gm;
const NOT_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'constructor', 'else', 'with', 'do']);
const PY_DEF = /^([ \t]*)(async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm;

export function extractFunctions(file: SourceFile): FunctionInfo[] {
  const { text } = file;
  const idx = lineIndex(text);
  const out: FunctionInfo[] = [];
  if (file.language === 'Python') {
    const lines = text.split('\n');
    for (const m of text.matchAll(PY_DEF)) {
      const start = idx.lineOf(m.index!);
      const ind = m[1].length;
      let end = start;
      for (let i = start; i < lines.length; i++) {
        const l = lines[i];
        if (l.trim() === '' || l.trimStart().startsWith('#')) continue;
        if (indentOf(l) <= ind && i > start - 1 && !/^\s*[)\]]/.test(l)) break;
        end = i + 1;
      }
      out.push({ name: m[3], lines: [start, Math.max(start, end)], async: !!m[2], exported: !m[3].startsWith('_') && ind === 0 });
    }
    return out;
  }
  const add = (name: string, at: number, isAsync: boolean, exported: boolean) => {
    const start = idx.lineOf(at);
    out.push({ name, lines: [start, idx.lineOf(bodyEnd(text, at))], async: isAsync, exported });
  };
  for (const m of text.matchAll(JS_FN_DECL)) add(m[3], m.index!, !!m[2], !!m[1]);
  for (const m of text.matchAll(JS_FN_ARROW)) add(m[2], m.index!, !!m[3], !!m[1]);
  for (const m of text.matchAll(JS_METHOD)) if (!NOT_METHOD.has(m[2])) add(m[2], m.index!, !!m[1], false);
  // dedupe by start line
  const seen = new Set<number>();
  return out.filter(f => (seen.has(f.lines[0]) ? false : (seen.add(f.lines[0]), true))).sort((a, b) => a.lines[0] - b.lines[0]);
}

/**
 * Index of the last character of a JS/TS function starting at `at`: skips the parameter list and any
 * return type annotation, then matches the body braces. Expression-bodied arrows end at the statement end.
 */
function bodyEnd(text: string, at: number): number {
  const paren = text.indexOf('(', at);
  if (paren < 0 || paren - at > 300) return at;
  const pEnd = matchBracket(text, paren);
  if (pEnd < 0) return at;
  let i = pEnd, angle = 0;
  while (i < text.length && i - pEnd < 400) {
    const c = text[i];
    if (c === '=' && text[i + 1] === '>') { i += 2; while (/\s/.test(text[i] ?? '')) i++; if (text[i] !== '{') { const semi = text.indexOf(';', i); const nl = text.indexOf('\n', i); return Math.max(i, Math.min(semi < 0 ? text.length : semi, nl < 0 ? text.length : nl)); } continue; }
    if (c === '<') angle++;
    else if (c === '>') angle = Math.max(0, angle - 1);
    else if (c === '{' && angle === 0) {
      // a type literal right after ':' is a return type, not the body
      const before = text.slice(pEnd, i).trim();
      if (before.endsWith(':')) { const e = matchBracket(text, i); if (e < 0) return at; i = e; continue; }
      const e = matchBracket(text, i);
      return e < 0 ? at : e - 1;
    } else if (c === ';') return i;
    i++;
  }
  return at;
}

/** Innermost function containing a line, or "<module>". */
export function enclosingFunction(fns: FunctionInfo[], line: number): FunctionInfo | null {
  let best: FunctionInfo | null = null;
  for (const f of fns) if (f.lines[0] <= line && line <= f.lines[1] && (!best || f.lines[0] >= best.lines[0])) best = f;
  return best;
}

export interface ImportInfo { spec: string; names: string[]; line: number }

export function extractImports(file: SourceFile): ImportInfo[] {
  const { text } = file;
  const idx = lineIndex(text);
  const out: ImportInfo[] = [];
  if (file.language === 'Python') {
    for (const m of text.matchAll(/^[ \t]*from\s+(\.*[\w.]*)\s+import\s+\(?([\w*, \t\n]+?)\)?\s*$/gm))
      out.push({ spec: m[1], names: m[2].split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean), line: idx.lineOf(m.index!) });
    for (const m of text.matchAll(/^[ \t]*import\s+([\w.]+)(?:\s+as\s+\w+)?\s*$/gm)) out.push({ spec: m[1], names: [], line: idx.lineOf(m.index!) });
    return out;
  }
  for (const m of text.matchAll(/(?:^|[\s;])(?:import|export)\s+(?:type\s+)?([\s\S]*?)\s*from\s*['"]([^'"\n]+)['"]/g)) {
    const names = [...m[1].matchAll(/([A-Za-z_$][\w$]*)(?:\s+as\s+[A-Za-z_$][\w$]*)?/g)].map(x => x[1]).filter(n => n !== 'type' && n !== 'as');
    out.push({ spec: m[2], names, line: idx.lineOf(m.index! + m[0].indexOf(m[2])) });
  }
  for (const m of text.matchAll(/^[ \t]*import\s+['"]([^'"\n]+)['"]/gm)) out.push({ spec: m[1], names: [], line: idx.lineOf(m.index!) });
  for (const m of text.matchAll(/(?:require|import)\(\s*['"]([^'"\n]+)['"]\s*\)/g)) out.push({ spec: m[1], names: [], line: idx.lineOf(m.index!) });
  return out;
}

const JS_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

export function resolveImport(from: string, spec: string, language: string, known: Set<string>): string | null {
  if (language === 'Python') {
    const dots = /^\.*/.exec(spec)![0].length;
    const mod = spec.slice(dots).replace(/\./g, '/');
    const bases: string[] = [];
    if (dots > 0) {
      let dir = path.posix.dirname(from);
      for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
      bases.push(dir === '.' ? '' : dir);
    } else bases.push('', 'src', 'app');
    for (const b of bases) {
      const p = [b, mod].filter(Boolean).join('/');
      for (const c of [p + '.py', p + '/__init__.py']) if (known.has(c)) return c;
    }
    return null;
  }
  let base: string[];
  if (spec.startsWith('.')) base = [path.posix.normalize(path.posix.join(path.posix.dirname(from), spec))];
  else if (spec.startsWith('@/') || spec.startsWith('~/')) base = [spec.slice(2), 'src/' + spec.slice(2)];
  else return null;
  for (let b of base) {
    b = b.replace(/^\.\//, '');
    const noJs = b.replace(/\.(m?js|cjs|jsx)$/, '');
    for (const c of [b, ...JS_EXT.map(e => noJs + e), ...JS_EXT.map(e => b + '/index' + e)]) if (known.has(c)) return c;
  }
  return null;
}

/** Top-level package name of a bare import, or null for relative imports. */
export function packageOf(spec: string, language: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('@/') || spec.startsWith('~/')) return null;
  if (language === 'Python') return spec.split('.')[0] || null;
  const parts = spec.replace(/^node:/, '').split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const LLM_PKGS = new Set(['openai', '@anthropic-ai/sdk', 'anthropic', '@google/genai', '@google/generative-ai', 'google', 'ai', '@ai-sdk/openai', '@ai-sdk/anthropic', '@ai-sdk/google', 'langchain', '@langchain/openai', '@langchain/anthropic', '@langchain/core', 'langchain_openai', 'langchain_anthropic', 'litellm', 'cohere', 'mistralai', 'groq']);
const DB_PKGS = new Set(['pg', 'postgres', 'mysql', 'mysql2', 'sqlite3', 'better-sqlite3', 'mongoose', 'mongodb', 'prisma', '@prisma/client', 'drizzle-orm', 'typeorm', 'sequelize', 'knex', 'redis', 'ioredis', 'sqlalchemy', 'psycopg', 'psycopg2', 'pymongo', 'asyncpg', 'bullmq', '@supabase/supabase-js', 'supabase', 'django']);
const NET_PKGS = new Set(['axios', 'node-fetch', 'got', 'undici', 'requests', 'httpx', 'aiohttp', 'stripe', 'nodemailer', '@sendgrid/mail']);
const FS_PKGS = new Set(['fs', 'fs/promises', 'node:fs', 'node:fs/promises', 'pathlib', 'shutil']);

export function sideEffectsOf(file: SourceFile, pkgs: string[]): SideEffect[] {
  const fx = new Set<SideEffect>();
  for (const p of pkgs) {
    if (LLM_PKGS.has(p)) fx.add('llm');
    if (DB_PKGS.has(p)) fx.add('database');
    if (NET_PKGS.has(p)) fx.add('network');
    if (FS_PKGS.has(p)) fx.add('filesystem');
  }
  if (/\bfetch\s*\(/.test(file.text)) fx.add('network');
  if (/\b(OPENROUTER|OPENAI|ANTHROPIC|GROQ|GEMINI|GOOGLE_GENERATIVE_AI|MISTRAL|DEEPSEEK|TOGETHER|XAI)_API_KEY\b|openrouter\.ai\/api/.test(file.text)) fx.add('llm');
  if (file.language === 'Python' && /\bopen\s*\([^)]*['"][wa]/.test(file.text)) fx.add('filesystem');
  if (/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/.test(file.text)) fx.add('database');
  return [...fx];
}

export function layerOf(file: SourceFile, fx: SideEffect[], hasAiCalls: boolean): Layer {
  const p = file.path.toLowerCase();
  if (hasAiCalls) return 'ai';
  if (/(^|\/)(config|settings|constants?|env)(\.|\/)/.test(p)) return 'config';
  if (/(^|\/)(db|database|models?|repositor(y|ies)|schema|schemas|migrations?|prisma|stores?|cache|queues?|dao|entities|persistence)(\/|\.)/.test(p)) return 'data';
  if (/(^|\/)(app|pages|routes?|routers?|api|components|views|controllers?|handlers?|ui|screens|cli|endpoints|web)(\/|\.)/.test(p) || /\.(tsx|jsx)$/.test(p)) return 'interface';
  if (file.language === 'Python' && /@(app|router|bp|blueprint)\.(get|post|put|patch|delete|route)\(/.test(file.text)) return 'interface';
  return 'service';
}

export interface Structure {
  nodes: GraphNode[];
  edges: GraphEdge[];
  imports: Map<string, ImportInfo[]>;
  functions: Map<string, FunctionInfo[]>;
  packages: Map<string, string[]>;
}

/** Builds file nodes and import edges. Layers and summaries are filled in later stages. */
export function buildStructure(files: SourceFile[]): Structure {
  const code = files.filter(f => !f.isTest);
  const known = new Set(files.map(f => f.path));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const imports = new Map<string, ImportInfo[]>();
  const functions = new Map<string, FunctionInfo[]>();
  const packages = new Map<string, string[]>();
  const edgeSet = new Set<string>();
  for (const f of files) {
    const imps = extractImports(f);
    imports.set(f.path, imps);
    functions.set(f.path, extractFunctions(f));
    packages.set(f.path, [...new Set(imps.map(i => packageOf(i.spec, f.language)).filter((x): x is string => !!x))]);
  }
  for (const f of code) {
    const fx = sideEffectsOf(f, packages.get(f.path)!);
    nodes.push({
      id: f.path, name: path.posix.basename(f.path), file: f.path, language: f.language, layer: 'service',
      loc: f.text.split('\n').length, functions: functions.get(f.path)!, sideEffects: fx, summary: '', plain: '', summarySource: 'structure',
      hash: createHash('sha1').update(f.text).digest('hex').slice(0, 16),
    });
    for (const imp of imports.get(f.path)!) {
      const to = resolveImport(f.path, imp.spec, f.language, known);
      if (to && to !== f.path && !files.find(x => x.path === to)?.isTest) {
        const key = f.path + '>' + to;
        if (!edgeSet.has(key)) { edgeSet.add(key); edges.push({ from: f.path, to, type: 'imports' }); }
      }
    }
  }
  return { nodes, edges, imports, functions, packages };
}
