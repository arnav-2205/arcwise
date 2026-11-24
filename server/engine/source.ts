import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, rm, stat, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

export interface SourceFile {
  path: string; // repo-relative, forward slashes
  text: string;
  language: string;
  isTest: boolean;
}

export interface RepoSource {
  root: string;
  commit: string;
  branch: string;
  files: SourceFile[];
  /** Files skipped for size or type, by reason. */
  skipped: Record<string, number>;
  /** Raw text of lockfiles and dependency manifests, for the OSV check. */
  manifests: { path: string; text: string }[];
  /** Text files that are not code but may hold prompts (.txt, .md, .prompt, .j2). */
  readText(rel: string): Promise<string | null>;
  cleanup(): Promise<void>;
}

const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

export function parseGithubUrl(url: string): { owner: string; repo: string; url: string } | null {
  const m = GITHUB_URL.exec(url.trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2], url: `https://github.com/${m[1]}/${m[2]}.git` };
}

const LANG: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python',
};

// Mirrors the spirit of the upstream ignore-filter: generated, vendored and dependency folders.
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage', 'vendor',
  '__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache', 'target', '.turbo', '.cache', 'site-packages']);
const MANIFESTS = new Set(['package-lock.json', 'requirements.txt', 'package.json', 'pyproject.toml']);
const MAX_FILE_BYTES = 1_000_000;

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' };

export async function listBranches(url: string): Promise<{ branches: string[]; defaultBranch: string | null }> {
  const gh = parseGithubUrl(url);
  if (!gh) throw new Error('Enter a GitHub URL like https://github.com/owner/repo');
  const { stdout } = await run('git', ['ls-remote', '--symref', gh.url, 'HEAD', 'refs/heads/*'], { env: gitEnv, timeout: 20_000, maxBuffer: 8 << 20 });
  const branches: string[] = [];
  let defaultBranch: string | null = null;
  for (const line of stdout.split('\n')) {
    const sym = /^ref: refs\/heads\/(\S+)\s+HEAD/.exec(line);
    if (sym) defaultBranch = sym[1];
    const h = /\trefs\/heads\/(.+)$/.exec(line);
    if (h) branches.push(h[1]);
  }
  return { branches, defaultBranch };
}

export async function loadGithub(url: string, branch: string | undefined, limits: { maxFiles: number; maxMb: number }): Promise<RepoSource> {
  const gh = parseGithubUrl(url);
  if (!gh) throw new Error('Enter a GitHub URL like https://github.com/owner/repo');
  if (branch && !/^[A-Za-z0-9._\/-]+$/.test(branch)) throw new Error('That branch name has characters Arcwise does not accept.');
  const dir = await mkdtemp(path.join(tmpdir(), 'arcwise-'));
  const args = ['clone', '--depth', '1', '--single-branch', '--no-tags', '--filter=blob:limit=1m'];
  if (branch) args.push('--branch', branch);
  args.push('--', gh.url, dir);
  try {
    await run('git', args, { env: gitEnv, timeout: 180_000, maxBuffer: 8 << 20 });
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    const msg = String((e as Error).message);
    if (/not found|Repository not found|could not read Username/i.test(msg)) throw new Error('GitHub could not find that repository. Check the URL. Private repositories need the Arcwise GitHub App.');
    if (/Remote branch .* not found/i.test(msg)) throw new Error(`Branch "${branch}" does not exist in that repository.`);
    throw new Error('Cloning failed: ' + msg.split('\n').slice(-2).join(' ').slice(0, 300));
  }
  const commit = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
  const actualBranch = branch ?? (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })).stdout.trim();
  return walk(dir, commit, actualBranch, limits, true);
}

export async function loadFixture(fixtureDir: string, limits: { maxFiles: number; maxMb: number }): Promise<RepoSource> {
  const dir = await mkdtemp(path.join(tmpdir(), 'arcwise-'));
  await cp(fixtureDir, dir, { recursive: true, filter: src => !src.endsWith('expected.json') });
  return walk(dir, 'fixture', 'main', limits, true);
}

async function walk(root: string, commit: string, branch: string, limits: { maxFiles: number; maxMb: number }, deleteOnCleanup: boolean): Promise<RepoSource> {
  const files: SourceFile[] = [];
  const manifests: { path: string; text: string }[] = [];
  const skipped: Record<string, number> = {};
  let total = 0, bytes = 0;
  const skip = (r: string) => { skipped[r] = (skipped[r] ?? 0) + 1; };

  async function visit(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (e.isSymbolicLink()) { skip('symlink'); continue; }
      if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) await visit(abs); continue; }
      if (!e.isFile()) continue;
      total++;
      if (total > limits.maxFiles) throw new Error(`The repository has more than ${limits.maxFiles.toLocaleString()} files, the current limit.`);
      const s = await stat(abs);
      bytes += s.size;
      if (bytes > limits.maxMb * 1024 * 1024) throw new Error(`The repository is larger than ${limits.maxMb} MB, the current limit.`);
      if (MANIFESTS.has(e.name) && s.size < 20_000_000) { manifests.push({ path: rel, text: await readFile(abs, 'utf8') }); }
      const ext = path.extname(e.name).toLowerCase();
      const lang = LANG[ext];
      if (!lang) { skip('not code'); continue; }
      if (/\.d\.ts$|\.min\.js$/.test(e.name)) { skip('generated'); continue; }
      if (s.size > MAX_FILE_BYTES) { skip('over 1 MB'); continue; }
      const text = await readFile(abs, 'utf8');
      if (text.includes('\u0000')) { skip('binary'); continue; }
      const isTest = /(^|\/)(__tests__|tests?|spec)\//.test(rel) || /\.(test|spec)\.[a-z]+$/.test(rel) || /(^|\/)test_[^/]+\.py$|_test\.py$/.test(rel);
      files.push({ path: rel, text, language: lang, isTest });
    }
  }
  await visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    root, commit, branch, files, skipped, manifests,
    async readText(rel: string) {
      const norm = path.posix.normalize(rel).replace(/^\/+/, '');
      if (norm.startsWith('..')) return null; // never read outside the clone
      const abs = path.join(root, norm);
      try {
        const s = await stat(abs);
        if (!s.isFile() || s.size > MAX_FILE_BYTES) return null;
        return await readFile(abs, 'utf8');
      } catch { return null; }
    },
    async cleanup() { if (deleteOnCleanup) await rm(root, { recursive: true, force: true }); },
  };
}
