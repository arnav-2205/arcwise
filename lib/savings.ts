import type { CallSite, LedgerEntry, Recommendation } from './types';

/** Mid-point of a saving range. */
export const mid = (s: { low: number; high: number }) => (s.low + s.high) / 2;

/**
 * Headline savings without double counting: for each call site take only the best
 * recommendation (by mid saving). Proven money comes only from ledger entries.
 */
export function headlineSavings(recs: Recommendation[], ledger: LedgerEntry[]) {
  const proven = ledger.reduce((a, e) => a + e.monthlySaving, 0);
  const provenSites = new Set(ledger.map(e => e.siteId));
  const best = new Map<string, number>();
  for (const r of recs) {
    if (!r.saving || r.status === 'atrisk' || r.status === 'proven' || provenSites.has(r.siteId)) continue;
    best.set(r.siteId, Math.max(best.get(r.siteId) ?? 0, mid(r.saving)));
  }
  return { proven, unvalidated: [...best.values()].reduce((a, b) => a + b, 0) };
}

export function siteQuality(site: CallSite, recs: Recommendation[]): CallSite['quality'] {
  const mine = recs.filter(r => r.siteId === site.id);
  if (mine.some(r => r.status === 'atrisk')) return 'atrisk';
  if (mine.some(r => r.status === 'proven')) return 'proven';
  if (mine.some(r => r.status === 'testing')) return 'testing';
  return 'unvalidated';
}
