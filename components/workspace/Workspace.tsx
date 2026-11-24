'use client';
import { Trash2, Check, Coins, LayoutDashboard, LogOut, Network, PanelLeft, Plus, RefreshCw, Search, Settings as Gear, ShieldAlert, X } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, money, relTime, useMe, type AppConfig } from '../../lib/client';
import type { Analysis, AnalysisSummary, Quality, Settings, Stage } from '../../lib/types';
import { BrandMark } from '../Brand';
import type { GNode } from '../Graph3D';
import { STATUS } from '../RecentAnalyses';
import SignIn from '../SignIn';
import DockNav from '../DockNav';
import World from '../World';
import { LAYERS, layerOf, QUALITY_COLOR, QUALITY_LABEL, SEV_COLOR, SEV_RANK } from '../theme';
import { Avatar } from '../UserMenu';
import { Ctx, type Sel, type Tab, type WS } from './context';
import { SettingsDialog, ValidateDialog } from './Dialogs';
import Drawer, { blastRadius } from './Drawer';
import { CostList, isDismissed, OverviewList, RisksList, UnderstandList } from './lists';

const Graph3D = dynamic(() => import('../Graph2D'), { ssr: false, loading: () => <div className="skel" style={{ position: 'absolute', inset: 0, borderRadius: 0 }} /> });

const DEFAULT_SETTINGS: Settings = { currency: 'INR', fxRate: 83.5, fxAsOf: '2025-10-01', defaultDelta: 2 };
type Live = { status: Analysis['status']; error?: string; stages: Stage[]; recStatus: [string, Quality][]; progress: WS['replay'] };

const SECTIONS: { key: Tab; label: string; icon: typeof Network }[] = [
  { key: 'overview', label: 'Overview', icon: LayoutDashboard },
  { key: 'understand', label: 'Understand', icon: Network },
  { key: 'risks', label: 'Risks', icon: ShieldAlert },
  { key: 'cost', label: 'Cost', icon: Coins },
];

