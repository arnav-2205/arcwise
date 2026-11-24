import express, { type Request, type Response, type NextFunction } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Analysis, FeedbackStatus, Settings } from '../lib/types';
import { siteQuality } from '../lib/savings';
import { recomputeCost } from './cost';
import { canStoreSecrets, seal, unseal } from './engine/gate/crypto';
import { estimateReplayCost, httpCaller, MIN_INPUTS, replayProvider, runReplay, syntheticInputs, TARGET_INPUTS, type ReplayInput } from './engine/gate/replay';
import type { Assertion } from './engine/gate/scoring';
import { llmFromEnv } from './engine/llm';
import { newAnalysis, runPipeline } from './engine/pipeline';
import { redactSecrets } from './engine/risk/rules';
import { listBranches, loadFixture, loadGithub, parseGithubUrl } from './engine/source';
import { optimisePrompt } from './engine/tokenwise/optimise';
import { monthlyCost, priceFor, pricingAsOf, stalePrices } from './engine/tokenwise/pricing';
import { parseUsage } from './engine/tokenwise/usage';
import { emitUpdate, enqueue, bus } from './jobs';
import { attachUser, devLoginEnabled, githubConfigured, listUserRepos, publicUser, requireUser, sameOrigin } from './auth';
import * as store from './store';

const FIXTURES = path.resolve('fixtures');
const limits = { maxFiles: Number(process.env.ARCWISE_MAX_FILES ?? 20000), maxMb: Number(process.env.ARCWISE_MAX_REPO_MB ?? 500) };

