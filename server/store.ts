// File-backed store. Analyses are JSON documents; the shape matches the Postgres + object storage
// layout in the spec (searchable fields + large artefacts), so it can be swapped behind this module.
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Analysis, AnalysisSummary, FeedbackStatus, Settings } from '../lib/types';
import type { Sealed } from './engine/gate/crypto';

const ROOT = path.resolve(process.env.ARCWISE_DATA_DIR ?? '.data');
const A_DIR = path.join(ROOT, 'analyses');
const cache = new Map<string, Analysis>();
let ready: Promise<void> | null = null;

async function init() {
  await mkdir(A_DIR, { recursive: true });
  for (const f of await readdir(A_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const a = JSON.parse(await readFile(path.join(A_DIR, f), 'utf8')) as Analysis;
      if (a.status === 'running' || a.status === 'queued') { a.status = 'failed'; a.error = 'The server restarted while this analysis was running. Run it again.'; }
      cache.set(a.id, a);
    } catch { /* skip corrupt file */ }
  }
}
const ensure = () => (ready ??= init());

async function writeJson(file: string, data: unknown) {
  const tmp = file + '.tmp';
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

const writes = new Map<string, Promise<void>>();
/** Ids deleted in this process: a job still running for one must not write it back. */
const deleted = new Set<string>();

/** Permanently removes an analysis and its stored source snapshot. */
export async function deleteAnalysis(id: string) {
  await ensure();
  deleted.add(id);
  cache.delete(id);
  await (writes.get(id) ?? Promise.resolve());
  await rm(path.join(A_DIR, `${id}.json`), { force: true });
  await rm(path.join(ROOT, 'sources', `${id}.json`), { force: true });
}

export async function saveAnalysis(a: Analysis) {
  await ensure();
  if (deleted.has(a.id)) return;
  cache.set(a.id, a);
  const prev = writes.get(a.id) ?? Promise.resolve();
  const next = prev.then(() => writeJson(path.join(A_DIR, `${a.id}.json`), a)).catch(() => {});
  writes.set(a.id, next);
  await next;
}

export async function getAnalysis(id: string): Promise<Analysis | null> {
  await ensure();
  return cache.get(id) ?? null;
}

export async function listAnalyses(ownerId: string): Promise<AnalysisSummary[]> {
  await ensure();
  return [...cache.values()]
    .filter(a => a.ownerId === ownerId)
    .map(({ id, repo, branch, commit, status, createdAt }) => ({ id, repo, branch, commit, status, createdAt }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Previous finished analysis of the same repo and branch, for change detection. */
export async function previousAnalysis(ownerId: string, repo: string, branch: string, before: string): Promise<Analysis | null> {
  await ensure();
  return [...cache.values()].filter(a => a.ownerId === ownerId && a.repo === repo && a.branch === branch && a.status === 'done' && a.createdAt < before)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

/* ---------- source snapshots (secrets already redacted) ---------- */
const S_DIR = path.join(ROOT, 'sources');
export async function saveSources(id: string, files: Map<string, string>) {
  await mkdir(S_DIR, { recursive: true });
  const out: Record<string, string> = {};
  let bytes = 0;
  for (const [p, t] of files) { if (bytes + t.length > 40_000_000) break; out[p] = t; bytes += t.length; }
  await writeJson(path.join(S_DIR, `${id}.json`), out);
}
const sourceCache = new Map<string, Record<string, string>>();
/** Finds a validation report by its id, for the public share link. */
export async function findValidation(vid: string) {
  await ensure();
  for (const a of cache.values()) { const v = a.validations.find(x => x.id === vid); if (v) return { a, v }; }
  return null;
}

export async function getSource(id: string, file: string): Promise<string | null> {
  if (!/^[a-f0-9-]{1,40}$/i.test(id)) return null;
  let doc = sourceCache.get(id);
  if (!doc) {
    try { doc = JSON.parse(await readFile(path.join(S_DIR, `${id}.json`), 'utf8')) as Record<string, string>; } catch { return null; }
    sourceCache.set(id, doc);
    if (sourceCache.size > 5) sourceCache.delete(sourceCache.keys().next().value!);
  }
  return Object.prototype.hasOwnProperty.call(doc, file) ? doc[file] : null;
}

/* ---------- small JSON documents ---------- */
async function readDoc<T>(name: string, fallback: T): Promise<T> {
  await mkdir(ROOT, { recursive: true });
  try { return JSON.parse(await readFile(path.join(ROOT, name), 'utf8')) as T; } catch { return fallback; }
}
const writeDoc = async (name: string, data: unknown) => { await mkdir(ROOT, { recursive: true }); await writeJson(path.join(ROOT, name), data); };

export const DEFAULT_SETTINGS: Settings = { currency: 'INR', fxRate: 83.5, fxAsOf: '2025-10-01', defaultDelta: 2 };
/** Settings per user. */
export const getSettings = (uid: string | undefined) => readDoc<Record<string, Settings>>('settings.json', {}).then(all => ({ ...DEFAULT_SETTINGS, ...(uid ? all[uid] : undefined) }));
export async function saveSettings(uid: string, s: Settings) {
  const all = await readDoc<Record<string, Settings>>('settings.json', {});
  all[uid] = s;
  await writeDoc('settings.json', all);
}

/** Feedback per repository, used to suppress repeats on later analyses. */
export const getFeedback = (repo: string) => readDoc<Record<string, Record<string, FeedbackStatus>>>('feedback.json', {}).then(f => f[repo] ?? {});
export async function setFeedback(repo: string, findingId: string, status: FeedbackStatus | null) {
  const all = await readDoc<Record<string, Record<string, FeedbackStatus>>>('feedback.json', {});
  const mine = (all[repo] ??= {});
  if (status) mine[findingId] = status; else delete mine[findingId];
  await writeDoc('feedback.json', all);
}

/** Encrypted provider keys per repository, scoped to replay jobs. */
type KeyDoc = Record<string, Partial<Record<'openai' | 'anthropic', Sealed>>>;
export const getSealedKey = (repo: string, provider: 'openai' | 'anthropic') => readDoc<KeyDoc>('keys.json', {}).then(k => k[repo]?.[provider] ?? null);
export async function saveSealedKey(repo: string, provider: 'openai' | 'anthropic', sealed: Sealed | null) {
  const all = await readDoc<KeyDoc>('keys.json', {});
  const mine = (all[repo] ??= {});
  if (sealed) mine[provider] = sealed; else delete mine[provider];
  await writeDoc('keys.json', all);
}
export const keyStatus = (repo: string) => readDoc<KeyDoc>('keys.json', {}).then(k => ({ openai: !!k[repo]?.openai, anthropic: !!k[repo]?.anthropic }));
