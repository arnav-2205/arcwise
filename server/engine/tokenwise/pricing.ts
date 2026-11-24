import table from './pricing.json' with { type: 'json' };

export interface ModelPrice {
  provider: string;
  input: number;
  output: number;
  cachedInput: number;
  batchInput: number;
  batchOutput: number;
  cheaper?: string;
  source: string;
  checked: string;
}

export const PRICES = table.models as Record<string, ModelPrice>;

/** Normalises a model id and finds its price entry: exact, then without date suffix, then longest prefix. */
export function priceFor(model: string): { id: string; price: ModelPrice } | null {
  if (!model || model === 'dynamic') return null;
  // OpenRouter-style ids ("openai/gpt-4o", "anthropic/claude-3.5-sonnet:free") map to the base model.
  const m = model.toLowerCase().replace(/^models\//, '').replace(/^[a-z0-9-]+\//, '').replace(/:[a-z-]+$/, '').replace(/-latest$/, '').replace(/^(claude-\d)\.(\d)/, '$1-$2');
  if (PRICES[m]) return { id: m, price: PRICES[m] };
  const noDate = m.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  if (PRICES[noDate]) return { id: noDate, price: PRICES[noDate] };
  let best: string | null = null;
  for (const id of Object.keys(PRICES)) if (m.startsWith(id) && (!best || id.length > best.length)) best = id;
  return best ? { id: best, price: PRICES[best] } : null;
}

/** USD cost of one call. Cached tokens are billed at the cached-input price. */
export function costPerCall(model: string, inputTokens: number, outputTokens: number, cachedTokens = 0): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const fresh = Math.max(0, inputTokens - cachedTokens);
  return (fresh * p.price.input + cachedTokens * p.price.cachedInput + outputTokens * p.price.output) / 1e6;
}

export function monthlyCost(model: string, calls: number, inputTokens: number, outputTokens: number): number {
  return (costPerCall(model, inputTokens, outputTokens) ?? 0) * calls;
}

/** The oldest "checked" date across the table, shown in the UI as the pricing as-of date. */
export function pricingAsOf(): string {
  return Object.values(PRICES).map(p => p.checked).sort()[0];
}

export function stalePrices(today = new Date(), maxAgeDays = 30): string[] {
  return Object.entries(PRICES)
    .filter(([, p]) => (today.getTime() - new Date(p.checked).getTime()) / 86_400_000 > maxAgeDays)
    .map(([id, p]) => `${id} (checked ${p.checked}, ${p.source})`);
}
