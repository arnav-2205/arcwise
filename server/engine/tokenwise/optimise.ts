// System prompt optimiser. Produces a shorter rewrite and checks that every instruction survives.
import { z } from 'zod';
import { completeJson, type Llm, type LlmUsage } from '../llm';
import { contentWords, estimateTokens, repeats } from '../text';

export interface OptimiseResult {
  original: string;
  rewrite: string;
  before: number;
  after: number;
  method: 'llm' | 'rules';
  checklist: { instruction: string; kept: boolean; where: string | null }[];
}

const INSTRUCTION = /\b(must|never|always|do not|don't|should|only|format|return|respond|reply|output|json|avoid|ensure|include|exclude|limit|under \d+|at most|at least)\b/i;
const IMPERATIVE = /^(-\s*)?(when|if|confirm|explain|link|tell|escalate|use|write|keep|reply|answer|classify|rate|summari[sz]e|ask|say|sign|acknowledge|offer|restate|close|thank|avoid|list|include)\b/i;

const FILLER: [RegExp, string][] = [
  [/\bIt is (very |extremely )?important that you\s+/gi, ''],
  [/\bPlease make sure (that you |to )?/gi, ''],
  [/\bYou must always\b/gi, 'Always'],
  [/\bin order to\b/gi, 'to'],
  [/\bat all times\b/gi, ''],
  [/\bunder any circumstances\b/gi, ''],
  [/\bhelpful, friendly, and professional\b/gi, 'helpful'],
  [/[ \t]{2,}/g, ' '],
  [/\n{3,}/g, '\n\n'],
];

export function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
}

export function instructionsOf(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sentencesOf(text)) {
    if (s.length < 8 || !(INSTRUCTION.test(s) || IMPERATIVE.test(s))) continue;
    // Same rule = same content words after filler is removed
    const key = [...contentWords(stripFiller(s))].sort().join(' ');
    if (!key || seen.has(key)) continue;
    seen.add(key); out.push(s);
  }
  return out;
}

function stripFiller(s: string): string {
  let r = s;
  for (const [re, to] of FILLER) r = r.replace(re, to);
  return r;
}


/**
 * An instruction counts as kept only if one rewrite sentence carries at least 80% of its content words.
 * Sentences that differ only in a topic word (refunds vs invoices) are therefore not treated as the same rule.
 */
export function checklist(original: string, rewrite: string) {
  const rs = sentencesOf(rewrite);
  const rsWords = rs.map(contentWords);
  const allWords = contentWords(rewrite);
  return instructionsOf(original).map(instruction => {
    const need = contentWords(stripFiller(instruction));
    let best = -1, cover = 0;
    rsWords.forEach((w, i) => {
      if (!need.size) return;
      let hit = 0;
      for (const x of need) if (w.has(x)) hit++;
      const c = hit / need.size;
      if (c > cover) { cover = c; best = i; }
    });
    // Mostly in one sentence, and any word missing there (often the topic) still appears in the rewrite
    const missing = best >= 0 ? [...need].filter(x => !rsWords[best].has(x)) : [...need];
    const kept = need.size === 0 || (cover >= 0.75 && missing.every(x => allWords.has(x)));
    return { instruction, kept, where: best >= 0 && cover >= 0.5 ? rs[best] : null };
  });
}

/** Deterministic rewrite: removes repeated sentences and filler, keeps everything else in order. */
export function ruleRewrite(text: string): string {
  const keptSh: Set<string>[] = [];
  const blocks = text.split(/\n/);
  const out: string[] = [];
  for (const line of blocks) {
    const sents = line.split(/(?<=[.!?])\s+/);
    const keep: string[] = [];
    for (const s of sents) {
      const t = s.trim();
      if (!t) continue;
      // Drop a sentence only when another one already says all of it; a different topic word keeps it
      const cw = contentWords(stripFiller(t));
      if (t.length > 20 && keptSh.some(k => repeats(k, cw) && k.size >= cw.size)) continue;
      if (t.length > 20) keptSh.push(cw);
      keep.push(t);
    }
    if (keep.length || !line.trim()) out.push(keep.join(' '));
  }
  let r = out.join('\n');
  for (const [re, to] of FILLER) r = r.replace(re, to);
  return r.trim();
}

const LlmRewrite = z.object({ rewrite: z.string().min(1) });

export async function optimisePrompt(text: string, llm: Llm, usage: LlmUsage): Promise<OptimiseResult> {
  let rewrite = ruleRewrite(text);
  let method: OptimiseResult['method'] = 'rules';
  if (llm.available) {
    const r = await completeJson(llm, {
      tier: 'deep', maxTokens: Math.min(16000, estimateTokens(text) + 500),
      system: 'You shorten system prompts for production LLM calls. Keep every instruction, constraint, output format, example category and safety rule. Remove repetition, filler and redundant examples. Do not add new rules. Reply with JSON: {"rewrite": "..."}',
      user: `<repository>\n${text}\n</repository>`,
    }, LlmRewrite, usage);
    if (r && estimateTokens(r.rewrite) < estimateTokens(rewrite)) { rewrite = r.rewrite; method = 'llm'; }
  }
  const cl = checklist(text, rewrite);
  // Never return a rewrite that drops an instruction the deterministic pass would keep
  if (method === 'llm' && cl.some(c => !c.kept)) {
    const fallback = ruleRewrite(text);
    const fcl = checklist(text, fallback);
    if (fcl.filter(c => !c.kept).length < cl.filter(c => !c.kept).length) return { original: text, rewrite: fallback, before: estimateTokens(text), after: estimateTokens(fallback), method: 'rules', checklist: fcl };
  }
  return { original: text, rewrite, before: estimateTokens(text), after: estimateTokens(rewrite), method, checklist: cl };
}
