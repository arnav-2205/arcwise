// Analysis pipeline: clone → parse → map → (explain | risk | cost) → assemble.
import { randomUUID } from 'node:crypto';
import type { Analysis, Stage } from '../../lib/types';
import { siteQuality } from '../../lib/savings';
import { detectFrameworks, estimateExplainTokens, llmExplain, structureFlows, structureOverview, structureSummary } from './explain';
import { llmFromEnv, type Llm } from './llm';
import { buildStructure, layerOf } from './parse';
import { osvFindings } from './risk/osv';
import { llmReview } from './risk/review';
import { redactSecrets, runRules, verifyFindings } from './risk/rules';
import type { RepoSource } from './source';
import { computeFlags, recommend, redundantPairs } from './tokenwise/analyzers';
import { detectCallSites, findPrompts } from './tokenwise/detect';
import { costPerCall, pricingAsOf } from './tokenwise/pricing';

export const STAGES: [Stage['key'], string][] = [
  ['clone', 'Cloning repository'], ['parse', 'Parsing code'], ['map', 'Mapping structure'],
  ['explain', 'Explaining modules'], ['risk', 'Scanning for risks'], ['cost', 'Finding AI calls'], ['assemble', 'Assembling the map'],
];

export function newAnalysis(repo: string, branch: string, source: Analysis['source'], ownerId = 'test'): Analysis {
  return {
    // 16 hex chars: not guessable, since ids appear in URLs
    id: randomUUID().replace(/-/g, '').slice(0, 16), ownerId, repo, branch, commit: '', status: 'queued', createdAt: new Date().toISOString(), source,
    stages: STAGES.map(([key, label]) => ({ key, label, status: 'pending' })),
    overview: null, graph: null, findings: [], feedback: {}, callSites: [], recommendations: [], validations: [], ledger: [], usageImports: [],
    pricingAsOf: pricingAsOf(), llm: { used: false, estimatedTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: null }, changes: null, warnings: [],
  };
}

export interface PipelineDeps {
  load: () => Promise<RepoSource>;
  save: (a: Analysis) => Promise<void>;
  emit: () => void;
  previous?: Analysis | null;
  feedback?: Analysis['feedback'];
  llm?: Llm;
  fetchImpl?: typeof fetch;
  maxLlmFiles?: number;
  /** Stores a redacted copy of the source for the code viewer. */
  saveSources?: (files: Map<string, string>) => Promise<void>;
}

