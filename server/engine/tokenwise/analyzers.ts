// Cost analyzers. Each produces recommendations that start as Unvalidated.
import type { CallSite, Recommendation } from '../../../lib/types';
import { contentWords, estimateTokens, jaccard, repeats, shingles } from '../text';
import { monthlyCost, priceFor } from './pricing';

export interface SiteWithArgs extends CallSite { argsText?: string }

export function siteCost(s: CallSite): number {
  return monthlyCost(s.model, s.callsPerMonth, s.inputTokens, s.outputTokens);
}

/** Pairs of call sites that send the same or a near-identical prompt. */
export function redundantPairs(sites: SiteWithArgs[]): [string, string, number][] {
  const out: [string, string, number][] = [];
  for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++) {
    const a = sites[i], b = sites[j];
    if (/embed/i.test(a.api) || /embed/i.test(b.api)) continue;
    if (!a.systemPrompt || !b.systemPrompt) continue;
    // Word-pair overlap of the system prompts, plus whether both send the same user content
    const sim = jaccard(shingles(a.systemPrompt.text, 2), shingles(b.systemPrompt.text, 2));
    const userOf = (s: SiteWithArgs) => /role["']?\s*[:=]\s*["']user["']\s*,\s*["']?content["']?\s*[:=]\s*([^,}\n]+)/.exec(s.argsText ?? '')?.[1].trim();
    const sameInput = !!userOf(a) && userOf(a) === userOf(b) && a.model === b.model;
    if (sim >= 0.5 || (sim >= 0.3 && sameInput)) out.push([a.id, b.id, sim]);
  }
  return out;
}

export function duplicateInstructionTokens(text: string): { tokens: number; examples: string[] } {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 20);
  const kept: { s: string; sh: Set<string> }[] = [];
  let tokens = 0;
  const examples: string[] = [];
  for (const s of sentences) {
    const sh = contentWords(s);
    const dup = kept.find(k => k.s.toLowerCase() === s.toLowerCase() || (repeats(k.sh, sh) && k.sh.size >= sh.size));
    if (dup) { tokens += estimateTokens(s); if (examples.length < 3) examples.push(s); }
    else kept.push({ s, sh });
  }
  return { tokens, examples };
}

const CLASSIFY_HINT = /\b(classif\w*|categor\w*|label\w*|sentiment|intent|routing|yes or no|true or false|one word|single word|respond with only|reply with only)\b/i;

function lineWith(fileText: string | undefined, lines: [number, number], re: RegExp): string | null {
  if (!fileText) return null;
  const ls = fileText.split('\n').slice(lines[0] - 1, lines[1]);
  return ls.find(l => re.test(l)) ?? null;
}

export function computeFlags(sites: SiteWithArgs[], pairs: [string, string, number][]): void {
  for (const s of sites) {
    const f: string[] = [];
    if (s.inLoop) f.push('In a loop');
    if (s.systemPrompt?.static && s.systemPrompt.tokens >= 1024) f.push('Large static prompt');
    for (const [a, b] of pairs) if (a === s.id || b === s.id) f.push(`Redundant with ${(a === s.id ? b : a).split('#')[1]}`);
    if (s.maxTokens == null && !/embed/i.test(s.api)) f.push('No max-tokens cap');
    if (!s.hasTimeout) f.push('No timeout set');
    if (!s.hasRetry) f.push('No retry');
    if (s.modelResolved === 'dynamic') f.push('Model not resolved');
    else if (!priceFor(s.model)) f.push('Price unknown');
    s.flags = f;
    s.monthlyCostUsd = priceFor(s.model) ? siteCost(s) : null;
  }
}

