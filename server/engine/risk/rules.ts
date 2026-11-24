// Deterministic risk rules. Every finding cites a file and a line range that exist.
import type { CallSite, Finding, GraphEdge, GraphNode } from '../../../lib/types';
import type { SourceFile } from '../source';
import type { Structure } from '../parse';
import { enclosingFunction } from '../parse';
import { entropy, indentOf, lineIndex, maskSecret, matchBracket } from '../text';

export function stableId(rule: string, file: string, anchor: string): string {
  let h = 5381;
  const s = `${rule}|${file}|${anchor.replace(/\s+/g, ' ').trim()}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `${rule}-${h.toString(36)}`;
}

/* ---------------- secrets ---------------- */

const KNOWN_SECRETS: [RegExp, string][] = [
  [/\b(sk-ant-[A-Za-z0-9_-]{20,})/, 'Anthropic API key'],
  [/\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,})/, 'OpenAI API key'],
  [/\b(AKIA[0-9A-Z]{16})\b/, 'AWS access key'],
  [/\b(gh[pousr]_[A-Za-z0-9]{36,})\b/, 'GitHub token'],
  [/\b(xox[abpr]-[A-Za-z0-9-]{10,})\b/, 'Slack token'],
  [/\b((?:sk|rk)_live_[A-Za-z0-9]{16,})\b/, 'Stripe live key'],
  [/\b(AIza[0-9A-Za-z_-]{35})\b/, 'Google API key'],
];
// Matches the credential word anywhere in the name: apiKey, MAIL_API_KEY, mailApiKey, clientSecret, AUTH_TOKEN
const GENERIC_SECRET = /\w*?(?:api[_-]?key|secret|token|passwd|password|auth[_-]?key|access[_-]?key)\w*\s*[:=]\s*["']([^"'\s]{16,})["']/i;
const PLACEHOLDER = /^(x+|your[-_]|<|\$\{|example|changeme|placeholder|test|dummy|fake|sk-\.\.\.|\*+)/i;

export function findSecret(line: string): { value: string; kind: string; known: boolean } | null {
  for (const [re, kind] of KNOWN_SECRETS) { const m = re.exec(line); if (m && !PLACEHOLDER.test(m[1])) return { value: m[1], kind, known: true }; }
  const g = GENERIC_SECRET.exec(line);
  if (g && !PLACEHOLDER.test(g[1]) && entropy(g[1]) >= 3.5 && !/process\.env|os\.environ|getenv/.test(line)) return { value: g[1], kind: 'secret', known: false };
  return null;
}

/** Replaces every detected secret with a masked value. Used before any text reaches an LLM or the UI. */
export function redactSecrets(text: string): string {
  return text.split('\n').map(l => { const s = findSecret(l); return s ? l.split(s.value).join(maskSecret(s.value)) : l; }).join('\n');
}

/* ---------------- rules ---------------- */

export interface RuleContext {
  files: SourceFile[];
  structure: Structure;
  nodes: GraphNode[];
  edges: GraphEdge[];
  sites: CallSite[];
}

const linesOf = (f: SourceFile) => f.text.split('\n');
const slice = (f: SourceFile, a: number, b: number) => linesOf(f).slice(a - 1, b);

export function runRules(ctx: RuleContext): Finding[] {
  const out: Finding[] = [];
  const byPath = new Map(ctx.files.map(f => [f.path, f]));
  const push = (f: Omit<Finding, 'id' | 'source'>) => out.push({ ...f, id: stableId(f.rule, f.file, f.evidence[0] ?? ''), source: 'rule' });

  for (const f of ctx.files) {
    if (f.isTest) continue;
    const lines = linesOf(f);
    const js = f.language !== 'Python';
    const idx = lineIndex(f.text);

    // Hard-coded secrets
    lines.forEach((l, i) => {
      if (/^\s*(\/\/|#)/.test(l) && !/["']/.test(l)) return;
      const s = findSecret(l);
      if (!s) return;
      const masked = l.split(s.value).join(maskSecret(s.value)).trim();
      const envName = s.kind.toUpperCase().replace(/[^A-Z]+/g, '_').replace(/^_|_$/g, '');
      push({
        rule: 'hardcoded-secret', title: `${s.kind[0].toUpperCase() + s.kind.slice(1)} written in source`, severity: s.known ? 'critical' : 'high', confidence: s.known ? 'high' : 'medium',
        category: 'Secrets', file: f.path, lines: [i + 1, i + 1], evidence: [masked],
        why: 'Anyone who can read the repository can use this credential. Keys in source also spread to forks, logs and build caches.',
        fix: { del: [masked], add: [masked.replace(/(["'])[^"']*\1/, js ? `process.env.${envName}` : `os.environ["${envName}"]`)] },
        note: 'Rotate the key. Removing it from the code does not remove it from git history.',
      });
    });

    // SQL built by string concatenation or interpolation
    lines.forEach((l, i) => {
      const SQL = String.raw`\b(?:SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b`;
      const concat = ['"', "'", '`'].some(q => new RegExp(`${q}[^${q}]*${SQL}[^${q}]*${q}\\s*\\+\\s*\\w`, 'i').test(l));
      const tmpl = /(?<![\w.]sql|Prisma\.sql)`[^`]*\b(SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b[^`]*\$\{/i.test(l);
      const py = /\bf["'][^"']*\b(SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b[^"']*\{/i.test(l) || /["'][^"']*\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[^"']*["']\s*(%|\.format\()/i.test(l);
      if (!concat && !tmpl && !py) return;
      push({
        rule: 'sql-concat', title: 'SQL built from string pieces', severity: 'high', confidence: 'high', category: 'Injection',
        file: f.path, lines: [i + 1, i + 1], evidence: [l.trim()],
        why: 'A crafted value can change the query and read or modify data it should not. Use parameters so values are never parsed as SQL.',
        fix: { del: [l.trim()], add: [js ? 'db.query("... WHERE col = $1", [value])' : 'cursor.execute("... WHERE col = %s", (value,))'] },
      });
    });

    // Empty catch blocks / swallowed errors
    if (js) {
      for (const m of f.text.matchAll(/catch\s*(\([^)]*\))?\s*\{\s*\}/g)) {
        const a = idx.lineOf(m.index!), b = idx.lineOf(m.index! + m[0].length - 1);
        push({ rule: 'empty-catch', title: 'Error caught and ignored', severity: 'low', confidence: 'high', category: 'Error handling', file: f.path, lines: [a, b], evidence: slice(f, a, b).map(s => s.trim()),
          why: 'When this fails nobody finds out. The program carries on in a state nobody planned for.', fix: { del: slice(f, a, b).map(s => s.trim()), add: ['} catch (err) {', '  logger.error(err);', '  throw err;', '}'] } });
      }
      for (const m of f.text.matchAll(/\.catch\(\s*(\(\s*\w*\s*\)|\w+)\s*=>\s*\{\s*\}\s*\)/g)) {
        const a = idx.lineOf(m.index!);
        push({ rule: 'empty-catch', title: 'Promise error ignored', severity: 'low', confidence: 'high', category: 'Error handling', file: f.path, lines: [a, a], evidence: [lines[a - 1].trim()],
          why: 'The failure is silenced, so a broken step looks like a success.' });
      }
    } else {
      for (const m of f.text.matchAll(/^([ \t]*)except[^:\n]*:\s*\n[ \t]*pass\b/gm)) {
        const a = idx.lineOf(m.index! + m[1].length), b = a + 1;
        push({ rule: 'empty-catch', title: 'Exception caught and ignored', severity: 'low', confidence: 'high', category: 'Error handling', file: f.path, lines: [a, b], evidence: slice(f, a, b).map(s => s.trim()),
          why: 'When this fails nobody finds out. The program carries on in a state nobody planned for.', fix: { del: slice(f, a, b).map(s => s.trim()), add: ['except Exception:', '    logger.exception("...")', '    raise'] } });
      }
    }

    // HTTP calls without a timeout (Python requests has no default timeout)
    if (!js) lines.forEach((l, i) => {
      const m = /\brequests\.(get|post|put|patch|delete|request)\s*\(/.exec(l);
      if (!m) return;
      const lineStart = lines.slice(0, i).join('\n').length + (i ? 1 : 0);
      const at = lineStart + l.indexOf(m[0]) + m[0].length - 1;
      const end = matchBracket(f.text, at);
      const call = end > 0 ? f.text.slice(at, end) : l;
      if (/\btimeout\s*=/.test(call)) return;
      push({ rule: 'http-no-timeout', title: 'HTTP request with no timeout', severity: 'medium', confidence: 'high', category: 'Reliability', file: f.path, lines: [i + 1, i + 1], evidence: [l.trim()],
        why: 'requests waits forever by default. One slow server can hang this worker.', fix: { del: [l.trim()], add: [l.trim().replace(/\)\s*$/, ', timeout=10)')] } });
    });
  }

  // LLM-specific rules
  for (const s of ctx.sites) {
    const f = byPath.get(s.file);
    if (!f) continue;
    const lines = linesOf(f);
    const fns = ctx.structure.functions.get(f.path) ?? [];
    const fn = enclosingFunction(fns, s.lines[0]);
    const head = lines.slice(s.lines[0] - 1, Math.min(s.lines[1], s.lines[0] + 2)).map(l => l.trim());

    // No max tokens
    if (s.maxTokens == null && !/embed/i.test(s.api)) push({
      rule: 'llm-no-max-tokens', title: `LLM call in ${s.fn} has no output limit`, severity: 'medium', confidence: 'high', category: 'LLM cost and safety',
      file: s.file, lines: [s.lines[0], s.lines[0] + head.length - 1], evidence: head,
      why: 'One unusual input can produce a very long, slow and expensive answer.',
      fix: { del: [], add: [f.language === 'Python' ? '    max_tokens=600,' : '    max_tokens: 600,'] },
    });

    // Output parsed without validation
    const winEnd = Math.min(lines.length, Math.max(fn?.lines[1] ?? 0, s.lines[1] + 25));
    const window = lines.slice(s.lines[1] - 1, winEnd);
    const parseAt = window.findIndex(l => /\bJSON\.parse\s*\(|\bjson\.loads\s*\(/.test(l));
    if (parseAt >= 0 && !window.some(l => /\b\w*Schema\.(safe)?[pP]arse|\bz\.\w+\(|\.safeParse\(|model_validate|parse_obj|\bvalidate\(|ajv|TypeAdapter/.test(l))) {
      const ln = s.lines[1] + parseAt;
      push({
        rule: 'llm-unvalidated-json', title: 'Model output parsed without checking its shape', severity: 'high', confidence: 'high', category: 'LLM output',
        file: s.file, lines: [ln, ln], evidence: [lines[ln - 1].trim()],
        why: 'Models sometimes add text around JSON or rename a field. Parsing then throws, or returns data the next step does not expect.',
        fix: { del: [lines[ln - 1].trim()], add: [f.language === 'Python' ? 'out = Output.model_validate_json(raw)' : 'const out = OutputSchema.parse(JSON.parse(raw));'] },
      });
    }

    // No error handling around the call
    if (!insideTry(f, s.lines[0]) && !/\.catch\s*\(/.test(lines.slice(s.lines[0] - 1, s.lines[1] + 1).join('\n'))) push({
      rule: 'llm-no-error-handling', title: `LLM call in ${s.fn} has no error handling`, severity: 'medium', confidence: 'medium', category: 'Reliability',
      file: s.file, lines: [s.lines[0], s.lines[0] + head.length - 1], evidence: head,
      why: 'Rate limits, timeouts and provider outages surface as exceptions here. Unless a caller handles them, the whole request fails.',
    });
  }

  // Floating promises (TS/JS): calls to async functions whose result is dropped
  const asyncNames = new Map<string, boolean>();
  for (const [, fns] of ctx.structure.functions) for (const fn of fns) asyncNames.set(fn.name, (asyncNames.get(fn.name) ?? true) && fn.async);
  for (const f of ctx.files) {
    if (f.isTest || f.language === 'Python') continue;
    linesOf(f).forEach((l, i) => {
      const m = /^\s*(?:this\.)?((?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*))\s*\(/.exec(l);
      if (!m || asyncNames.get(m[2]) !== true) return;
      if (/^\s*(await|return|void|yield|const|let|var|async|function|export)\b/.test(l) || /\.(then|catch|finally)\(/.test(l)) return;
      const prev = linesOf(f)[i - 1]?.trim() ?? '';
      if (/[=(,?:]$|\bawait$|=>$/.test(prev)) return;
      if (/^\s*(async\s+)?\w+\s*\([^)]*\)\s*(:\s*[^{]+)?\{\s*$/.test(l)) return; // method declaration
      push({
        rule: 'floating-promise', title: `${m[2]}() is called without await`, severity: 'medium', confidence: 'medium', category: 'Async',
        file: f.path, lines: [i + 1, i + 1], evidence: [l.trim()],
        why: 'If it fails, the error is lost. The surrounding code also carries on before the work is done.',
        fix: { del: [l.trim()], add: ['await ' + l.trim()] },
      });
    });
  }

  // High-centrality modules that no test references
  const tests = ctx.files.filter(f => f.isTest);
  const inDeg = new Map<string, number>();
  for (const e of ctx.edges) inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  for (const n of ctx.nodes) {
    const d = inDeg.get(n.id) ?? 0;
    if (d < 3 || n.layer === 'config') continue;
    const base = n.name.replace(/\.[^.]+$/, '');
    const fnNames = n.functions.filter(f => f.exported).map(f => f.name);
    const referenced = tests.some(t => t.text.includes(base) || fnNames.some(x => x.length > 3 && t.text.includes(x)));
    if (referenced) continue;
    const f = byPath.get(n.id)!;
    const anchor = n.functions.find(x => x.exported) ?? n.functions[0];
    const ln = anchor?.lines[0] ?? 1;
    push({
      rule: 'untested-central', title: `${n.name} is used by ${d} files and no test covers it`, severity: d >= 6 ? 'high' : 'medium', confidence: 'medium', category: 'Test gap',
      file: n.id, lines: [ln, ln], evidence: [linesOf(f)[ln - 1].trim()],
      why: `A change here affects ${d} other files at once, and nothing would catch a regression.`,
      note: 'Add tests for the main paths and the failure cases of the exported functions.',
    });
  }
  return out;
}

function insideTry(f: SourceFile, line: number): boolean {
  const lines = linesOf(f);
  if (f.language === 'Python') {
    let min = indentOf(lines[line - 1]);
    for (let i = line - 2; i >= 0; i--) {
      const l = lines[i];
      if (!l.trim()) continue;
      const ind = indentOf(l);
      if (ind < min) {
        if (/^\s*try\s*:/.test(l)) return true;
        if (/^\s*(async\s+)?def\b/.test(l)) return false;
        min = ind;
      }
    }
    return false;
  }
  const at = lines.slice(0, line - 1).join('\n').length;
  for (const m of f.text.slice(0, at).matchAll(/\btry\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchBracket(f.text, open);
    if (close > at) return true;
  }
  return false;
}

/** Drops any finding whose file or lines do not exist, or whose evidence is not at those lines. */
export function verifyFindings(findings: Finding[], files: Map<string, string>): { kept: Finding[]; dropped: number } {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const kept: Finding[] = [];
  let dropped = 0;
  for (const f of findings) {
    const text = files.get(f.file);
    if (text == null) { dropped++; continue; }
    const lines = text.split('\n');
    if (f.lines[0] < 1 || f.lines[1] > lines.length || f.lines[0] > f.lines[1]) { dropped++; continue; }
    if (f.rule !== 'hardcoded-secret' && f.evidence.length) {
      const actual = norm(lines.slice(f.lines[0] - 1, f.lines[1]).join(' '));
      if (!f.evidence.every(e => actual.includes(norm(e)))) { dropped++; continue; }
    }
    kept.push(f);
  }
  return { kept, dropped };
}
