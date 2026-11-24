// Explain stage: per-file summaries, flows (tours) and the overview paragraph.
// Prompts adapted from the Understand-Anything file-analyzer, architecture-analyzer and tour-builder agents.
import { z } from 'zod';
import type { Flow, GraphEdge, GraphNode, Layer } from '../../lib/types';
import { completeJson, type Llm, type LlmUsage } from './llm';
import { redactSecrets } from './risk/rules';
import { estimateTokens } from './text';

const LAYER_PLAIN: Record<Layer, string> = {
  interface: 'part of what users see or call',
  service: 'business logic that other parts use',
  ai: 'code that calls an AI model',
  data: 'code that stores or loads data',
  config: 'settings the rest of the app reads',
};
const FX_PLAIN: Record<string, string> = { llm: 'an AI model', database: 'the database', network: 'other services over the network', filesystem: 'files on disk' };

export function structureSummary(n: GraphNode, edges: GraphEdge[]): { summary: string; plain: string } {
  const users = edges.filter(e => e.to === n.id).length;
  const uses = edges.filter(e => e.from === n.id).map(e => e.to.split('/').pop());
  const fns = n.functions.filter(f => f.exported).map(f => f.name);
  const list = (fns.length ? fns : n.functions.map(f => f.name)).slice(0, 5);
  const parts = [
    list.length ? `Defines ${list.join(', ')}${n.functions.length > list.length ? ` and ${n.functions.length - list.length} more` : ''}.` : `${n.loc} lines with no named functions.`,
    users ? `Imported by ${users} file${users > 1 ? 's' : ''}.` : 'Not imported by other files, so it is likely an entry point.',
    uses.length ? `Uses ${uses.slice(0, 4).join(', ')}${uses.length > 4 ? ` and ${uses.length - 4} more` : ''}.` : '',
    n.sideEffects.length ? `Talks to ${n.sideEffects.map(s => FX_PLAIN[s]).join(', ')}.` : '',
  ];
  const plain = `This file is ${LAYER_PLAIN[n.layer]}.${n.sideEffects.length ? ` It reaches out to ${n.sideEffects.map(s => FX_PLAIN[s]).join(' and ')}.` : ''}${users ? ` ${users} other file${users > 1 ? 's depend' : ' depends'} on it.` : ''}`;
  return { summary: parts.filter(Boolean).join(' '), plain };
}

/** Flows ordered by dependency: from entry points through the files they import. */
export function structureFlows(nodes: GraphNode[], edges: GraphEdge[], max = 5): Flow[] {
  const out = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const e of edges) { (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to); inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1); }
  const byId = new Map(nodes.map(n => [n.id, n]));
  const reach = (id: string) => { const seen = new Set([id]); const q = [id]; while (q.length) for (const t of out.get(q.shift()!) ?? []) if (!seen.has(t)) { seen.add(t); q.push(t); } return seen.size; };
  const entries = nodes.filter(n => !inDeg.get(n.id) && (out.get(n.id)?.length ?? 0) > 0)
    .sort((a, b) => (a.layer === 'interface' ? -1 : 0) - (b.layer === 'interface' ? -1 : 0) || reach(b.id) - reach(a.id)).slice(0, max);
  return entries.map(entry => {
    const steps: string[] = [];
    const visit = (id: string) => {
      if (steps.includes(id) || steps.length >= 9) return;
      steps.push(id);
      // prefer AI and data steps, they tell the story
      const next = [...(out.get(id) ?? [])].sort((a, b) => score(byId.get(b)) - score(byId.get(a)));
      for (const t of next.slice(0, 2)) visit(t);
    };
    visit(entry.id);
    return { name: `From ${entry.name}`, description: `What happens when ${entry.name} runs, following the files it uses.`, steps };
  }).filter(f => f.steps.length > 1);
}
const score = (n?: GraphNode) => !n ? 0 : n.layer === 'ai' ? 3 : n.layer === 'service' ? 2 : n.layer === 'data' ? 1 : 0;

export function structureOverview(repo: string, nodes: GraphNode[], frameworks: string[], aiSites: number): string {
  const langs = [...new Set(nodes.map(n => n.language))];
  const layers = (['interface', 'service', 'ai', 'data'] as Layer[]).map(l => [l, nodes.filter(n => n.layer === l).length] as const).filter(([, c]) => c);
  return `${repo} is a ${langs.join(' and ')} codebase${frameworks.length ? ` built with ${frameworks.slice(0, 4).join(', ')}` : ''}. ` +
    `It has ${nodes.length} source files: ${layers.map(([l, c]) => `${c} ${l === 'ai' ? 'AI' : l}`).join(', ')}. ` +
    (aiSites ? `Arcwise found ${aiSites} place${aiSites > 1 ? 's' : ''} where it calls an AI model.` : 'Arcwise found no AI model calls.');
}

/* ---------------- LLM-backed explanations ---------------- */

const FileBatch = z.object({ files: z.array(z.object({ path: z.string(), summary: z.string().max(500), plain: z.string().max(400) })) });
const Architecture = z.object({
  description: z.string().max(900),
  flows: z.array(z.object({ name: z.string().max(80), description: z.string().max(300), steps: z.array(z.string()).min(2).max(12) })).max(6),
});