export default function Workspace({ id }: { id: string }) {
  const router = useRouter();
  const me = useMe();
  const [a, setA] = useState<Analysis | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [live, setLive] = useState<Live | null>(null);
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [history, setHistory] = useState<AnalysisSummary[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [tab, setTabState] = useState<Tab>('overview');
  const [sel, setSel] = useState<Sel>(null);
  const [search, setSearch] = useState('');
  const [tour, setTour] = useState<WS['tour']>(null);
  const [toastMsg, setToast] = useState<string | null>(null);
  const [validate, setValidate] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const sig = useRef('');
  // Resizable reading pane, remembered per browser
  const [readingW, setReadingW] = useState(420);
  useEffect(() => { try { const v = Number(localStorage.getItem('aw-reading-w')); if (v >= 300 && v <= 760) setReadingW(v); } catch { /* storage blocked */ } }, []);
  useEffect(() => { try { localStorage.setItem('aw-reading-w', String(readingW)); } catch { /* storage blocked */ } }, [readingW]);
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const startX = e.clientX, startW = readingW;
    const move = (ev: PointerEvent) => setReadingW(Math.max(300, Math.min(760, startW + ev.clientX - startX)));
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); document.body.style.cursor = ''; document.body.style.userSelect = ''; };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
  };
  const dockInput = useRef<HTMLInputElement>(null);
  const signedIn = !!me?.user;

  const refresh = useCallback(async () => {
    try { setA(await api<Analysis>(`/analyses/${id}`)); } catch { setNotFound(true); }
  }, [id]);

  useEffect(() => {
    if (!signedIn) return;
    refresh();
    api<AppConfig>('/config').then(c => { setCfg(c); setSettings(c.settings); }).catch(() => {});
    api<AnalysisSummary[]>('/analyses').then(setHistory).catch(() => {});
  }, [refresh, signedIn]);

  // Live progress over SSE; refetch the full analysis when a stage or a recommendation changes state
  useEffect(() => {
    if (!signedIn) return;
    const es = new EventSource(`/api/analyses/${id}/events`);
    es.onmessage = ev => {
      const d = JSON.parse(ev.data) as Live;
      setLive(d);
      const s = d.status + d.stages.map(x => x.status).join() + d.recStatus.map(r => r.join(':')).join();
      if (s !== sig.current) { sig.current = s; refresh(); }
    };
    return () => es.close();
  }, [id, refresh, signedIn]);

  // Keep the rail's history in step with this analysis' status
  useEffect(() => {
    if (signedIn && a?.status) api<AnalysisSummary[]>('/analyses').then(setHistory).catch(() => {});
  }, [a?.status, signedIn]);

  // "/" focuses the command dock, Escape clears it
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(t.tagName)) { e.preventDefault(); dockInput.current?.focus(); }
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);

  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const toast = useCallback((m: string) => { setToast(m); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 4200); }, []);
  const fmt = useCallback((usd: number) => money(usd, settings), [settings]);
  const setTab = useCallback((t: Tab) => { setTabState(t); setSel(null); setTour(null); }, []);
  const select = useCallback((s: Sel) => { setSel(s); if (s) setTour(null); }, []);

  const setCurrency = async (c: Settings['currency']) => {
    setSettings(s => ({ ...s, currency: c }));
    api<Settings>('/settings', { method: 'PUT', json: { currency: c } }).catch(() => {});
  };

  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteAnalysis = async () => {
    try { await api(`/analyses/${id}`, { method: 'DELETE' }); router.push('/start#analyses'); }
    catch (e) { toast((e as Error).message); setConfirmDelete(false); }
  };

  const reanalyze = async () => {
    if (!a) return;
    try {
      const body = a.source === 'fixture' ? { fixture: a.repo.replace('sample/', '') } : { repoUrl: `https://github.com/${a.repo}`, branch: a.branch };
      const r = await api<{ id: string }>('/analyses', { method: 'POST', json: body });
      router.push(`/a/${r.id}`);
    } catch (e) { toast((e as Error).message); }
  };

  const stages = live?.stages ?? a?.stages ?? [];
  const status = live?.status ?? a?.status;

  // ---------- graph mapping ----------
  const view = useMemo(() => {
    if (!a?.graph) return null;
    const fileCost = new Map<string, number>();
    const fileQuality = new Map<string, Quality>();
    const rank: Record<Quality, number> = { atrisk: 4, testing: 3, proven: 2, unvalidated: 1 };
    for (const s of a.callSites) {
      fileCost.set(s.file, (fileCost.get(s.file) ?? 0) + (s.monthlyCostUsd ?? 0));
      const q = fileQuality.get(s.file);
      if (!q || rank[s.quality] > rank[q]) fileQuality.set(s.file, s.quality);
    }
    const maxCost = Math.max(1e-9, ...fileCost.values());
    const fileSev = new Map<string, number>();
    for (const f of a.findings) if (!isDismissed(a, f)) fileSev.set(f.file, Math.max(fileSev.get(f.file) ?? 0, SEV_RANK[f.severity]));
    const deg = new Map<string, number>();
    for (const e of a.graph.edges) { deg.set(e.from, (deg.get(e.from) ?? 0) + 1); deg.set(e.to, (deg.get(e.to) ?? 0) + 1); }
    const sevColor = (r: number) => [SEV_COLOR.low, SEV_COLOR.low, SEV_COLOR.medium, SEV_COLOR.high, SEV_COLOR.critical][r];
    const g: GNode[] = a.graph.nodes.map(n => {
      const base = 0.16 + Math.min(0.22, Math.log10(1 + n.loc) * 0.045 + (deg.get(n.id) ?? 0) * 0.012);
      let color = layerOf(n.layer).color, size = base, dim = false, ring: string | null = null;
      if (tab === 'risks') { const r = fileSev.get(n.id); if (r) { color = sevColor(r); size = 0.2 + r * 0.055; } else dim = true; }
      if (tab === 'cost') {
        if (fileQuality.has(n.id)) { color = layerOf('ai').color; size = 0.2 + 0.32 * Math.sqrt((fileCost.get(n.id) ?? 0) / maxCost); ring = QUALITY_COLOR[fileQuality.get(n.id)!]; }
        else dim = true;
      }
      return { id: n.id, label: n.name, sub: n.id, layer: n.layer, color, size, dim, ring };
    });
    const arcs: [string, string][] = [];
    if (tab === 'cost') for (const r of a.recommendations.filter(x => x.kind === 'redundant')) {
      const drop = a.callSites.find(s => s.id === r.siteId);
      const other = drop && a.callSites.find(s => drop.flags.includes(`Redundant with ${s.fn}`));
      if (drop && other) arcs.push([drop.file, other.file]);
    }
    return { g, edges: a.graph.edges.map(e => ({ from: e.from, to: e.to })), arcs };
  }, [a, tab]);

  const selFile = useMemo(() => {
    if (!a || !sel) return null;
    if (sel.kind === 'node') return sel.id;
    if (sel.kind === 'finding') return a.findings.find(f => f.id === sel.id)?.file ?? null;
    if (sel.kind === 'site' || sel.kind === 'prompt') return a.callSites.find(s => s.id === sel.id)?.file ?? null;
    if (sel.kind === 'rec') { const r = a.recommendations.find(x => x.id === sel.id); return a.callSites.find(s => s.id === r?.siteId)?.file ?? null; }
    return null;
  }, [a, sel]);
  const graphIds = useMemo(() => new Set(a?.graph?.nodes.map(n => n.id) ?? []), [a]);
  const tourFile = tour && a?.graph ? a.graph.flows[tour.flow]?.steps[tour.step] : null;

  const highlight = useMemo(() => {
    if (!a?.graph) return null;
    const q = search.trim().toLowerCase();
    if (q) {
      const s = new Set(a.graph.nodes.filter(n => `${n.id} ${n.summary}`.toLowerCase().includes(q)).map(n => n.id));
      for (const f of a.findings) if (f.title.toLowerCase().includes(q)) s.add(f.file);
      for (const c of a.callSites) if (`${c.fn} ${c.model}`.toLowerCase().includes(q)) s.add(c.file);
      return s;
    }
    if (tour) return new Set(a.graph.flows[tour.flow]?.steps.slice(0, tour.step + 1));
    if (!selFile || !graphIds.has(selFile)) return null;
    if (tab === 'risks' || sel?.kind === 'finding') return blastRadius(a, selFile);
    const s = new Set([selFile]);
    for (const e of a.graph.edges) { if (e.from === selFile) s.add(e.to); if (e.to === selFile) s.add(e.from); }
    return s;
  }, [a, search, tour, selFile, graphIds, tab, sel]);

  const focus = tourFile ?? (selFile && graphIds.has(selFile) ? selFile : null);

  /* ---------- states before the workspace ---------- */
  const shellTop = (<><World ghost="ARCWISE" /><DockNav me={me} /></>);
  if (me && !me.user) return <>{shellTop}<div className="progress-page above"><div className="progress-card"><SignIn me={me} next={`/a/${id}`} /></div></div></>;
  if (notFound) return (
    <>{shellTop}<div className="progress-page above"><div className="progress-card stack">
      <h2>No analysis with that id</h2>
      <p className="muted">It doesn&rsquo;t exist, or it belongs to another account.</p>
      <Link className="btn btn-primary" style={{ justifySelf: 'start' }} href="/start">Go to your analyses</Link>
    </div></div></>
  );
  if (!a || !a.graph) {
    const failed = status === 'failed';
    return (
      <>{shellTop}
        <div className="progress-page above">
          <div className="progress-card">
            <p className="xs dim mono">{a?.repo ?? 'Loading'}{a?.branch ? ` · ${a.branch}` : ''}</p>
            <h2 style={{ marginTop: 6 }}>{failed ? 'The analysis stopped' : 'Mapping the repository'}</h2>
            {failed ? (
              <div className="stack" style={{ marginTop: 16 }}>
                <p className="notice bad">{live?.error ?? a?.error ?? 'Something went wrong.'}</p>
                <div className="row"><button className="btn btn-primary" onClick={reanalyze}>Run again</button><Link className="btn" href="/start">Pick another repository</Link></div>
              </div>
            ) : (
              <>
                <ul className="stages">
                  {(stages.length ? stages : Array.from({ length: 7 }, (_, i) => ({ key: String(i), label: '', status: 'pending' }) as unknown as Stage)).map(s => (
                    <li key={s.key} className={`stage ${s.status}`}>
                      <span className="stage-icon">{s.status === 'done' && <Check size={10} strokeWidth={3} />}</span>
                      <span>{s.label || <span className="skel" style={{ display: 'inline-block', height: 9, width: 160 }} />}</span>
                      {s.status === 'running' && !s.count ? <span className="skel" /> : <span className="count">{s.count ?? ''}</span>}
                    </li>
                  ))}
                </ul>
                <p className="hint">The map opens as soon as the structure is ready. Risks and costs keep filling in after that.</p>
              </>
            )}
          </div>
        </div>
      </>
    );
  }

  const ctx: WS = { a, setA, cfg, settings, fmt, tab, setTab, sel, select, search, tour, setTour, toast, refresh, openValidate: setValidate, replay: live?.progress ?? null };
  const pending = stages.filter(s => s.status === 'pending' || s.status === 'running');
  const counts: Partial<Record<Tab, number>> = { understand: a.graph.nodes.length, risks: a.findings.filter(f => !isDismissed(a, f)).length, cost: a.callSites.length };

  const legend = tab === 'risks'
    ? [...(['critical', 'high', 'medium', 'low'] as const).map(k => [SEV_COLOR[k], k] as const), ['var(--background-modifier-border-strong)', 'no finding'] as const]
    : tab === 'cost'
      ? [[layerOf('ai').color, 'size = monthly spend'] as const, ...(Object.keys(QUALITY_COLOR) as Quality[]).map(q => [QUALITY_COLOR[q], QUALITY_LABEL[q]] as const), [SEV_COLOR.critical, 'arc = redundant'] as const]
      : LAYERS.filter(l => a.graph!.nodes.some(n => n.layer === l.key)).map(l => [l.color, l.name] as const);

  return (
    <Ctx.Provider value={ctx}>
      <div className={`shell${collapsed ? ' collapsed' : ''}`}>
        {/* ---------- left rail: navigation and history ---------- */}
        <nav className="rail" aria-label="Workspace">
          <div className="rail-head">
            <Link href="/" className="brand" aria-label="Arcwise home"><BrandMark /><span className="hide-collapsed">Arcwise</span></Link>
            <span className="spacer hide-collapsed" />
            <button className="btn btn-quiet btn-xs rail-collapse hide-collapsed" onClick={() => setCollapsed(true)} aria-label="Collapse sidebar" title="Collapse sidebar"><PanelLeft className="icon" /></button>
          </div>
          <div className="rail-scroll">
            {collapsed && <button className="nav-row rail-collapse" onClick={() => setCollapsed(false)} aria-label="Expand sidebar" title="Expand sidebar"><PanelLeft className="icon" /></button>}
            <div className="rail-group" style={{ marginTop: 4 }}>
              <span className="kicker hide-collapsed">This analysis</span>
              {SECTIONS.map(s => (
                <button key={s.key} className="nav-row" aria-current={tab === s.key} onClick={() => setTab(s.key)} title={s.label}>
                  <s.icon className="icon" aria-hidden /><span className="hide-collapsed">{s.label}</span>
                  {counts[s.key] != null && <span className="count hide-collapsed">{counts[s.key]}</span>}
                </button>
              ))}
            </div>
            <div className="rail-group history hide-collapsed">
              <span className="kicker">Analyses</span>
              <Link className="nav-row" href="/start"><Plus className="icon" aria-hidden />New analysis</Link>
              {history.slice(0, 20).map(h => (
                <Link key={h.id} className="nav-row" href={`/a/${h.id}`} aria-current={h.id === a.id ? 'page' : undefined}>
                  <span className="label-2"><span className="mono" style={{ fontSize: '.82rem' }}>{h.repo}</span><small>{h.branch} · {relTime(h.createdAt)}{h.status !== 'done' ? ` · ${STATUS[h.status][1]}` : ''}</small></span>
                </Link>
              ))}
            </div>
          </div>
          <div className="rail-foot">
            <button className="nav-row" onClick={() => setShowSettings(true)} title="Settings"><Gear className="icon" aria-hidden /><span className="hide-collapsed">Settings</span></button>
            
            {me?.user && (
              <form method="post" action="/auth/logout">
                <button className="nav-row" type="submit" title={`Sign out ${me.user.login}`}>
                  <Avatar user={me.user} /><span className="hide-collapsed mono" style={{ fontSize: '.82rem' }}>{me.user.login}</span>
                  <LogOut className="icon hide-collapsed" style={{ marginLeft: 'auto' }} aria-label="Sign out" />
                </button>
              </form>
            )}
          </div>
        </nav>

        {/* ---------- main: header, reading pane + map, command dock ---------- */}
        <div className="main">
          <header className="main-head">
            <h1>{a.repo}</h1>
            <span className="meta">{a.branch}{a.commit && a.commit !== 'fixture' ? ` @ ${a.commit.slice(0, 7)}` : ''}</span>
            <span className={`pill ${STATUS[a.status][0]}`}>{STATUS[a.status][1]}</span>
            <span className="spacer" />
            <div className="seg" role="group" aria-label="Currency">
              {(['INR', 'USD'] as const).map(c => <button key={c} aria-pressed={settings.currency === c} onClick={() => setCurrency(c)}>{c}</button>)}
            </div>
            <button className="btn btn-sm" onClick={reanalyze}><RefreshCw className="icon" aria-hidden />Analyze again</button>
            {confirmDelete ? (
              <span className="row" style={{ gap: 6 }}>
                <span className="small muted">Delete permanently?</span>
                <button className="btn btn-sm" onClick={() => setConfirmDelete(false)}>Keep</button>
                <button className="btn btn-sm btn-danger" onClick={deleteAnalysis}><Trash2 className="icon" aria-hidden />Delete</button>
              </span>
            ) : <button className="btn btn-quiet btn-sm" onClick={() => setConfirmDelete(true)} title="Delete this analysis"><Trash2 className="icon" aria-hidden /><span className="sr">Delete this analysis</span></button>}
          </header>
          {pending.length > 0 && status !== 'failed' ? (
            <div className="strip" role="status"><span className="skel" /><span>{pending.map(s => s.label).join(', ')}. Results appear as each step finishes.</span></div>
          ) : <div />}
          <div className="panes" style={{ gridTemplateColumns: `${readingW}px 8px minmax(0, 1fr)` }}>
            <section className="reading" aria-label={`${tab} details`}>
              {tab === 'overview' && <OverviewList />}
              {tab === 'understand' && <UnderstandList />}
              {tab === 'risks' && <RisksList />}
              {tab === 'cost' && <CostList />}
            </section>
            <div className="splitter" role="separator" aria-orientation="vertical" aria-label="Resize the reading pane" tabIndex={0}
              aria-valuenow={readingW} aria-valuemin={300} aria-valuemax={760}
              onPointerDown={startResize} onDoubleClick={() => setReadingW(420)}
              onKeyDown={e => { if (e.key === 'ArrowLeft') setReadingW(w => Math.max(300, w - 24)); if (e.key === 'ArrowRight') setReadingW(w => Math.min(760, w + 24)); }} />
            <section className="map" aria-label="3D map of the repository. Drag to rotate, scroll to zoom, click a node to open it.">
              {view && <Graph3D nodes={view.g} edges={view.edges} layers={LAYERS} arcs={view.arcs} highlight={highlight} selected={focus} focus={focus}
                onSelect={nid => select(nid ? { kind: 'node', id: nid } : null)} interactive zoom autoRotate={0.04} />}
              <div className="legend" aria-label="Legend">{legend.map(([c, l]) => <span key={l}><i className="legend-dot" style={{ background: c }} />{l}</span>)}</div>
              <p className="map-help">Drag to rotate · scroll to zoom · click a node</p>
              <Drawer />
            </section>
          </div>
          <div className="dock">
            <label className="dock-field">
              <Search className="icon" aria-hidden />
              <span className="sr">Search files, findings and AI calls</span>
              <input ref={dockInput} value={search} placeholder="Search files, findings and AI calls"
                onChange={e => { setSearch(e.target.value); if (e.target.value && tab === 'overview') setTabState('understand'); }}
                onKeyDown={e => { if (e.key === 'Escape') { setSearch(''); (e.target as HTMLInputElement).blur(); } }} />
              {search && <button className="btn btn-quiet btn-xs" onClick={() => setSearch('')} aria-label="Clear search"><X className="icon" /></button>}
            </label>
            <div className="dock-hints">
              <span><kbd>/</kbd> to search</span><span><kbd>Esc</kbd> to clear</span>
              <span>Matches light up on the map and filter the list on the left.</span>
            </div>
          </div>
        </div>
      </div>
      {validate && <ValidateDialog recId={validate} onClose={() => setValidate(null)} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} onSaved={setSettings} me={me} />}
      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
    </Ctx.Provider>
  );
}
