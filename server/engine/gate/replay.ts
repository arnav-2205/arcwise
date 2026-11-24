// Shadow replay: runs the current and the cheaper version on the same inputs with the customer's own key.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CallSite, Recommendation, ValidationReport } from '../../../lib/types';
import { completeJson, type Llm, type LlmUsage } from '../llm';
import { costPerCall } from '../tokenwise/pricing';
import { assertionScore, classificationDiff, detectTaskType, extractionDiff, judgeDiff, structuredDiff, type Assertion, type TaskType } from './scoring';
import { bootstrapMeanCI, gateDecision } from './stats';

export interface ReplayInput { input: string; label?: string }
export interface CallResult { text: string; inputTokens: number; outputTokens: number }
export type ModelCaller = (req: { model: string; system: string | null; input: string; maxTokens: number }) => Promise<CallResult>;

export const MIN_INPUTS = 50;
export const TARGET_INPUTS = 200;

export function replayProvider(site: CallSite): 'openai' | 'anthropic' | null {
  if (/^OpenAI/.test(site.provider) && !/embed/i.test(site.api)) return 'openai';
  if (/^Anthropic/.test(site.provider)) return 'anthropic';
  return null;
}

/** Calls the provider's HTTP API directly with the customer's key. */
export function httpCaller(provider: 'openai' | 'anthropic', apiKey: string, fetchImpl: typeof fetch = fetch): ModelCaller {
  return async ({ model, system, input, maxTokens }) => {
    for (let attempt = 0; ; attempt++) {
      try {
        if (provider === 'openai') {
          const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
            method: 'POST', signal: AbortSignal.timeout(60_000),
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model, max_tokens: maxTokens, messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: input }] }),
          });
          if (!res.ok) throw new Error(`OpenAI answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
          const j = await res.json() as { choices: { message: { content: string } }[]; usage: { prompt_tokens: number; completion_tokens: number } };
          return { text: j.choices[0]?.message?.content ?? '', inputTokens: j.usage.prompt_tokens, outputTokens: j.usage.completion_tokens };
        }
        const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
          method: 'POST', signal: AbortSignal.timeout(60_000),
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model, max_tokens: maxTokens, ...(system ? { system } : {}), messages: [{ role: 'user', content: input }] }),
        });
        if (!res.ok) throw new Error(`Anthropic answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const j = await res.json() as { content: { type: string; text?: string }[]; usage: { input_tokens: number; output_tokens: number } };
        return { text: j.content.map(c => c.text ?? '').join(''), inputTokens: j.usage.input_tokens, outputTokens: j.usage.output_tokens };
      } catch (e) {
        if (attempt >= 2 || /\b(400|401|403|404)\b/.test(String(e))) throw e;
        await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  };
}

export function candidateOf(site: CallSite, rec: Recommendation) {
  return {
    model: rec.candidate?.model ?? site.model,
    system: rec.candidate?.systemPrompt ?? site.systemPrompt?.text ?? null,
  };
}

/** Estimated provider cost of a replay (both versions), shown before the user confirms. */
export function estimateReplayCost(site: CallSite, rec: Recommendation, n: number): number {
  const cand = candidateOf(site, rec);
  const candIn = site.inputTokens - (site.systemPrompt?.tokens ?? 0) + Math.ceil((cand.system ?? '').length / 4);
  return n * ((costPerCall(site.model, site.inputTokens, site.outputTokens) ?? 0) + (costPerCall(cand.model, candIn, site.outputTokens) ?? 0));
}

async function pool<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<(R | Error)[]> {
  const out: (R | Error)[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; try { out[i] = await fn(items[i], i); } catch (e) { out[i] = e as Error; } }
  }));
  return out;
}

const Verdict = z.object({ better: z.enum(['A', 'B', 'tie']) });

