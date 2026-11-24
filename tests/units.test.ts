import { describe, expect, it } from 'vitest';
import { headlineSavings } from '../lib/savings';
import type { CallSite, Recommendation } from '../lib/types';
import { canStoreSecrets, seal, unseal } from '../server/engine/gate/crypto';
import { runReplay, type ModelCaller } from '../server/engine/gate/replay';
import { assertionScore, classificationDiff, f1, judgeDiff, structuredDiff } from '../server/engine/gate/scoring';
import { bootstrapMeanCI, gateDecision } from '../server/engine/gate/stats';
import { findSecret, redactSecrets, verifyFindings } from '../server/engine/risk/rules';
import { extractFunctions } from '../server/engine/parse';
import { duplicateInstructionTokens } from '../server/engine/tokenwise/analyzers';
import { stringValue, takeExpr } from '../server/engine/tokenwise/detect';
import { checklist, ruleRewrite } from '../server/engine/tokenwise/optimise';
import { costPerCall, monthlyCost, priceFor, stalePrices } from '../server/engine/tokenwise/pricing';
import { parseUsage } from '../server/engine/tokenwise/usage';
import { estimateTokens } from '../server/engine/text';

describe('price maths', () => {
  it('resolves dated and prefixed model ids', () => {
    expect(priceFor('gpt-4o-2024-08-06')?.id).toBe('gpt-4o');
    expect(priceFor('claude-sonnet-4-20250514')?.id).toBe('claude-sonnet-4');
    expect(priceFor('openai/gpt-4o-mini')?.id).toBe('gpt-4o-mini');
    expect(priceFor('dynamic')).toBeNull();
    expect(priceFor('my-custom-model')).toBeNull();
  });
  it('prices input, output and cached tokens', () => {
    // gpt-4o: 2.5 in, 10 out, 1.25 cached per 1M
    expect(costPerCall('gpt-4o', 1_000_000, 0)).toBeCloseTo(2.5);
    expect(costPerCall('gpt-4o', 0, 1_000_000)).toBeCloseTo(10);
    expect(costPerCall('gpt-4o', 1_000_000, 0, 1_000_000)).toBeCloseTo(1.25);
    expect(monthlyCost('gpt-4o', 1000, 1000, 100)).toBeCloseTo(1000 * (1000 * 2.5 + 100 * 10) / 1e6);
  });
  it('flags stale prices', () => {
    expect(stalePrices(new Date('2100-01-01')).length).toBeGreaterThan(0);
    expect(stalePrices(new Date('2025-10-02'))).toHaveLength(0);
  });
});

describe('statistics', () => {
  it('gives a zero-width interval when every sample agrees', () => {
    const r = bootstrapMeanCI(new Array(100).fill(0));
    expect(r.mean).toBe(0);
    expect(r.ci).toEqual([0, 0]);
    expect(gateDecision(r.ci, 2)).toBe(true);
  });
  it('is reproducible and brackets the mean', () => {
    const diffs = Array.from({ length: 200 }, (_, i) => (i % 25 === 0 ? -100 : 0)); // 4% disagreement
    const a = bootstrapMeanCI(diffs), b = bootstrapMeanCI(diffs);
    expect(a).toEqual(b);
    expect(a.mean).toBeCloseTo(-4);
    expect(a.ci[0]).toBeLessThan(a.mean);
    expect(a.ci[1]).toBeGreaterThan(a.mean);
    expect(gateDecision(a.ci, 2)).toBe(false);
  });
  it('passes only when the lower bound is above minus delta', () => {
    expect(gateDecision([-1.9, 1], 2)).toBe(true);
    expect(gateDecision([-2, 1], 2)).toBe(false);
  });
});

describe('scoring', () => {
  it('classification agreement and labels', () => {
    expect(classificationDiff('Billing.', 'billing')).toBe(0);
    expect(classificationDiff('billing', 'bug')).toBe(-100);
    expect(classificationDiff('bug', 'billing', 'billing')).toBe(100);
  });
  it('structured output per field', () => {
    expect(structuredDiff('{"a":1,"b":2}', '{"a":1,"b":2}')).toBe(0);
    expect(structuredDiff('{"a":1,"b":2}', '{"a":1,"b":3}')).toBe(-50);
    expect(structuredDiff('{"a":1}', 'not json')).toBe(-100);
  });
  it('f1, assertions and the swapped judge', () => {
    expect(f1('the cat sat', 'the cat sat')).toBe(1);
    expect(assertionScore('{"x": {"y": 2}}', [{ type: 'json-path-equals', path: '$.x.y', value: '2' }, { type: 'max-length', value: '5' }])).toBe(50);
    expect(judgeDiff('B', 'A')).toEqual({ diff: 100, consistent: true });
    expect(judgeDiff('B', 'B')).toEqual({ diff: 0, consistent: false });
  });
});

