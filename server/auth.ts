// GitHub OAuth sign-in with signed session cookies. No personal access tokens are ever requested.
import express, { type NextFunction, type Request, type Response } from 'express';
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canStoreSecrets, seal, unseal, type Sealed } from './engine/gate/crypto';

export interface User { id: string; login: string; name: string | null; avatarUrl: string | null; createdAt: string; token?: Sealed; email?: string; passwordHash?: string }
export type PublicUser = Omit<User, 'token'>;

declare module 'express-serve-static-core' {
  interface Request { user?: User }
}

const SESSION = 'aw_session';
const STATE = 'aw_oauth_state';
const SESSION_DAYS = 30;
const prod = () => process.env.NODE_ENV === 'production';

/* ---------------- configuration ---------------- */
let devSecret: string | null = null;
function secret(): string {
  const s = process.env.ARCWISE_SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (prod()) throw new Error('Set ARCWISE_SESSION_SECRET to at least 32 characters.');
  // Development only: a per-process secret, so sessions end when the server restarts.
  return (devSecret ??= randomBytes(32).toString('hex'));
}
export const githubConfigured = () => !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
/** Guest access is off: everyone creates an account. ARCWISE_GUEST=1 turns it back on for demos. */
export const guestEnabled = () => process.env.ARCWISE_GUEST === '1';
export const devLoginEnabled = guestEnabled;
const baseUrl = (req: Request) => process.env.ARCWISE_BASE_URL?.replace(/\/$/, '') ?? `${req.protocol}://${req.get('host')}`;

/* ---------------- signed cookies ---------------- */
const b64 = (s: string) => Buffer.from(s).toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8');
const mac = (v: string) => createHmac('sha256', secret()).update(v).digest('base64url');

export function signValue(payload: object): string {
  const body = b64(JSON.stringify(payload));
  return `${body}.${mac(body)}`;
}
export function readSigned<T extends { exp: number }>(value: string | undefined): T | null {
  if (!value) return null;
  const [body, sig] = value.split('.');
  if (!body || !sig) return null;
  const expect = Buffer.from(mac(body)), got = Buffer.from(sig);
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) return null;
  try {
    const p = JSON.parse(unb64(body)) as T;
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(res: Response, name: string, value: string, maxAgeSec: number) {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${prod() ? '; Secure' : ''}`);
}

/* ---------------- users ---------------- */
const USERS = path.resolve(process.env.ARCWISE_DATA_DIR ?? '.data', 'users.json');
let users: Record<string, User> | null = null;
async function loadUsers() {
  if (users) return users;
  try { users = JSON.parse(await readFile(USERS, 'utf8')); } catch { users = {}; }
  return users!;
}
async function saveUser(u: User) {
  const all = await loadUsers();
  all[u.id] = u;
  await mkdir(path.dirname(USERS), { recursive: true });
  await writeFile(USERS + '.tmp', JSON.stringify(all));
  await rename(USERS + '.tmp', USERS);
}
export const publicUser = ({ token: _t, passwordHash: _p, ...u }: User): PublicUser => u;

/* ---------------- email + password accounts ---------------- */
const scryptAsync = (pw: string, salt: Buffer) => new Promise<Buffer>((res, rej) => scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scryptAsync(pw, salt)).toString('base64')}`;
}
export async function verifyPassword(pw: string, stored: string | undefined): Promise<boolean> {
  // Always run scrypt, even for unknown accounts, so timing does not reveal which emails exist.
  const [, salt, hash] = (stored ?? `scrypt$${randomBytes(16).toString('base64')}$${randomBytes(64).toString('base64')}`).split('$');
  const got = await scryptAsync(pw, Buffer.from(salt, 'base64'));
  const want = Buffer.from(hash, 'base64');
  return got.length === want.length && timingSafeEqual(got, want) && !!stored;
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normEmail = (e: unknown) => (typeof e === 'string' ? e.trim().toLowerCase() : '');
async function findByEmail(email: string) { return Object.values(await loadUsers()).find(u => u.email === email) ?? null; }

const attempts = new Map<string, number[]>();
function tooMany(key: string, max = 10, windowMs = 10 * 60_000) {
  const now = Date.now();
  const list = (attempts.get(key) ?? []).filter(t => now - t < windowMs);
  list.push(now); attempts.set(key, list);
  return list.length > max;
}

/** GitHub tokens: sealed at rest when an encryption key exists, otherwise kept in memory only. */
const memTokens = new Map<string, string>();
export function githubToken(u: User): string | null {
  if (u.token) { try { return unseal(u.token); } catch { return null; } }
  return memTokens.get(u.id) ?? null;
}

/* ---------------- middleware ---------------- */
export async function attachUser(req: Request, _res: Response, next: NextFunction) {
  const s = readSigned<{ uid: string; exp: number }>(cookies(req)[SESSION]);
  if (s) req.user = (await loadUsers())[s.uid];
  next();
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!req.user) { res.status(401).json({ error: 'Sign in with GitHub to continue.', signIn: true }); return; }
  next();
}

/** Rejects cross-site writes: a mutating request must come from this origin. */
export function sameOrigin(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin && new URL(origin).host !== req.get('host')) { res.status(403).json({ error: 'Cross-site request refused.' }); return; }
  next();
}

const safeNext = (n: unknown) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.includes('\\') ? n : '/');

async function signIn(res: Response, u: User) {
  await saveUser(u);
  setCookie(res, SESSION, signValue({ uid: u.id, exp: Date.now() + SESSION_DAYS * 86_400_000 }), SESSION_DAYS * 86_400);
}