/* simple per-IP rate limit for expensive endpoints */
const hits = new Map<string, number[]>();
function rateLimit(max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.ip}|${req.path}`;
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter(t => now - t < windowMs);
    if (list.length >= max) { res.status(429).json({ error: 'Too many requests. Wait a few minutes and try again.' }); return; }
    list.push(now); hits.set(key, list); next();
  };
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
  fn(req, res).catch(e => { if (!res.headersSent) res.status(400).json({ error: (e as Error).message }); });
};

/** Loads an analysis the signed-in user owns. Anything else is reported as not found. */
async function load(req: Request, res: Response): Promise<Analysis | null> {
  const a = await store.getAnalysis(String(req.params.id));
  if (!a || !req.user || a.ownerId !== req.user.id) { res.status(404).json({ error: 'No analysis with that id.' }); return null; }
  return a;
}
/** Feedback and saved keys are scoped to the owner and the repository. */
const scope = (a: Analysis) => `${a.ownerId}|${a.repo}`;

export function apiRouter() {
  const r = express.Router();
  r.use(express.json({ limit: '25mb' }));
  r.use(sameOrigin);
  r.use(attachUser);

  /* ---------- public ---------- */
  r.get('/health', (_req, res) => { res.json({ ok: true }); });

  r.get('/me', (req, res) => {
    res.json({ user: req.user ? publicUser(req.user) : null, auth: { github: githubConfigured(), dev: devLoginEnabled() } });
  });

  r.get('/config', wrap(async (req, res) => {
    const llm = llmFromEnv();
    res.json({
      llm: llm.available, canStoreKeys: canStoreSecrets(), settings: await store.getSettings(req.user?.id),
      fixtures: existsSync(FIXTURES) ? ['helpdesk', 'fastapi-support', 'nextjs-chat'].filter(f => existsSync(path.join(FIXTURES, f))) : [],
      pricingAsOf: pricingAsOf(), stalePrices: stalePrices().length, github: githubConfigured(),
    });
  }));

  // Validation reports are shareable by link. The id is a random UUID; only the report and
  // the recommendation title are returned, never source code.
  r.get('/reports/:vid', wrap(async (req, res) => {
    const hit = await store.findValidation(String(req.params.vid));
    if (!hit) { res.status(404).json({ error: 'No report with that id.' }); return; }
    const rec = hit.a.recommendations.find(x => x.id === hit.v.recId);
    const site = hit.a.callSites.find(s => s.id === hit.v.siteId);
    res.json({ report: hit.v, repo: hit.a.repo, title: rec?.title ?? null, usesShorterPrompt: !!rec?.candidate?.systemPrompt, callsPerMonth: site?.callsPerMonth ?? null, pricingAsOf: hit.a.pricingAsOf });
  }));

  /* ---------- signed in from here on ---------- */
  r.use(requireUser);

  r.get('/repos', rateLimit(30, 60_000), wrap(async (req, res) => { res.json(await listUserRepos(req.user!)); }));

  r.get('/settings', wrap(async (req, res) => { res.json(await store.getSettings(req.user!.id)); }));
  r.put('/settings', wrap(async (req, res) => {
    const cur = await store.getSettings(req.user!.id);
    const b = req.body as Partial<Settings>;
    const next: Settings = {
      currency: b.currency === 'USD' ? 'USD' : b.currency === 'INR' ? 'INR' : cur.currency,
      fxRate: typeof b.fxRate === 'number' && b.fxRate > 0 ? b.fxRate : cur.fxRate,
      fxAsOf: typeof b.fxAsOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.fxAsOf) ? b.fxAsOf : cur.fxAsOf,
      defaultDelta: typeof b.defaultDelta === 'number' && b.defaultDelta > 0 && b.defaultDelta <= 50 ? b.defaultDelta : cur.defaultDelta,
    };
    await store.saveSettings(req.user!.id, next);
    res.json(next);
  }));

  r.get('/branches', rateLimit(30, 60_000), wrap(async (req, res) => {
    res.json(await listBranches(String(req.query.url ?? '')));
  }));

  r.get('/analyses', wrap(async (req, res) => { res.json(await store.listAnalyses(req.user!.id)); }));

  r.post('/analyses', rateLimit(10, 10 * 60_000), wrap(async (req, res) => {
    const { repoUrl, branch, fixture } = req.body as { repoUrl?: string; branch?: string; fixture?: string };
    let a: Analysis, loader;
    if (fixture) {
      if (!/^[a-z0-9-]+$/.test(fixture) || !existsSync(path.join(FIXTURES, fixture))) throw new Error('Unknown sample project.');
      a = newAnalysis(`sample/${fixture}`, 'main', 'fixture', req.user!.id);
      loader = () => loadFixture(path.join(FIXTURES, fixture), limits);
    } else {
      const gh = parseGithubUrl(repoUrl ?? '');
      if (!gh) throw new Error('Enter a GitHub URL like https://github.com/owner/repo');
      a = newAnalysis(`${gh.owner}/${gh.repo}`, branch || '', 'github', req.user!.id);
      loader = () => loadGithub(gh.url, branch || undefined, limits);
    }
    await store.saveAnalysis(a);
    const previous = await store.previousAnalysis(a.ownerId, a.repo, a.branch || 'main', a.createdAt);
    const feedback = await store.getFeedback(scope(a));
    enqueue(() => runPipeline(a, { load: loader, save: store.saveAnalysis, emit: () => emitUpdate(a.id), previous, feedback, saveSources: files => store.saveSources(a.id, files) }));
    res.status(202).json({ id: a.id });
  }));

  r.get('/analyses/:id', wrap(async (req, res) => { const a = await load(req, res); if (a) res.json(a); }));

  // Permanent: removes the analysis, its findings, savings ledger and stored source.
  r.delete('/analyses/:id', wrap(async (req, res) => {
    const a = await load(req, res);
    if (!a) return;
    await store.deleteAnalysis(a.id);
    res.json({ deleted: a.id });
  }));

  r.get('/analyses/:id/source', wrap(async (req, res) => {
    const a = await load(req, res);
    if (!a) return;
    const text = await store.getSource(a.id, String(req.query.path ?? ''));
    if (text == null) { res.status(404).json({ error: 'Source is not available for that file.' }); return; }
    res.json({ text });
  }));

  // Live progress over server-sent events
  r.get('/analyses/:id/events', wrap(async (req, res) => {
    const a = await load(req, res);
    if (!a) return;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    let pending = false;
    const send = async () => {
      if (pending) return;
      pending = true;
      setTimeout(async () => {
        pending = false;
        const cur = await store.getAnalysis(a.id);
        if (!cur) return;
        res.write(`data: ${JSON.stringify({ status: cur.status, error: cur.error, stages: cur.stages, recStatus: cur.recommendations.map(r => [r.id, r.status]), progress: replayProgress.get(cur.id) ?? null })}\n\n`);
      }, 150);
    };
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    bus.on(`update:${a.id}`, send);
    send();
    req.on('close', () => { clearInterval(ping); bus.off(`update:${a.id}`, send); });
  }));

  r.patch('/analyses/:id/findings/:fid', wrap(async (req, res) => {
    const a = await load(req, res);
    if (!a) return;
    const status = (req.body as { status: FeedbackStatus | null }).status;
    if (status && !['accepted', 'false_positive', 'fixed'].includes(status)) throw new Error('Unknown status.');
    const fid = String(req.params.fid);
    if (!a.findings.some(f => f.id === fid)) throw new Error('No finding with that id.');
    if (status) a.feedback[fid] = status; else delete a.feedback[fid];
    await store.setFeedback(scope(a), fid, status);
    await store.saveAnalysis(a);
    res.json({ feedback: a.feedback });
  }));

  r.patch('/analyses/:id/callsites', wrap(async (req, res) => {
    const a = await load(req, res);
    if (!a) return;
    const { siteId, callsPerMonth } = req.body as { siteId: string; callsPerMonth: number };
    const s = a.callSites.find(x => x.id === siteId);
    if (!s) throw new Error('No call site with that id.');
    if (!Number.isFinite(callsPerMonth) || callsPerMonth < 0 || callsPerMonth > 1e10) throw new Error('Enter a number of calls between 0 and 10 billion.');
    s.callsPerMonth = Math.round(callsPerMonth); s.callsSource = 'user';
    recomputeCost(a);
    await store.saveAnalysis(a);
    res.json(a);
  }));

  r.post('/analyses/:id/usage', wrap(async (req, res) => {
    const a = await load(req, res);
    if (!a) return;
    const { name, text } = req.body as { name: string; text: string };
    if (!text) throw new Error('The file is empty.');
    const parsed = parseUsage(name ?? 'usage', text);
    if (!parsed.models.length) throw new Error('No rows with a model name were found. Arcwise reads OpenAI or Anthropic usage CSV, Langfuse, Helicone and OpenTelemetry GenAI JSON.');
    const matched: string[] = [];
    for (const m of parsed.models) {
      const id = priceFor(m.model)?.id ?? m.model;
      const sites = a.callSites.filter(s => (priceFor(s.model)?.id ?? s.model) === id);
      if (!sites.length || !m.requests) continue;
      matched.push(m.model);
      // Volume is split evenly across call sites on the same model, which is stated in the UI.
      for (const s of sites) {
        s.callsPerMonth = Math.round(m.requests / sites.length);
        if (m.inputTokens) s.inputTokens = Math.round(m.inputTokens / m.requests);
        if (m.outputTokens) { s.outputTokens = Math.round(m.outputTokens / m.requests); s.outputTokensSource = 'usage'; }
        s.callsSource = 'usage';
      }
    }
    a.usageImports.push({ name: String(name ?? 'usage').slice(0, 120), format: parsed.format, rows: parsed.rows, importedAt: new Date().toISOString() });
    recomputeCost(a);
    await store.saveAnalysis(a);
    res.json({ analysis: a, matched, unmatched: parsed.models.map(m => m.model).filter(m => !matched.includes(m)) });
  }));

  r.post('/analyses/:id/optimise', rateLimit(20, 10 * 60_000), wrap(async (req, res) => {
    const a = await load(req, res);
    if (!a) return;
    const s = a.callSites.find(x => x.id === (req.body as { siteId: string }).siteId);
    if (!s?.systemPrompt) throw new Error('That call site has no system prompt to optimise.');
    const usage = { inputTokens: 0, outputTokens: 0 };
    const result = await optimisePrompt(redactSecrets(s.systemPrompt.text), llmFromEnv(), usage);
    const saved = result.before - result.after;
    if (saved > 0) {
      const price = priceFor(s.model);
      const saving = price ? s.callsPerMonth * saved * price.price.input / 1e6 : 0;
      let rec = a.recommendations.find(r => r.siteId === s.id && r.kind === 'prompt-bloat');
      if (!rec) {
        rec = { id: `R${Math.max(0, ...a.recommendations.map(r => Number(r.id.slice(1)) || 0)) + 1}`, siteId: s.id, kind: 'prompt-bloat', title: '', detail: '', saving: null, qualityRisk: 'medium', status: 'unvalidated', change: { del: [], add: [] }, replayable: true };
        a.recommendations.push(rec);
      }
      Object.assign(rec, {
        title: `Use the shorter ${s.fn} prompt`,
        detail: `Rewrite cuts the system prompt from about ${result.before.toLocaleString()} to ${result.after.toLocaleString()} tokens and keeps ${result.checklist.filter(c => c.kept).length} of ${result.checklist.length} instructions found.`,
        saving: { low: saving * 0.9, high: saving }, status: rec.status === 'proven' ? 'unvalidated' : rec.status,
        candidate: { model: s.model, systemPrompt: result.rewrite }, replayable: !!replayProvider(s),
        change: { del: [`system prompt: ${result.before.toLocaleString()} tokens`], add: [`system prompt: ${result.after.toLocaleString()} tokens`] },
      });
      s.quality = siteQuality(s, a.recommendations);
      await store.saveAnalysis(a);
    }
    res.json({ result, analysis: a, llm: usage });
  }));

  /* ---------- quality gate ---------- */

  r.get('/analyses/:id/keys', wrap(async (req, res) => { const a = await load(req, res); if (a) res.json({ ...(await store.keyStatus(scope(a))), canStore: canStoreSecrets() }); }));
  r.put('/analyses/:id/keys', wrap(async (req, res) => {
    const a = await load(req, res);
    if (!a) return;
    const { provider, key } = req.body as { provider: 'openai' | 'anthropic'; key: string | null };
    if (!['openai', 'anthropic'].includes(provider)) throw new Error('Unknown provider.');
    await store.saveSealedKey(scope(a), provider, key ? seal(key.trim()) : null);
    res.json(await store.keyStatus(scope(a)));
  }));

  r.post('/analyses/:id/recommendations/:rid/estimate', wrap(async (req, res) => {
    const a = await load(req, res);
    if (!a) return;
    const rec = a.recommendations.find(x => x.id === req.params.rid);
    const site = rec && a.callSites.find(s => s.id === rec.siteId);
    if (!rec || !site) throw new Error('No recommendation with that id.');
    const n = Math.max(MIN_INPUTS, Math.min(1000, Number((req.body as { n?: number }).n) || TARGET_INPUTS));
    res.json({ n, costUsd: estimateReplayCost(site, rec, n), provider: replayProvider(site), replayable: rec.replayable && !!replayProvider(site) });
  }));

  r.post('/analyses/:id/recommendations/:rid/validate', rateLimit(10, 10 * 60_000), wrap(async (req, res) => {
    const a = await load(req, res);
    if (!a) return;
    const rec = a.recommendations.find(x => x.id === req.params.rid);
    const site = rec && a.callSites.find(s => s.id === rec.siteId);
    if (!rec || !site) throw new Error('No recommendation with that id.');
    const provider = replayProvider(site);
    if (!rec.replayable || !provider) throw new Error('This change cannot be replayed automatically. Validate it with real usage data after shipping it behind a flag.');
    if (rec.status === 'testing') throw new Error('A replay is already running for this recommendation.');
    const body = req.body as { inputs?: string; synthetic?: boolean; key?: string; delta?: number; assertions?: Assertion[]; confirmedCostUsd?: number };
    if (typeof body.confirmedCostUsd !== 'number') throw new Error('Confirm the estimated replay cost first.');
    const sealed = await store.getSealedKey(scope(a), provider);
    const key = body.key?.trim() || (sealed ? unseal(sealed) : null);
    if (!key) throw new Error(`Add your ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key. Replays run on your own account.`);
    let inputs: ReplayInput[] = [];
    if (body.inputs) {
      inputs = body.inputs.split('\n').map(l => l.trim()).filter(Boolean).map((l, i) => {
        try { const j = JSON.parse(l); const input = typeof j === 'string' ? j : j.input ?? j.prompt ?? j.text; if (typeof input !== 'string') throw 0; return { input: redactSecrets(input), label: j.label ?? j.expected }; }
        catch { throw new Error(`Line ${i + 1} is not JSON with an "input" field.`); }
      }).slice(0, 1000);
    }
    const settings = await store.getSettings(req.user!.id);
    const delta = typeof body.delta === 'number' && body.delta > 0 ? body.delta : settings.defaultDelta;
    rec.status = 'testing';
    site.quality = siteQuality(site, a.recommendations);
    await store.saveAnalysis(a); emitUpdate(a.id);
    res.status(202).json({ started: true });

    enqueue(async () => {
      const llm = llmFromEnv();
      const usage = { inputTokens: 0, outputTokens: 0 };
      try {
        const source = inputs.length ? 'uploaded' as const : 'synthetic' as const;
        if (!inputs.length) inputs = await syntheticInputs(llm, usage, site);
        const report = await runReplay({
          site, rec, inputs, inputsSource: source, caller: httpCaller(provider, key), delta, assertions: body.assertions, judge: llm, judgeUsage: usage,
          onProgress: (d, t) => { replayProgress.set(a.id, { recId: rec.id, done: d, total: t }); emitUpdate(a.id); },
        });
        a.validations.push(report);
        rec.validationId = report.id;
        rec.status = report.passed ? 'proven' : 'atrisk';
        if (report.passed) {
          a.ledger = a.ledger.filter(e => e.recId !== rec.id);
          a.ledger.push({ id: randomUUID().slice(0, 8), recId: rec.id, siteId: site.id, title: rec.title, monthlySaving: report.monthlySaving, validationId: report.id, createdAt: report.createdAt });
        } else a.ledger = a.ledger.filter(e => e.recId !== rec.id);
      } catch (e) {
        rec.status = 'unvalidated';
        a.warnings.push(`Validation of "${rec.title}" stopped: ${(e as Error).message}`);
      } finally {
        replayProgress.delete(a.id);
        site.quality = siteQuality(site, a.recommendations);
        await store.saveAnalysis(a); emitUpdate(a.id);
      }
    });
  }));

  r.get('/pricing', wrap(async (_req, res) => {
    const { PRICES, pricingAsOf } = await import('./engine/tokenwise/pricing');
    res.json({ asOf: pricingAsOf(), models: PRICES, example: monthlyCost('gpt-4o', 1000, 1000, 100) });
  }));

  r.use((_req, res) => { res.status(404).json({ error: 'Not found.' }); });
  return r;
}

const replayProgress = new Map<string, { recId: string; done: number; total: number }>();