export function recommend(sites: SiteWithArgs[], pairs: [string, string, number][], fileText: (p: string) => string | undefined): Recommendation[] {
  const recs: Recommendation[] = [];
  let n = 0;
  const id = () => `R${++n}`;
  for (const s of sites) {
    const cost = siteCost(s);
    const price = priceFor(s.model);
    const text = fileText(s.file);
    const modelLine = lineWith(text, s.lines, /\bmodel/) ?? `model: "${s.model}"`;
    const classifyLike = CLASSIFY_HINT.test(s.systemPrompt?.text ?? '') || CLASSIFY_HINT.test(s.argsText ?? '');

    // Model fit
    if (price?.price.cheaper && (classifyLike || s.outputTokens <= 50)) {
      const alt = price.price.cheaper;
      const saving = cost - monthlyCost(alt, s.callsPerMonth, s.inputTokens, s.outputTokens);
      if (saving > 0) recs.push({
        id: id(), siteId: s.id, kind: 'model-fit', title: `Try ${alt} for ${s.fn}`,
        detail: `${s.fn} returns short, label-like answers (about ${s.outputTokens} tokens). A smaller model often matches on this kind of task. The quality gate decides.`,
        saving: { low: saving * 0.9, high: saving }, qualityRisk: 'medium', status: 'unvalidated',
        change: { del: [modelLine], add: [modelLine.replace(s.model, alt).replace(/\b(MODEL|model)\b(?=\s*[,)])/, `"${alt}"`)] },
        candidate: { model: alt }, replayable: true,
      });
    }

    // Prompt caching (explicit caching providers; OpenAI caches long prefixes automatically)
    if (s.systemPrompt?.static && s.systemPrompt.tokens >= 1024 && price && /Anthropic|Google/.test(s.provider) && !/cache_control|cachedContent/.test(s.argsText ?? '')) {
      const per = s.systemPrompt.tokens * (price.price.input - price.price.cachedInput) / 1e6;
      recs.push({
        id: id(), siteId: s.id, kind: 'prompt-caching', title: `Cache the ${s.systemPrompt.tokens.toLocaleString()}-token system prompt`,
        detail: 'The same system prompt is sent on every call. Marking it as cacheable bills repeat reads at the cached-input price. The range assumes 70% to 95% of calls hit the cache, and ignores the small premium on cache writes.',
        saving: { low: per * s.callsPerMonth * 0.7, high: per * s.callsPerMonth * 0.95 }, qualityRisk: 'low', status: 'unvalidated',
        change: { del: ['    system,'], add: ['    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],'] },
        candidate: { model: s.model }, replayable: false,
      });
    }

    // Output caps
    if (s.maxTokens == null && !/embed/i.test(s.api)) {
      const cap = Math.max(64, Math.ceil(s.outputTokens * 2 / 50) * 50);
      recs.push({
        id: id(), siteId: s.id, kind: 'output-cap', title: `Set an output limit on ${s.fn}`,
        detail: 'Without a limit, an unusual input can produce a very long and expensive answer. No saving is claimed; this caps the worst case.',
        saving: null, qualityRisk: 'low', status: 'unvalidated',
        change: { del: [], add: [s.file.endsWith('.py') ? `    max_tokens=${cap},` : `    max_tokens: ${cap},`] }, replayable: false,
      });
    }

    // Batching
    if (s.inLoop && !s.streaming && price && /OpenAI|Anthropic|Google/.test(s.provider)) {
      const batchCost = monthlyCost(s.model, s.callsPerMonth, 0, 0) + s.callsPerMonth * (s.inputTokens * price.price.batchInput + s.outputTokens * price.price.batchOutput) / 1e6;
      const saving = cost - batchCost;
      if (saving > 0) recs.push({
        id: id(), siteId: s.id, kind: 'batching', title: `Send ${s.fn} calls through the batch API`,
        detail: 'This call runs inside a loop. If the results are not needed right away, the provider batch API costs about half. Check that nobody waits on these results.',
        saving: { low: saving * 0.5, high: saving }, qualityRisk: 'low', status: 'unvalidated',
        change: { del: [`for (const item of items) await ${s.fn}(item);`], add: [`await submitBatch(items.map(to${s.fn[0].toUpperCase() + s.fn.slice(1)}Request));`] }, replayable: false,
      });
    }

    // Prompt bloat
    if (s.systemPrompt && s.systemPrompt.tokens >= 300) {
      const dup = duplicateInstructionTokens(s.systemPrompt.text);
      if (dup.tokens >= s.systemPrompt.tokens * 0.05 && price) {
        const saving = s.callsPerMonth * dup.tokens * price.price.input / 1e6;
        recs.push({
          id: id(), siteId: s.id, kind: 'prompt-bloat', title: `Remove repeated instructions from the ${s.fn} prompt`,
          detail: `About ${dup.tokens.toLocaleString()} of ${s.systemPrompt.tokens.toLocaleString()} prompt tokens repeat earlier instructions. Use Optimise to produce a shorter rewrite that keeps every rule.`,
          saving: { low: saving * 0.5, high: saving }, qualityRisk: 'medium', status: 'unvalidated',
          change: { del: dup.examples.map(e => e.slice(0, 120)), add: [] }, replayable: false,
        });
      }
    }

    // Context trimming
    if (/\.\.\.\s*(history|messages|thread|conversation)|\b(messages|contents?)\s*[:=]\s*(history|thread|conversation|all_?[mM]essages|transcript)\b|JSON\.stringify\(\s*(thread|history|doc)/.test(s.argsText ?? '')) {
      recs.push({
        id: id(), siteId: s.id, kind: 'context-trimming', title: `Send only the relevant part of the history to ${s.fn}`,
        detail: 'The whole conversation or document is sent on each call. A recent window or a summary is often enough. No saving is estimated without usage data.',
        saving: null, qualityRisk: 'high', status: 'unvalidated', change: { del: ['messages: allMessages,'], add: ['messages: allMessages.slice(-10),'] }, replayable: false,
      });
    }
  }

  // Redundant calls: remove the cheaper of each pair by folding it into the other
  for (const [a, b, sim] of pairs) {
    const A = sites.find(s => s.id === a)!, B = sites.find(s => s.id === b)!;
    const [keep, drop] = siteCost(A) >= siteCost(B) ? [A, B] : [B, A];
    const c = siteCost(drop);
    recs.push({
      id: id(), siteId: drop.id, kind: 'redundant', title: `Fold ${drop.fn} into ${keep.fn}`,
      detail: `${drop.fn} and ${keep.fn} send system prompts that are ${Math.round(sim * 100)}% the same. One call can return both answers.`,
      saving: { low: c * 0.5, high: c }, qualityRisk: 'medium', status: 'unvalidated',
      change: { del: [`const r2 = await ${drop.fn}(input);`], add: [`const { ...r1, ...r2 } = await ${keep.fn}(input); // one call, both fields`] }, replayable: false,
    });
  }
  return recs;
}