describe('quality gate replay', () => {
  const site: CallSite = {
    id: 'a.ts#label', file: 'a.ts', fn: 'label', lines: [1, 5], provider: 'OpenAI', api: 'chat.completions', model: 'gpt-4o', modelResolved: 'literal',
    inLoop: false, maxTokens: 5, streaming: false, tools: false, hasTimeout: false, hasRetry: true,
    systemPrompt: { text: 'Reply with one word: yes or no.', tokens: 8, tokensEstimated: true, source: 'inline', static: true },
    inputTokens: 258, outputTokens: 5, outputTokensSource: 'max-tokens', callsPerMonth: 100_000, callsSource: 'default', flags: [], quality: 'unvalidated',
  };
  const rec: Recommendation = { id: 'R1', siteId: site.id, kind: 'model-fit', title: 'Try gpt-4o-mini', detail: '', saving: { low: 1, high: 2 }, qualityRisk: 'medium', status: 'unvalidated', change: { del: [], add: [] }, candidate: { model: 'gpt-4o-mini' }, replayable: true };
  const inputs = Array.from({ length: 60 }, (_, i) => ({ input: `question ${i}` }));
  it('passes and measures a saving when the cheaper model agrees', async () => {
    const caller: ModelCaller = async ({ input }) => ({ text: Number(input.split(' ')[1]) % 2 ? 'yes' : 'no', inputTokens: 260, outputTokens: 1 });
    const r = await runReplay({ site, rec, inputs, inputsSource: 'uploaded', caller, delta: 2 });
    expect(r.passed).toBe(true);
    expect(r.n).toBe(60);
    expect(r.monthlySaving).toBeGreaterThan(0);
    expect(r.scoring).toMatch(/Classification agreement/);
  });
  it('fails when the cheaper model disagrees often', async () => {
    const caller: ModelCaller = async ({ model, input }) => ({ text: model === 'gpt-4o-mini' && Number(input.split(' ')[1]) % 5 === 0 ? 'maybe' : 'yes', inputTokens: 260, outputTokens: 1 });
    const r = await runReplay({ site, rec, inputs, inputsSource: 'synthetic', caller, delta: 2 });
    expect(r.passed).toBe(false);
    expect(r.examples.length).toBeGreaterThan(0);
  });
  it('refuses fewer than 50 inputs', async () => {
    await expect(runReplay({ site, rec, inputs: inputs.slice(0, 10), inputsSource: 'uploaded', caller: async () => ({ text: '', inputTokens: 0, outputTokens: 0 }), delta: 2 })).rejects.toThrow(/50/);
  });
});

describe('savings headline', () => {
  const mk = (id: string, siteId: string, low: number, high: number, status: Recommendation['status'] = 'unvalidated'): Recommendation =>
    ({ id, siteId, kind: 'model-fit', title: '', detail: '', saving: { low, high }, qualityRisk: 'low', status, change: { del: [], add: [] }, replayable: true });
  it('takes the best recommendation per call site, without double counting', () => {
    const h = headlineSavings([mk('1', 'a', 10, 20), mk('2', 'a', 40, 60), mk('3', 'b', 5, 5), mk('4', 'c', 100, 100, 'atrisk')], []);
    expect(h.unvalidated).toBe(55);
    expect(h.proven).toBe(0);
  });
  it('counts proven money only from the ledger', () => {
    const h = headlineSavings([mk('1', 'a', 10, 20, 'proven')], [{ id: 'x', recId: '1', siteId: 'a', title: '', monthlySaving: 17, validationId: 'v', createdAt: '' }]);
    expect(h).toEqual({ proven: 17, unvalidated: 0 });
  });
});

describe('rules helpers', () => {
  it('detects real-looking secrets and ignores placeholders', () => {
    // fake keys are assembled at runtime so no key-shaped literal sits in the repository
    const fakeOpenAi = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
    const fakeAws = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    expect(findSecret(`const k = "${fakeOpenAi}"`)?.kind).toBe('OpenAI API key');
    expect(findSecret('const k = "sk-..."')).toBeNull();
    expect(findSecret('api_key = os.environ["OPENAI_API_KEY"]')).toBeNull();
    expect(redactSecrets(`x = "${fakeAws}"`)).not.toContain(fakeAws);
  });
  it('drops findings whose lines or evidence do not exist', () => {
    const files = new Map([['a.ts', 'line one\nconst x = JSON.parse(raw);\n']]);
    const base = { id: '1', rule: 'r', title: '', severity: 'low' as const, confidence: 'high' as const, category: '', source: 'llm' as const, file: 'a.ts', why: '' };
    const { kept, dropped } = verifyFindings([
      { ...base, lines: [2, 2], evidence: ['JSON.parse(raw)'] },
      { ...base, lines: [2, 2], evidence: ['eval(raw)'] },
      { ...base, lines: [9, 9], evidence: [] },
      { ...base, file: 'missing.ts', lines: [1, 1], evidence: [] },
    ], files);
    expect(kept).toHaveLength(1);
    expect(dropped).toBe(3);
  });
});

