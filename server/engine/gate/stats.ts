// Statistics for the quality gate.

/** Small seeded PRNG so reports are reproducible. */
export function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile bootstrap of the mean of per-sample quality differences (candidate minus baseline),
 * on a 100-point scale. Returns the mean and the 95% interval.
 */
export function bootstrapMeanCI(diffs: number[], iterations = 5000, seed = 42): { mean: number; ci: [number, number] } {
  if (!diffs.length) throw new Error('No samples');
  const rand = mulberry32(seed);
  const n = diffs.length;
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const means = new Float64Array(iterations);
  for (let i = 0; i < iterations; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += diffs[(rand() * n) | 0];
    means[i] = s / n;
  }
  means.sort();
  const q = (p: number) => means[Math.min(iterations - 1, Math.max(0, Math.floor(p * iterations)))];
  return { mean, ci: [q(0.025), q(0.975)] };
}

/** Pass only if the lower bound of the 95% interval is above minus delta. */
export function gateDecision(ci: [number, number], delta: number): boolean {
  return ci[0] > -Math.abs(delta);
}
