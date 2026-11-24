// Scoring functions. Each returns a per-sample difference (candidate minus baseline) on a 100-point scale.

export type TaskType = 'classification' | 'structured' | 'extraction' | 'free-text';

export interface Assertion { type: 'contains' | 'regex' | 'json-path-equals' | 'max-length'; value: string; path?: string }

export const normLabel = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s_-]/g, '').trim().replace(/\s+/g, ' ');

export function detectTaskType(baselineOutputs: string[]): TaskType {
  const json = baselineOutputs.filter(o => { try { const v = JSON.parse(o.trim()); return typeof v === 'object' && v !== null; } catch { return false; } }).length;
  if (json >= baselineOutputs.length * 0.8) return 'structured';
  const short = baselineOutputs.filter(o => o.trim().split(/\s+/).length <= 4).length;
  if (short >= baselineOutputs.length * 0.8) return 'classification';
  return 'free-text';
}

/** Classification: agreement with labels if given, otherwise with the baseline output. */
export function classificationDiff(base: string, cand: string, label?: string): number {
  if (label != null) return (normLabel(cand) === normLabel(label) ? 100 : 0) - (normLabel(base) === normLabel(label) ? 100 : 0);
  return normLabel(cand) === normLabel(base) ? 0 : -100;
}

function flatten(v: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  else out[prefix] = JSON.stringify(v);
  return out;
}

/** Structured output: schema validity (parses, same keys) and exact match per field, relative to the baseline. */
export function structuredDiff(base: string, cand: string): number {
  let b: unknown, c: unknown;
  try { b = JSON.parse(base.trim()); } catch { return 0; } // baseline itself invalid: no signal
  try { c = JSON.parse(cand.trim()); } catch { return -100; }
  const fb = flatten(b), fc = flatten(c);
  const keys = Object.keys(fb);
  if (!keys.length) return 0;
  const match = keys.filter(k => fc[k] === fb[k]).length;
  return (match / keys.length) * 100 - 100;
}

/** Extraction: token-set F1 of the candidate against the baseline (or a label). */
export function f1(a: string, b: string): number {
  const ta = normLabel(a).split(' ').filter(Boolean), tb = normLabel(b).split(' ').filter(Boolean);
  if (!ta.length && !tb.length) return 1;
  const sb = new Map<string, number>();
  for (const t of tb) sb.set(t, (sb.get(t) ?? 0) + 1);
  let inter = 0;
  for (const t of ta) { const n = sb.get(t) ?? 0; if (n) { inter++; sb.set(t, n - 1); } }
  if (!inter) return 0;
  const p = inter / ta.length, r = inter / tb.length;
  return (2 * p * r) / (p + r);
}
export function extractionDiff(base: string, cand: string, label?: string): number {
  if (label != null) return (f1(cand, label) - f1(base, label)) * 100;
  return (f1(cand, base) - 1) * 100;
}

function jsonPath(v: unknown, path: string): unknown {
  return path.replace(/^\$\.?/, '').split('.').filter(Boolean).reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined), v);
}
export function assertionScore(out: string, assertions: Assertion[]): number {
  if (!assertions.length) return 100;
  const pass = assertions.filter(a => {
    if (a.type === 'contains') return out.includes(a.value);
    if (a.type === 'regex') { try { return new RegExp(a.value).test(out); } catch { return false; } }
    if (a.type === 'max-length') return out.length <= Number(a.value);
    try { return JSON.stringify(jsonPath(JSON.parse(out), a.path ?? '')) === JSON.stringify(JSON.parse(a.value)); } catch { return false; }
  }).length;
  return (pass / assertions.length) * 100;
}

/**
 * Pairwise judge result for one sample, from two runs with positions swapped.
 * Each verdict is which output is better: 'A', 'B' or 'tie'. Candidate is B in run 1 and A in run 2.
 * Returns +100 (candidate better), -100 (worse) or 0, averaged across the two runs, and whether they agreed.
 */
export function judgeDiff(run1: 'A' | 'B' | 'tie', run2: 'A' | 'B' | 'tie'): { diff: number; consistent: boolean } {
  const v1 = run1 === 'B' ? 100 : run1 === 'A' ? -100 : 0;
  const v2 = run2 === 'A' ? 100 : run2 === 'B' ? -100 : 0;
  return { diff: (v1 + v2) / 2, consistent: v1 === v2 };
}
