'use client';
import { GitBranch } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, relTime, type AppConfig } from '../lib/client';

const GH = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(\.git)?\/?$/;
const SAMPLE_NAMES: Record<string, string> = { helpdesk: 'helpdesk (TypeScript)', 'fastapi-support': 'fastapi-support (Python)', 'nextjs-chat': 'nextjs-chat (AI SDK)' };
interface Repo { fullName: string; description: string | null; language: string | null; updatedAt: string; defaultBranch: string }

export default function AnalyzeForm() {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branch, setBranch] = useState('');
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  // A link like /start?sample=… must start exactly one analysis, even when effects run twice in development.
  const autoStarted = useRef(false);

  useEffect(() => {
    api<AppConfig>('/config').then(c => {
      setConfig(c);
      // "Open a sample project" on the homepage lands here with ?sample=<name>
      const q = new URLSearchParams(location.search);
      const sample = q.get('sample'), repo = q.get('repo');
      if ((sample || repo) && autoStarted.current) return;
      if (sample || repo) autoStarted.current = true;
      if (sample && c.fixtures.includes(sample)) start({ fixture: sample });
      // the homepage's repo panel sends new accounts here with the repo they entered
      else if (repo && GH.test(repo)) { setUrl(repo); start({ repoUrl: repo }); }
    }).catch(() => {});
    api<Repo[]>('/repos').then(setRepos).catch(() => setRepos([]));
  }, []);

  useEffect(() => {
    setBranches(null); setBranch('');
    if (!GH.test(url.trim())) return;
    const t = setTimeout(async () => {
      setLoadingBranches(true);
      try {
        const r = await api<{ branches: string[]; defaultBranch: string | null }>(`/branches?url=${encodeURIComponent(url.trim())}`);
        setBranches(r.branches); setBranch(r.defaultBranch ?? r.branches[0] ?? ''); setError(null);
      } catch (e) { setError((e as Error).message); }
      finally { setLoadingBranches(false); }
    }, 400);
    return () => clearTimeout(t);
  }, [url]);

  const start = async (body: object) => {
    setBusy(true); setError(null);
    try { const r = await api<{ id: string }>('/analyses', { method: 'POST', json: body }); router.push(`/a/${r.id}`); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!GH.test(url.trim())) { setError('Enter a GitHub URL like https://github.com/owner/repo'); return; }
    start({ repoUrl: url.trim(), branch: branch || undefined });
  };

  return (
    <form className="analyze" onSubmit={submit} id="analyze" noValidate>
      {!!repos?.length && (
        <div className="field">
          <span className="label">Your public repositories</span>
          <div className="repo-list" role="group" aria-label="Your public repositories">
            {repos.slice(0, 30).map(r => {
              const u = `https://github.com/${r.fullName}`;
              return (
                <button key={r.fullName} type="button" aria-pressed={url === u} onClick={() => setUrl(u)}>
                  <span className="name">{r.fullName}</span>
                  <span className="xs dim">{r.language ?? ''}{r.language ? ' · ' : ''}{relTime(r.updatedAt)}</span>
                  {r.description && <span className="desc">{r.description}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="field">
        <label htmlFor="repo">Repository URL</label>
        <div className="analyze-row">
          <input id="repo" className="input" type="url" inputMode="url" autoComplete="off" spellCheck={false}
            placeholder="https://github.com/owner/repo" value={url} onChange={e => setUrl(e.target.value)} aria-invalid={!!error} aria-describedby="repo-help" />
          <button className="btn btn-primary" type="submit" disabled={busy || loadingBranches}>{busy ? 'Starting…' : 'Analyze'}</button>
        </div>
        {error ? <p className="error-text" role="alert">{error}</p> : <p className="hint" id="repo-help">Public repositories only for now. Arcwise reads the code and never runs it.</p>}
      </div>
      {(branches || loadingBranches) && (
        <div className="field">
          <label htmlFor="branch">Branch</label>
          {loadingBranches ? <div className="skel" style={{ height: 36 }} /> : (
            <div className="row"><GitBranch className="icon dim" aria-hidden />
              <select id="branch" className="select" value={branch} onChange={e => setBranch(e.target.value)}>
                {branches!.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
          )}
        </div>
      )}
      {!!config?.fixtures.length && (
        <div className="samples">
          <span>Or try a sample:</span>
          {config.fixtures.map(f => <button key={f} type="button" className="btn btn-ghost btn-xs mono" disabled={busy} onClick={() => start({ fixture: f })}>{SAMPLE_NAMES[f] ?? f}</button>)}
        </div>
      )}
    </form>
  );
}