export async function runReplay(opts: {
  site: CallSite; rec: Recommendation; inputs: ReplayInput[]; inputsSource: 'uploaded' | 'synthetic';
  caller: ModelCaller; delta: number; assertions?: Assertion[]; taskType?: TaskType; judge?: Llm; judgeUsage?: LlmUsage;
  onProgress?: (done: number, total: number) => void;
}): Promise<ValidationReport> {
  const { site, rec, inputs, caller } = opts;
  if (inputs.length < MIN_INPUTS) throw new Error(`At least ${MIN_INPUTS} test inputs are needed; ${inputs.length} were given.`);
  const cand = candidateOf(site, rec);
  const maxTokens = site.maxTokens ?? Math.max(64, site.outputTokens * 3);
  let done = 0;
  const pairs = await pool(inputs, 4, async inp => {
    const [b, c] = await Promise.all([
      caller({ model: site.model, system: site.systemPrompt?.text ?? null, input: inp.input, maxTokens }),
      caller({ model: cand.model, system: cand.system, input: inp.input, maxTokens }),
    ]);
    opts.onProgress?.(++done, inputs.length);
    return { inp, b, c };
  });
  const ok = pairs.filter((p): p is { inp: ReplayInput; b: CallResult; c: CallResult } => !(p instanceof Error));
  const errors = pairs.length - ok.length;
  if (ok.length < MIN_INPUTS) {
    const first = pairs.find(p => p instanceof Error) as Error | undefined;
    throw new Error(`Only ${ok.length} of ${inputs.length} replays succeeded. ${first?.message ?? ''}`);
  }
  const task = opts.taskType ?? detectTaskType(ok.map(p => p.b.text));
  let diffs: number[];
  let scoring: string;
  let consistency: number | null = null;
  if (opts.assertions?.length) {
    diffs = ok.map(p => assertionScore(p.c.text, opts.assertions!) - assertionScore(p.b.text, opts.assertions!));
    scoring = `User assertions (${opts.assertions.length})`;
  } else if (task === 'classification') {
    diffs = ok.map(p => classificationDiff(p.b.text, p.c.text, p.inp.label));
    scoring = ok.some(p => p.inp.label != null) ? 'Classification accuracy against your labels' : 'Classification agreement with the current version';
  } else if (task === 'structured') {
    diffs = ok.map(p => structuredDiff(p.b.text, p.c.text));
    scoring = 'Structured output: valid JSON and exact match per field';
  } else if (task === 'extraction') {
    diffs = ok.map(p => extractionDiff(p.b.text, p.c.text, p.inp.label));
    scoring = 'Extraction F1';
  } else if (opts.judge?.available) {
    const usage = opts.judgeUsage ?? { inputTokens: 0, outputTokens: 0 };
    const ask = (input: string, a: string, b: string) => completeJson(opts.judge!, {
      tier: 'deep', maxTokens: 50,
      system: 'You compare two answers to the same request. Judge correctness, completeness and following the instructions. Length alone is not quality. Reply with JSON {"better":"A"|"B"|"tie"}.',
      user: `<repository>\nRequest:\n${input}\n\nAnswer A:\n${a}\n\nAnswer B:\n${b}\n</repository>`,
    }, Verdict, usage);
    const verdicts = await pool(ok, 4, async p => {
      const r1 = await ask(p.inp.input, p.b.text, p.c.text);
      const r2 = await ask(p.inp.input, p.c.text, p.b.text);
      return judgeDiff(r1?.better ?? 'tie', r2?.better ?? 'tie');
    });
    const vs = verdicts.filter((v): v is { diff: number; consistent: boolean } => !(v instanceof Error));
    diffs = vs.map(v => v.diff);
    consistency = vs.filter(v => v.consistent).length / vs.length;
    scoring = `Pairwise judge, run twice with positions swapped (consistency ${(consistency * 100).toFixed(0)}%)`;
  } else {
    diffs = ok.map(p => extractionDiff(p.b.text, p.c.text));
    scoring = 'Word overlap with the current version (no judge model configured)';
  }
  const { mean, ci } = bootstrapMeanCI(diffs);
  const passed = gateDecision(ci, opts.delta);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const baseCost = costPerCall(site.model, avg(ok.map(p => p.b.inputTokens)), avg(ok.map(p => p.b.outputTokens))) ?? 0;
  const candCost = costPerCall(cand.model, avg(ok.map(p => p.c.inputTokens)), avg(ok.map(p => p.c.outputTokens))) ?? 0;
  const order = diffs.map((d, i) => [d, i] as const).sort((a, b) => a[0] - b[0]);
  const examples = (passed ? order.slice(0, 3).concat(order.slice(-2)) : order.slice(0, 5)).map(([d, i]) => ({
    input: ok[i].inp.input.slice(0, 400), baseline: ok[i].b.text.slice(0, 400), candidate: ok[i].c.text.slice(0, 400), score: d,
  }));
  return {
    id: randomUUID(), recId: rec.id, siteId: site.id, createdAt: new Date().toISOString(), inputsSource: opts.inputsSource,
    n: ok.length, scoring, baseline: { model: site.model, costPerCall: baseCost }, candidate: { model: cand.model, costPerCall: candCost },
    meanDiff: mean, ci, delta: opts.delta, passed, examples, errors,
    monthlySaving: Math.max(0, (baseCost - candCost) * site.callsPerMonth),
  };
}

const Synthetic = z.object({ inputs: z.array(z.string().min(1)).min(1) });

/** Synthetic test inputs from the prompt and calling code. Always labelled "synthetic" in reports. */
export async function syntheticInputs(llm: Llm, usage: LlmUsage, site: CallSite, n = TARGET_INPUTS): Promise<ReplayInput[]> {
  if (!llm.available) throw new Error('Synthetic inputs need ANTHROPIC_API_KEY and model ids on the server. Upload a JSONL file of real inputs instead.');
  const out: string[] = [];
  for (let round = 0; out.length < n && round < Math.ceil(n / 40) + 2; round++) {
    const r = await completeJson(llm, {
      tier: 'deep', maxTokens: 6000,
      system: 'You write realistic, varied user messages that a production system would receive, including edge cases and messy real-world phrasing. Reply with JSON {"inputs":["..."]}.',
      user: `<repository>\nSystem prompt of the call:\n${(site.systemPrompt?.text ?? '(none found)').slice(0, 12000)}\nFunction: ${site.fn} in ${site.file}\n</repository>\nWrite 40 different user messages this call would receive.`,
    }, Synthetic, usage);
    out.push(...(r?.inputs ?? []));
  }
  return [...new Set(out)].slice(0, n).map(input => ({ input }));
}
