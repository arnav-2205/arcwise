// Small text utilities shared by the parsers, detectors and rules.

/** 1-based line number of a character index. */
export function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Precomputed line starts for repeated lookups. */
export function lineIndex(text: string) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return {
    lineOf(index: number) {
      let lo = 0, hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= index) lo = mid; else hi = mid - 1;
      }
      return lo + 1;
    },
    count: starts.length,
  };
}

/**
 * Index just after the bracket that closes the one at `open`.
 * Skips over string literals, template literals and comments. Returns -1 if unbalanced.
 */
export function matchBracket(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  let i = open;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); if (i < 0) return -1; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      // Python triple quotes
      if ((c === '"' || c === "'") && text.startsWith(c.repeat(3), i)) {
        const end = text.indexOf(c.repeat(3), i + 3);
        if (end < 0) return -1;
        i = end + 3; continue;
      }
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') i++;
        else if (c === '`' && text[i] === '$' && text[i + 1] === '{') { const e = matchBracket(text, i + 1); if (e < 0) return -1; i = e - 1; }
        else if (c !== '`' && text[i] === '\n') break;
        i++;
      }
      i++; continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

/** Shows only the first 4 and last 4 characters of a secret. */
export function maskSecret(s: string): string {
  if (s.length <= 10) return '•'.repeat(s.length);
  return s.slice(0, 4) + '•'.repeat(Math.min(16, s.length - 8)) + s.slice(-4);
}

/**
 * Token estimate. Documented approximation: about 4 characters per token for English
 * prose and code (OpenAI and Anthropic guidance). Always labelled "estimated" in the UI.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Word shingles for near-duplicate detection. */
export function shingles(text: string, k = 3): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + k <= words.length; i++) out.add(words.slice(i, i + k).join(' '));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const STOP = new Set(['the', 'and', 'that', 'this', 'with', 'they', 'them', 'their', 'when', 'what', 'which', 'your', 'from', 'about', 'there', 'then', 'than', 'will', 'into', 'also', 'more', 'only', 'must', 'always', 'never', 'should', 'please', 'make', 'sure', 'very', 'have', 'been', 'each', 'every', 'remember', 'note', 'important']);

/** Meaningful words of a sentence: lower-case, longer than 3 characters, not a stop word. */
export function contentWords(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP.has(w)));
}

/** True when every content word of the shorter sentence appears in the longer one: one repeats the other. */
export function repeats(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || !b.size) return false;
  const [s, l] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of s) if (!l.has(x)) return false;
  return s.size >= 2;
}

/** Share of the smaller set contained in the larger one. 1 means one sentence repeats the other. */
export function containment(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const [s, l] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of s) if (l.has(x)) inter++;
  return inter / s.size;
}

export function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}