/* ---------------- routes ---------------- */
export function authRouter() {
  const r = express.Router();

  r.get('/github', (req, res) => {
    if (!githubConfigured()) { res.redirect('/?auth=not-configured'); return; }
    const state = randomBytes(16).toString('hex');
    setCookie(res, STATE, signValue({ state, next: safeNext(req.query.next), exp: Date.now() + 600_000 }), 600);
    const u = new URL('https://github.com/login/oauth/authorize');
    u.searchParams.set('client_id', process.env.GITHUB_CLIENT_ID!);
    u.searchParams.set('redirect_uri', `${baseUrl(req)}/auth/github/callback`);
    u.searchParams.set('scope', 'read:user');
    u.searchParams.set('state', state);
    u.searchParams.set('allow_signup', 'true');
    res.redirect(u.toString());
  });

  r.get('/github/callback', async (req, res) => {
    const st = readSigned<{ state: string; next: string; exp: number }>(cookies(req)[STATE]);
    setCookie(res, STATE, '', 0);
    if (!st || typeof req.query.state !== 'string' || req.query.state !== st.state || typeof req.query.code !== 'string') { res.redirect('/?auth=failed'); return; }
    try {
      const tok = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST', signal: AbortSignal.timeout(15_000),
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code: req.query.code, redirect_uri: `${baseUrl(req)}/auth/github/callback` }),
      }).then(r => r.json() as Promise<{ access_token?: string; error?: string }>);
      if (!tok.access_token) throw new Error(tok.error ?? 'no token');
      const gh = await fetch('https://api.github.com/user', { signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'arcwise' } })
        .then(r => r.json() as Promise<{ id: number; login: string; name: string | null; avatar_url: string | null }>);
      if (!gh.id) throw new Error('no user');
      const id = `gh:${gh.id}`;
      const prev = (await loadUsers())[id];
      const u: User = { id, login: gh.login, name: gh.name, avatarUrl: gh.avatar_url, createdAt: prev?.createdAt ?? new Date().toISOString() };
      if (canStoreSecrets()) u.token = seal(tok.access_token); else memTokens.set(id, tok.access_token);
      await signIn(res, u);
      res.redirect(st.next);
    } catch {
      res.redirect('/?auth=failed');
    }
  });

  r.post('/signup', express.json({ limit: '10kb' }), async (req, res) => {
    if (tooMany(`signup|${req.ip}`, 8)) { res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' }); return; }
    const email = normEmail(req.body?.email), password = String(req.body?.password ?? ''), name = String(req.body?.name ?? '').trim().slice(0, 80);
    if (!EMAIL.test(email) || email.length > 200) { res.status(400).json({ error: 'Enter a valid email address.' }); return; }
    if (password.length < 8 || password.length > 200) { res.status(400).json({ error: 'Use a password of at least 8 characters.' }); return; }
    if (await findByEmail(email)) { res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' }); return; }
    const u: User = { id: `u:${randomBytes(9).toString('hex')}`, login: name || email.split('@')[0], name: name || null, avatarUrl: null, createdAt: new Date().toISOString(), email, passwordHash: await hashPassword(password) };
    await signIn(res, u);
    res.json({ ok: true, next: safeNext(req.body?.next) });
  });

  r.post('/login', express.json({ limit: '10kb' }), async (req, res) => {
    const email = normEmail(req.body?.email), password = String(req.body?.password ?? '');
    if (tooMany(`login|${req.ip}`, 10) || tooMany(`login|${email}`, 10)) { res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' }); return; }
    const u = email ? await findByEmail(email) : null;
    const ok = await verifyPassword(password, u?.passwordHash);
    if (!u || !ok) { res.status(401).json({ error: 'That email and password do not match an account.' }); return; }
    await signIn(res, u);
    res.json({ ok: true, next: safeNext(req.body?.next) });
  });

  // Guest access: a private, random identity per browser. Analyses stay visible only to that guest.
  r.post('/guest', async (req, res) => {
    if (!guestEnabled()) { res.status(404).end(); return; }
    const id = `guest:${randomBytes(8).toString('hex')}`;
    await signIn(res, { id, login: `guest-${id.slice(6, 12)}`, name: 'Guest', avatarUrl: null, createdAt: new Date().toISOString() });
    res.redirect(303, safeNext(req.query.next));
  });

  r.post('/logout', (_req, res) => {
    setCookie(res, SESSION, '', 0);
    res.redirect(303, '/');
  });

  return r;
}

/** Public repositories of the signed-in user, newest first. */
export async function listUserRepos(u: User): Promise<{ fullName: string; description: string | null; language: string | null; updatedAt: string; defaultBranch: string; private: boolean }[]> {
  if (!u.id.startsWith('gh:')) return [];
  const token = githubToken(u);
  const url = token ? 'https://api.github.com/user/repos?per_page=50&sort=updated&visibility=public&affiliation=owner,collaborator,organization_member'
    : `https://api.github.com/users/${encodeURIComponent(u.login)}/repos?per_page=50&sort=updated`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/vnd.github+json', 'user-agent': 'arcwise', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} when listing repositories.`);
  const list = await res.json() as { full_name: string; description: string | null; language: string | null; pushed_at: string; default_branch: string; private: boolean }[];
  return list.filter(r => !r.private).map(r => ({ fullName: r.full_name, description: r.description, language: r.language, updatedAt: r.pushed_at, defaultBranch: r.default_branch, private: r.private }));
}
