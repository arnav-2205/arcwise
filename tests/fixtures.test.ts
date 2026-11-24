import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Analysis } from '../lib/types';
import { NullLlm } from '../server/engine/llm';
import { newAnalysis, runPipeline } from '../server/engine/pipeline';
import { loadFixture } from '../server/engine/source';

const offline = (async () => { throw new Error('offline in tests'); }) as unknown as typeof fetch;

async function analyse(name: string): Promise<Analysis> {
  const a = newAnalysis(`sample/${name}`, 'main', 'fixture');
  await runPipeline(a, {
    load: () => loadFixture(path.resolve('fixtures', name), { maxFiles: 20000, maxMb: 500 }),
    save: async () => {}, emit: () => {}, llm: new NullLlm(), fetchImpl: offline,
  });
  return a;
}

for (const name of ['helpdesk', 'fastapi-support', 'nextjs-chat']) {
  describe(`fixture ${name}`, async () => {
    const expected = JSON.parse(readFileSync(path.resolve('fixtures', name, 'expected.json'), 'utf8'));
    const a = await analyse(name);

    it('finishes', () => { expect(a.status).toBe('done'); });

    it('finds exactly the expected call sites', () => {
      expect(a.callSites.map(s => s.id).sort()).toEqual(expected.callSites.map((s: { id: string }) => s.id).sort());
      for (const e of expected.callSites) {
        const s = a.callSites.find(x => x.id === e.id)!;
        expect(s.provider).toBe(e.provider);
        expect(s.model).toBe(e.model);
        if ('maxTokens' in e) expect(s.maxTokens).toBe(e.maxTokens);
        if ('inLoop' in e) expect(s.inLoop).toBe(e.inLoop);
        if ('systemPromptTokens' in e) expect(s.systemPrompt?.tokens).toBe(e.systemPromptTokens);
        if ('systemPromptStatic' in e) expect(s.systemPrompt?.static).toBe(e.systemPromptStatic);
      }
    });

    it('flags the redundant pairs', () => {
      for (const [x, y] of expected.redundantPairs as [string, string][]) {
        expect(a.callSites.find(s => s.id === x)!.flags.join()).toContain(`Redundant with ${y.split('#')[1]}`);
      }
    });

    it('produces the expected findings', () => {
      for (const e of expected.findings) {
        const hit = a.findings.find(f => f.rule === e.rule && f.file === e.file && f.lines[0] === e.line);
        expect(hit, `${e.rule} at ${e.file}:${e.line}`).toBeTruthy();
        if (e.severity) expect(hit!.severity).toBe(e.severity);
      }
      for (const e of expected.absentFindings) expect(a.findings.some(f => f.rule === e.rule && f.file === e.file)).toBe(false);
    });

    it('never cites a line that does not exist', () => {
      const root = path.resolve('fixtures', name);
      for (const f of a.findings) {
        const lines = readFileSync(path.join(root, f.file), 'utf8').split('\n');
        expect(f.lines[0]).toBeGreaterThanOrEqual(1);
        expect(f.lines[1]).toBeLessThanOrEqual(lines.length);
      }
    });

    it('masks secrets in evidence', () => {
      for (const f of a.findings.filter(x => x.rule === 'hardcoded-secret')) expect(f.evidence.join()).not.toContain('9fK2qWx7LmN4pR8tVz3bYc6Dq1Wz');
    });

    it('produces the expected recommendations, all unvalidated', () => {
      for (const e of expected.recommendations) expect(a.recommendations.some(r => r.kind === e.kind && r.siteId === e.siteId), `${e.kind} on ${e.siteId}`).toBe(true);
      expect(a.recommendations.every(r => r.status === 'unvalidated')).toBe(true);
      expect(a.ledger).toHaveLength(0);
    });

    it('builds a valid graph', () => {
      const ids = new Set(a.graph!.nodes.map(n => n.id));
      expect(a.graph!.edges.every(e => ids.has(e.from) && ids.has(e.to))).toBe(true);
      expect(a.graph!.nodes.every(n => n.summary.length > 0)).toBe(true);
    });
  });
}
