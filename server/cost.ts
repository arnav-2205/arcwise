// Re-runs the cost analyzers after volumes, usage or prompts change, keeping validation state.
import type { Analysis, Recommendation } from '../lib/types';
import { siteQuality } from '../lib/savings';
import { computeFlags, recommend, redundantPairs } from './engine/tokenwise/analyzers';

export function recomputeCost(a: Analysis, fileText: (p: string) => string | undefined = () => undefined) {
  const old = new Map(a.recommendations.map(r => [`${r.siteId}|${r.kind}`, r]));
  const pairs = redundantPairs(a.callSites);
  computeFlags(a.callSites, pairs);
  const fresh = recommend(a.callSites, pairs, fileText);
  const merged: Recommendation[] = fresh.map(r => {
    const prev = old.get(`${r.siteId}|${r.kind}`);
    if (!prev) return r;
    return {
      ...r, id: prev.id, status: prev.status, validationId: prev.validationId,
      candidate: prev.candidate?.systemPrompt ? { ...r.candidate, ...prev.candidate } : r.candidate ?? prev.candidate,
      replayable: prev.replayable || r.replayable,
      change: prev.change, // the diff was built from the source, which is deleted after the analysis
      saving: prev.kind === 'prompt-bloat' && prev.candidate?.systemPrompt ? prev.saving : r.saving,
    };
  });
  // Keep recommendations that only exist because the user ran the optimiser
  for (const r of a.recommendations) if (!merged.some(m => m.id === r.id) && r.candidate?.systemPrompt) merged.push(r);
  // Ids must stay unique
  const used = new Set<string>();
  let n = Math.max(0, ...merged.map(r => Number(r.id.slice(1)) || 0));
  for (const r of merged) { if (used.has(r.id)) r.id = `R${++n}`; used.add(r.id); }
  a.recommendations = merged;
  for (const s of a.callSites) s.quality = siteQuality(s, a.recommendations);
}