export function estimateExplainTokens(nodes: GraphNode[], files: Map<string, string>, maxFiles: number): number {
  return nodes.slice(0, maxFiles).reduce((a, n) => a + estimateTokens((files.get(n.id) ?? '').split('\n').slice(0, 150).join('\n')) + 120, 0) + 6000;
}

export async function llmExplain(opts: {
  llm: Llm; usage: LlmUsage; repo: string; nodes: GraphNode[]; edges: GraphEdge[]; files: Map<string, string>; maxFiles: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ description: string | null; flows: Flow[] | null }> {
  const { llm, usage, nodes, edges, files } = opts;
  const inDeg = new Map<string, number>();
  for (const e of edges) inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  const target = [...nodes].sort((a, b) => (inDeg.get(b.id) ?? 0) - (inDeg.get(a.id) ?? 0)).slice(0, opts.maxFiles);
  const repoMap = `Repository: ${opts.repo}\nFiles and layers:\n` + nodes.map(n => `${n.id} [${n.layer}]`).join('\n');
  const byId = new Map(nodes.map(n => [n.id, n]));
  const batches: GraphNode[][] = [];
  for (let i = 0; i < target.length; i += 8) batches.push(target.slice(i, i + 8));
  let done = 0;
  // limited concurrency
  const queue = [...batches];
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const batch = queue.shift()!;
      const body = batch.map(n => `<file path="${n.id}">\n${redactSecrets((files.get(n.id) ?? '').split('\n').slice(0, 150).join('\n'))}\n</file>`).join('\n');
      const r = await completeJson(llm, {
        tier: 'bulk', maxTokens: 1500, cachedContext: `<repository>\n${repoMap}\n</repository>`,
        system: 'You explain source files to engineers joining a team. For each file write "summary": two sentences on what it does and why it exists, naming key functions; and "plain": one sentence a non-engineer would understand. Reply with JSON {"files":[{"path","summary","plain"}]}.',
        user: `<repository>\n${body}\n</repository>`,
      }, FileBatch, usage);
      for (const f of r?.files ?? []) { const n = byId.get(f.path); if (n) { n.summary = f.summary; n.plain = f.plain; n.summarySource = 'llm'; } }
      done += batch.length; opts.onProgress?.(done, target.length);
    }
  }));
  const arch = await completeJson(llm, {
    tier: 'deep', maxTokens: 2500, cachedContext: `<repository>\n${repoMap}\n</repository>`,
    system: 'You are a software architect. Using the file list, imports and summaries, write "description": one paragraph in plain English on what the application does and how it is organised; and "flows": up to 5 business flows, each with a name, a one-sentence description and the ordered file paths it passes through (only paths from the list). Reply with JSON.',
    user: `<repository>\nImports:\n${edges.slice(0, 1500).map(e => `${e.from} -> ${e.to}`).join('\n')}\n\nSummaries:\n${target.map(n => `${n.id}: ${n.summary}`).join('\n')}\n</repository>`,
  }, Architecture, usage);
  const flows = arch?.flows.map(f => ({ ...f, steps: f.steps.filter(s => byId.has(s)) })).filter(f => f.steps.length > 1) ?? null;
  return { description: arch?.description ?? null, flows: flows?.length ? flows : null };
}

export function detectFrameworks(manifests: { path: string; text: string }[], pkgs: Set<string>): string[] {
  const names: [string, string][] = [
    ['next', 'Next.js'], ['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['express', 'Express'], ['fastify', 'Fastify'], ['@nestjs/core', 'NestJS'], ['hono', 'Hono'],
    ['fastapi', 'FastAPI'], ['flask', 'Flask'], ['django', 'Django'], ['openai', 'OpenAI SDK'], ['@anthropic-ai/sdk', 'Anthropic SDK'], ['anthropic', 'Anthropic SDK'],
    ['ai', 'Vercel AI SDK'], ['langchain', 'LangChain'], ['@langchain/core', 'LangChain'], ['litellm', 'LiteLLM'], ['@google/genai', 'Google GenAI'], ['@google/generative-ai', 'Google GenAI'],
    ['prisma', 'Prisma'], ['@prisma/client', 'Prisma'], ['drizzle-orm', 'Drizzle'], ['mongoose', 'Mongoose'], ['sqlalchemy', 'SQLAlchemy'], ['pydantic', 'Pydantic'],
  ];
  const deps = new Set(pkgs);
  for (const m of manifests) {
    if (m.path.endsWith('package.json')) { try { const j = JSON.parse(m.text); Object.keys({ ...j.dependencies, ...j.devDependencies }).forEach(d => deps.add(d)); } catch { /* ignore */ } }
    if (m.path.endsWith('requirements.txt') || m.path.endsWith('pyproject.toml')) for (const l of m.text.split('\n')) { const r = /^\s*"?([A-Za-z0-9_.-]+)/.exec(l); if (r) deps.add(r[1].toLowerCase()); }
  }
  return [...new Set(names.filter(([k]) => deps.has(k)).map(([, v]) => v))];
}
