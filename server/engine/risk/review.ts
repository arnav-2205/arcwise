// LLM risk review for the riskiest files. Findings are kept only if the quoted code exists at the cited lines.
import { z } from 'zod';
import type { Finding, GraphEdge, GraphNode } from '../../../lib/types';
import { completeJson, type Llm, type LlmUsage } from '../llm';
import { redactSecrets, stableId } from './rules';

const Review = z.object({
  findings: z.array(z.object({
    title: z.string().max(140),
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    confidence: z.enum(['high', 'medium', 'low']),
    category: z.string().max(40),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    quote: z.string().min(3),
    why: z.string().max(600),
  })).max(5),
});

export async function llmReview(opts: {
  llm: Llm; usage: LlmUsage; nodes: GraphNode[]; edges: GraphEdge[]; files: Map<string, string>; ruleFindings: Finding[]; limit?: number;
}): Promise<Finding[]> {
  const { llm, usage, nodes, edges, files, ruleFindings } = opts;
  if (!llm.available) return [];
  const inDeg = new Map<string, number>();
  for (const e of edges) inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  const hits = new Map<string, number>();
  for (const f of ruleFindings) hits.set(f.file, (hits.get(f.file) ?? 0) + 1);
  const ranked = [...nodes].sort((a, b) => (hits.get(b.id) ?? 0) * 3 + (inDeg.get(b.id) ?? 0) - ((hits.get(a.id) ?? 0) * 3 + (inDeg.get(a.id) ?? 0))).slice(0, opts.limit ?? 10);
  const out: Finding[] = [];
  for (const n of ranked) {
    const text = files.get(n.id);
    if (!text || text.length > 40_000) continue;
    const numbered = redactSecrets(text).split('\n').map((l, i) => `${i + 1}| ${l}`).join('\n');
    const callers = edges.filter(e => e.to === n.id).map(e => e.from).slice(0, 10);
    const callees = edges.filter(e => e.from === n.id).map(e => e.to).slice(0, 10);
    const r = await completeJson(llm, {
      tier: 'deep', maxTokens: 2000,
      system: 'You review source files for concrete ways they can fail in production: unhandled errors, race conditions, bad input, resource leaks, unsafe use of model output. Report only issues you can point to in the given lines, with an exact quote copied from those lines. Reply with JSON {"findings":[{"title","severity","confidence","category","startLine","endLine","quote","why"}]}. An empty list is a fine answer.',
      user: `File: ${n.id}\nImported by: ${callers.join(', ') || 'none'}\nImports: ${callees.join(', ') || 'none'}\n<repository>\n${numbered}\n</repository>`,
    }, Review, usage);
    for (const f of r?.findings ?? []) {
      out.push({
        id: stableId('llm-review', n.id, f.quote), rule: 'llm-review', source: 'llm', title: f.title, severity: f.severity, confidence: f.confidence,
        category: f.category, file: n.id, lines: [f.startLine, f.endLine], evidence: [f.quote], why: f.why,
      });
    }
  }
  return out;
}