export async function runPipeline(a: Analysis, deps: PipelineDeps): Promise<void> {
  const llm = deps.llm ?? llmFromEnv();
  const usage = { inputTokens: 0, outputTokens: 0 };
  const stage = (k: Stage['key']) => a.stages.find(s => s.key === k)!;
  const start = async (k: Stage['key']) => { Object.assign(stage(k), { status: 'running', startedAt: Date.now() }); deps.emit(); };
  const finish = async (k: Stage['key'], count?: string, status: Stage['status'] = 'done') => {
    Object.assign(stage(k), { status, count, endedAt: Date.now() });
    await deps.save(a); deps.emit();
  };
  a.status = 'running';
  let src: RepoSource | null = null;
  try {
    await start('clone');
    src = await deps.load();
    a.commit = src.commit; a.branch = src.branch;
    await finish('clone', `${src.files.length.toLocaleString()} code files`);

    await start('parse');
    const structure = buildStructure(src.files);
    const fnCount = [...structure.functions.values()].reduce((n, f) => n + f.length, 0);
    await finish('parse', `${fnCount.toLocaleString()} functions`);

    await start('map');
    const sites = await detectCallSites({ files: src.files, structure, readText: src.readText });
    const aiFiles = new Set(sites.map(s => s.file));
    const byPath = new Map(src.files.map(f => [f.path, f]));
    for (const n of structure.nodes) {
      if (aiFiles.has(n.id) && !n.sideEffects.includes('llm')) n.sideEffects.push('llm');
      n.layer = layerOf(byPath.get(n.id)!, n.sideEffects, aiFiles.has(n.id));
      Object.assign(n, structureSummary(n, structure.edges));
    }
    const frameworks = detectFrameworks(src.manifests, new Set([...structure.packages.values()].flat()));
    const langs = new Map<string, number>();
    for (const n of structure.nodes) langs.set(n.language, (langs.get(n.language) ?? 0) + 1);
    a.overview = {
      description: structureOverview(a.repo, structure.nodes, frameworks, sites.length),
      languages: [...langs].map(([name, files]) => ({ name, files })).sort((x, y) => y.files - x.files), frameworks,
      fileCount: structure.nodes.length, loc: structure.nodes.reduce((s, n) => s + n.loc, 0),
    };
    a.graph = { nodes: structure.nodes, edges: structure.edges, flows: structureFlows(structure.nodes, structure.edges) };
    if (deps.previous?.graph) {
      const prev = new Map(deps.previous.graph.nodes.map(n => [n.id, n]));
      const cur = new Set(structure.nodes.map(n => n.id));
      a.changes = {
        since: deps.previous.commit || deps.previous.createdAt,
        added: structure.nodes.filter(n => !prev.has(n.id)).map(n => n.id),
        removed: [...prev.keys()].filter(id => !cur.has(id)),
        modified: structure.nodes.filter(n => prev.has(n.id) && prev.get(n.id)!.hash !== n.hash).map(n => n.id),
      };
    }
    await finish('map', `${structure.nodes.length} modules, ${structure.edges.length} links`);

    const fileText = new Map(src.files.map(f => [f.path, f.text]));
    for (const m of src.manifests) fileText.set(m.path, m.text);
    await deps.saveSources?.(new Map([...fileText].map(([p, t]) => [p, redactSecrets(t)])));

    const explain = async () => {
      await start('explain');
      if (!llm.available) { await finish('explain', 'from code structure (no LLM key set)', 'skipped'); return; }
      // Incremental: reuse summaries for files whose content did not change
      const prev = new Map((deps.previous?.graph?.nodes ?? []).map(n => [n.id, n]));
      const todo = a.graph!.nodes.filter(n => { const p = prev.get(n.id); if (p && p.hash === n.hash && p.summarySource === 'llm') { n.summary = p.summary; n.plain = p.plain; n.summarySource = 'llm'; return false; } return true; });
      a.llm.estimatedTokens = estimateExplainTokens(todo, fileText, deps.maxLlmFiles ?? 300);
      stage('explain').count = `about ${Math.round(a.llm.estimatedTokens / 1000)}k tokens estimated`;
      deps.emit();
      const r = await llmExplain({ llm, usage, repo: a.repo, nodes: todo, edges: a.graph!.edges, files: fileText, maxFiles: deps.maxLlmFiles ?? 300,
        onProgress: (d, t) => { stage('explain').count = `${d} of ${t} files`; deps.emit(); } });
      if (r.description) a.overview!.description = r.description;
      if (r.flows) a.graph!.flows = r.flows;
      a.llm.used = true;
      await finish('explain', `${a.graph!.nodes.filter(n => n.summarySource === 'llm').length} summaries`);
    };

    const cost = async () => {
      await start('cost');
      const pairs = redundantPairs(sites);
      computeFlags(sites, pairs);
      a.recommendations = recommend(sites, pairs, p => fileText.get(p));
      a.callSites = sites.map(s => ({ ...s, quality: 'unvalidated' as const }));
      for (const s of a.callSites) s.quality = siteQuality(s, a.recommendations);
      a.prompts = findPrompts(src!.files, a.callSites);
      await finish('cost', `${sites.length} call site${sites.length === 1 ? '' : 's'}`);
    };

    const risk = async () => {
      await start('risk');
      const rules = runRules({ files: src!.files, structure, nodes: structure.nodes, edges: structure.edges, sites });
      const [osv, reviewed] = await Promise.all([
        osvFindings(src!.manifests, deps.fetchImpl),
        llmReview({ llm, usage, nodes: structure.nodes, edges: structure.edges, files: fileText, ruleFindings: rules }),
      ]);
      if (osv.warning) a.warnings.push(osv.warning);
      const all = [...rules, ...osv.findings, ...reviewed];
      // dedupe by id, then verify every citation
      const unique = [...new Map(all.map(f => [f.id, f])).values()];
      const { kept, dropped } = verifyFindings(unique, fileText);
      if (dropped) a.warnings.push(`${dropped} finding${dropped > 1 ? 's were' : ' was'} dropped because the cited lines did not match the code.`);
      a.findings = kept;
      a.feedback = Object.fromEntries(Object.entries(deps.feedback ?? {}).filter(([id]) => kept.some(f => f.id === id)));
      await finish('risk', `${kept.length} finding${kept.length === 1 ? '' : 's'}`);
    };

    const results = await Promise.allSettled([explain(), risk(), cost()]);
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const key = (['explain', 'risk', 'cost'] as const)[i];
        Object.assign(stage(key), { status: 'failed', count: String((r.reason as Error).message).slice(0, 120) });
        a.warnings.push(`${stage(key).label} failed: ${(r.reason as Error).message}`);
      }
    });

    await start('assemble');
    validateGraph(a);
    a.llm.inputTokens = usage.inputTokens; a.llm.outputTokens = usage.outputTokens;
    const deep = llm.modelFor('deep');
    a.llm.costUsd = a.llm.used && deep ? costPerCall(deep, usage.inputTokens, usage.outputTokens) : a.llm.used ? null : 0;
    a.status = 'done';
    await finish('assemble', 'ready');
  } catch (e) {
    a.status = 'failed';
    a.error = (e as Error).message;
    for (const s of a.stages) if (s.status === 'running') s.status = 'failed';
    await deps.save(a); deps.emit();
  } finally {
    await src?.cleanup();
  }
}

/** Structural checks on the assembled graph: every edge and flow step points at a node. */
export function validateGraph(a: Analysis) {
  if (!a.graph) return;
  const ids = new Set(a.graph.nodes.map(n => n.id));
  if (ids.size !== a.graph.nodes.length) throw new Error('Graph has duplicate node ids');
  a.graph.edges = a.graph.edges.filter(e => ids.has(e.from) && ids.has(e.to));
  a.graph.flows = a.graph.flows.map(f => ({ ...f, steps: f.steps.filter(s => ids.has(s)) })).filter(f => f.steps.length > 1);
}
