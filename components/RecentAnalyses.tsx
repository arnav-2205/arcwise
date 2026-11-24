'use client';
import { FolderGit2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, relTime } from '../lib/client';
import type { AnalysisSummary } from '../lib/types';

export const STATUS: Record<AnalysisSummary['status'], [string, string]> = {
  done: ['proven', 'Ready'], running: ['testing', 'Running'], queued: ['testing', 'Queued'], failed: ['atrisk', 'Failed'],
};

export default function RecentAnalyses() {
  const [list, setList] = useState<AnalysisSummary[] | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<AnalysisSummary[]>('/analyses').then(setList).catch(() => setList([])); }, []);
  const remove = async (id: string) => {
    try { await api(`/analyses/${id}`, { method: 'DELETE' }); setList(l => l?.filter(a => a.id !== id) ?? null); setConfirm(null); }
    catch (e) { setError((e as Error).message); }
  };
  if (!list) return <div className="stack">{[0, 1, 2].map(i => <div key={i} className="skel" style={{ height: 40 }} />)}</div>;
  if (!list.length) return <div className="empty"><FolderGit2 aria-hidden /><p>No analyses yet. Paste a repository above, or try a sample.</p></div>;
  return (
    <div className="rows">
      {error && <p className="error-text" role="alert">{error}</p>}
      {list.map(a => (
        <div key={a.id} className="item analysis-row">
          {confirm === a.id ? (
            <div className="row wrap-ok" style={{ gap: 10 }}>
              <span className="small" style={{ flex: '1 1 220px' }}>Delete <b className="mono">{a.repo}</b> and everything found in it? This can’t be undone.</span>
              <button className="btn btn-sm" onClick={() => setConfirm(null)}>Keep it</button>
              <button className="btn btn-sm btn-danger" onClick={() => remove(a.id)}><Trash2 className="icon" aria-hidden />Delete permanently</button>
            </div>
          ) : (
            <div className="row" style={{ gap: 12 }}>
              <Link href={`/a/${a.id}`} style={{ flex: 1, minWidth: 0, textDecoration: 'none', color: 'inherit', display: 'grid', gap: 3 }}>
                <span className="item-top"><span className="item-title mono" style={{ fontSize: '.88rem' }}>{a.repo}</span><span className={`pill ${STATUS[a.status][0]}`}>{STATUS[a.status][1]}</span></span>
                <span className="item-meta"><span>{a.branch}{a.commit && a.commit !== 'fixture' ? ` · ${a.commit.slice(0, 7)}` : ''}</span><span>{relTime(a.createdAt)}</span></span>
              </Link>
              <button className="btn btn-quiet btn-sm delete-btn" onClick={() => setConfirm(a.id)} aria-label={`Delete analysis of ${a.repo}`} title="Delete"><Trash2 className="icon" aria-hidden /></button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