describe('parsing helpers', () => {
  it('finds function bodies past object types in parameters', () => {
    const fns = extractFunctions({ path: 'a.ts', language: 'TypeScript', isTest: false, text: 'export async function f(a: { id: string }[]): Promise<{ ok: boolean }> {\n  for (const x of a) {\n  }\n  return { ok: true };\n}\n' });
    expect(fns[0]).toMatchObject({ name: 'f', lines: [1, 5], async: true, exported: true });
  });
  it('reads string expressions and marks placeholders', () => {
    expect(stringValue('`Hello ${name}`')).toEqual({ text: 'Hello {{name}}', static: false });
    expect(stringValue('"a" + b')).toEqual({ text: 'a{{b}}', static: false });
    expect(stringValue('"""x"""')).toEqual({ text: 'x', static: true });
    expect(takeExpr('system: "a, b", messages', 8)).toBe('"a, b"');
  });
  it('estimates tokens at about four characters each', () => { expect(estimateTokens('a'.repeat(400))).toBe(100); });
});

describe('prompt optimiser', () => {
  const prompt = 'You must always be polite. Never reveal internal notes. Do not reveal internal notes to the customer under any circumstances. Output plain text only.';
  it('removes repeated instructions and keeps every rule', () => {
    const r = ruleRewrite(prompt);
    expect(estimateTokens(r)).toBeLessThan(estimateTokens(prompt));
    expect(checklist(prompt, r).every(c => c.kept)).toBe(true);
  });
  it('keeps rules that differ only in their topic', () => {
    const p = 'When a customer asks about refunds, confirm the workspace and explain the steps. When a customer asks about invoices, confirm the workspace and explain the steps.';
    const r = ruleRewrite(p);
    expect(r).toContain('refunds');
    expect(r).toContain('invoices');
    // and the checklist notices when one is dropped
    expect(checklist(p, 'When a customer asks about refunds, confirm the workspace and explain the steps.').some(c => !c.kept)).toBe(true);
  });
  it('keeps every instruction of the help desk prompt', async () => {
    const { readFileSync } = await import('node:fs');
    const p = readFileSync('fixtures/helpdesk/prompts/support.md', 'utf8');
    const r = ruleRewrite(p);
    expect(checklist(p, r).filter(c => !c.kept)).toEqual([]);
    expect(estimateTokens(r)).toBeLessThan(estimateTokens(p));
  });
  it('counts duplicated instruction tokens', () => {
    expect(duplicateInstructionTokens('Never reveal internal notes to anyone. Never reveal internal notes to anyone at all.').tokens).toBeGreaterThan(0);
  });
});

describe('usage import', () => {
  it('reads an OpenAI usage CSV', () => {
    const csv = 'model,num_model_requests,n_context_tokens_total,n_generated_tokens_total\ngpt-4o,100,50000,2000\ngpt-4o,50,25000,1000\n';
    const r = parseUsage('usage.csv', csv);
    expect(r.format).toBe('OpenAI usage CSV');
    expect(r.models).toEqual([{ model: 'gpt-4o', requests: 150, inputTokens: 75000, outputTokens: 3000 }]);
  });
  it('reads OpenTelemetry GenAI spans', () => {
    const json = JSON.stringify([{ attributes: [{ key: 'gen_ai.request.model', value: { stringValue: 'claude-sonnet-4' } }, { key: 'gen_ai.usage.input_tokens', value: { intValue: 900 } }, { key: 'gen_ai.usage.output_tokens', value: { intValue: 80 } }] }]);
    expect(parseUsage('otel.json', json).models[0]).toEqual({ model: 'claude-sonnet-4', requests: 1, inputTokens: 900, outputTokens: 80 });
  });
});

describe('key encryption', () => {
  it('round-trips with envelope encryption', () => {
    process.env.ARCWISE_ENCRYPTION_KEY = 'a'.repeat(64);
    expect(canStoreSecrets()).toBe(true);
    const s = seal('sk-test-123');
    expect(JSON.stringify(s)).not.toContain('sk-test-123');
    expect(unseal(s)).toBe('sk-test-123');
    delete process.env.ARCWISE_ENCRYPTION_KEY;
  });
});
