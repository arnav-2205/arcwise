'use client';
import { ExternalLink, FlaskConical, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, compact } from '../../lib/client';
import type { Analysis, FeedbackStatus, Finding, GraphNode } from '../../lib/types';
import { layerOf, SEV_RANK } from '../theme';
import { CIChart, CodeBlock, DiffBlock, Est, QualityPill, SevPill } from '../ui';
import { useWS } from './context';
import { isDismissed } from './lists';

const FX_LABEL: Record<string, string> = { llm: 'LLM call', database: 'Database', network: 'Network', filesystem: 'File system' };

/** Everything that imports `id`, directly or indirectly. */
export function blastRadius(a: Analysis, id: string): Set<string> {
  const importers = new Map<string, string[]>();
  for (const e of a.graph?.edges ?? []) (importers.get(e.to) ?? importers.set(e.to, []).get(e.to)!).push(e.from);
  const seen = new Set([id]); const q = [id];
  while (q.length) for (const x of importers.get(q.shift()!) ?? []) if (!seen.has(x)) { seen.add(x); q.push(x); }
  return seen;
}

function useSource(id: string, file: string | null) {
  const [text, setText] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!file) return;
    let live = true;
    setText(undefined);
    api<{ text: string }>(`/analyses/${id}/source?path=${encodeURIComponent(file)}`).then(r => live && setText(r.text)).catch(() => live && setText(null));
    return () => { live = false; };
  }, [id, file]);
  return text;
}

function FileChips({ ids }: { ids: string[] }) {
  const { select } = useWS();
  if (!ids.length) return <span className="dim small">None</span>;
  const base = (p: string) => p.split('/').pop()!;
  const dup = new Set(ids.map(base).filter((b, i, all) => all.indexOf(b) !== i));
  const label = (p: string) => (dup.has(base(p)) ? p.split('/').slice(-2).join('/') : base(p));
  return <div className="chips">{ids.slice(0, 40).map(i => <button key={i} className="chip" onClick={() => select({ kind: 'node', id: i })} title={i}>{label(i)}</button>)}{ids.length > 40 && <span className="dim xs">and {ids.length - 40} more</span>}</div>;
}

export default function Drawer() {
  const { sel, select } = useWS();
  const [w, setW] = useState(480);
  useEffect(() => { try { const v = Number(localStorage.getItem('aw-drawer-w')); if (v >= 340 && v <= 900) setW(v); } catch { /* storage blocked */ } }, []);
  useEffect(() => { try { localStorage.setItem('aw-drawer-w', String(w)); } catch { /* storage blocked */ } }, [w]);
  if (!sel) return null;
  const startResize = (e: React.PointerEvent) => {
    const startX = e.clientX, startW = w;
    const move = (ev: PointerEvent) => setW(Math.max(340, Math.min(900, startW - (ev.clientX - startX))));
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); document.body.style.userSelect = ''; };
    addEventListener('pointermove', move); addEventListener('pointerup', up); document.body.style.userSelect = 'none';
  };
  return (
    <aside className="drawer" aria-label="Details" style={{ width: `min(${w}px, 96%)` }}>
      <div className="drawer-grip" role="separator" aria-orientation="vertical" aria-label="Resize the details panel" tabIndex={0} onPointerDown={startResize}
        onKeyDown={e => { if (e.key === 'ArrowLeft') setW(v => Math.min(900, v + 32)); if (e.key === 'ArrowRight') setW(v => Math.max(340, v - 32)); }} />
      <button className="drawer-close" onClick={() => select(null)} aria-label="Close details"><X className="icon" /></button>
      {sel.kind === 'node' && <NodeDetail id={sel.id} />}
      {sel.kind === 'finding' && <FindingDetail id={sel.id} />}
      {sel.kind === 'site' && <SiteDetail id={sel.id} />}
      {sel.kind === 'rec' && <RecDetail id={sel.id} />}
      {sel.kind === 'prompt' && <PromptDetail id={sel.id} />}
    </aside>
  );
}

/* ---------------- File ---------------- */
function NodeDetail({ id }: { id: string }) {
  const { a, select } = useWS();
  const [eli, setEli] = useState(false);
  const [range, setRange] = useState<[number, number] | null>(null);
  const n = a.graph?.nodes.find(x => x.id === id);
  const text = useSource(a.id, n?.id ?? null);
  useEffect(() => setRange(null), [id]);
  if (!n) return <p className="muted">That file is not in this analysis.</p>;
  const L = layerOf(n.layer);
  const uses = (a.graph?.edges ?? []).filter(e => e.from === id).map(e => e.to);
  const usedBy = (a.graph?.edges ?? []).filter(e => e.to === id).map(e => e.from);
  const findings = a.findings.filter(f => f.file === id && !isDismissed(a, f)).sort((x, y) => SEV_RANK[y.severity] - SEV_RANK[x.severity]);
  const sites = a.callSites.filter(s => s.file === id);
  const changed = a.changes?.modified.includes(id) ? 'Modified' : a.changes?.added.includes(id) ? 'New' : null;
  return (
    <>
      <h2>{n.name}</h2>
      <div className="drawer-head">
        <span className="pill" style={{ color: L.color, borderColor: L.color + '66' }}>{L.name}</span>
        <span className="pill">{n.language}</span>
        <span className="pill num">{n.loc} lines</span>
        {changed && <span className="pill testing">{changed} since last analysis</span>}
      </div>
      <p className="xs dim" style={{ overflowWrap: 'anywhere' }}>{n.id}</p>
      <button className="switch" aria-pressed={eli} onClick={() => setEli(!eli)} style={{ marginTop: 12 }}><i />Explain like I&rsquo;m new</button>
      <p className="prose" style={{ marginTop: 8 }}>{eli ? n.plain : n.summary}</p>
      {n.summarySource === 'structure' && <p className="xs dim" style={{ marginTop: 6 }}>Written from the code structure.</p>}

      <h4>Side effects</h4>
      <div className="chips">{n.sideEffects.length ? n.sideEffects.map(s => <span key={s} className="chip">{FX_LABEL[s]}</span>) : <span className="dim small">None found</span>}</div>

      {!!sites.length && <><h4>AI calls in this file</h4><div className="rows">{sites.map(s => (
        <button key={s.id} className="item" onClick={() => select({ kind: 'site', id: s.id })}>
          <span className="item-top"><span className="item-title">{s.fn}</span><QualityPill q={s.quality} /></span>
          <span className="item-path">{s.provider} · {s.model} · lines {s.lines[0]}-{s.lines[1]}</span>
        </button>))}</div></>}

      {!!findings.length && <><h4>Findings in this file</h4><div className="rows">{findings.map(f => (
        <button key={f.id} className="item" onClick={() => select({ kind: 'finding', id: f.id })}>
          <span className="item-top"><span className="item-title">{f.title}</span><SevPill s={f.severity} /></span>
          <span className="item-path">line {f.lines[0]}</span>
        </button>))}</div></>}

      <h4>Uses</h4><FileChips ids={uses} />
      <h4>Used by</h4><FileChips ids={usedBy} />

      {!!n.functions.length && <>
        <h4>Functions</h4>
        <div className="chips">{n.functions.slice(0, 60).map(f => (
          <button key={f.name + f.lines[0]} className="chip" aria-pressed={range?.[0] === f.lines[0]} onClick={() => setRange(range?.[0] === f.lines[0] ? null : f.lines)}>
            {f.name}<span className="dim">:{f.lines[0]}</span>
          </button>))}</div>
      </>}
      <h4>Source</h4>
      <SourceView text={text} hl={range} focus={range?.[0]} />
    </>
  );
}

function SourceView({ text, hl, focus, window = 0 }: { text: string | null | undefined; hl?: [number, number] | null; focus?: number; window?: number }) {
  if (text === undefined) return <div className="skel" style={{ height: 160 }} />;
  if (text === null) return <p className="dim small">Source is not available for this file.</p>;
  const all = text.split('\n');
  let start = 1, lines = all;
  if (window && focus) { start = Math.max(1, focus - window); lines = all.slice(start - 1, Math.min(all.length, focus + window * 2)); }
  else if (all.length > 600) lines = all.slice(0, 600);
  return <CodeBlock lines={lines} start={start} hl={hl ?? undefined} />;
}

/* ---------------- Finding ---------------- */
function FindingDetail({ id }: { id: string }) {
  const { a, setA, select, toast } = useWS();
  const f = a.findings.find(x => x.id === id);
  const text = useSource(a.id, f?.file ?? null);
  const blast = useMemo(() => (f ? [...blastRadius(a, f.file)].filter(x => x !== f.file) : []), [a, f]);
  if (!f) return <p className="muted">That finding is not in this analysis.</p>;
  const mark = async (status: FeedbackStatus) => {
    const next = a.feedback[f.id] === status ? null : status;
    try {
      const r = await api<{ feedback: Analysis['feedback'] }>(`/analyses/${a.id}/findings/${encodeURIComponent(f.id)}`, { method: 'PATCH', json: { status: next } });
      setA({ ...a, feedback: r.feedback });
      toast(next ? `Marked ${next === 'false_positive' ? 'as a false positive' : next}. Later analyses of this repository remember it.` : 'Mark removed.');
    } catch (e) { toast((e as Error).message); }
  };
  const isNode = a.graph?.nodes.some(n => n.id === f.file);
  const ln = f.lines[0] === f.lines[1] ? `${f.lines[0]}` : `${f.lines[0]}-${f.lines[1]}`;
  return (
    <>
      <h2>{f.title}</h2>
      <div className="drawer-head">
        <SevPill s={f.severity} />
        <span className="pill">{f.confidence} confidence</span>
        <span className="pill">{f.category}</span>
        <span className="pill">{f.source === 'llm' ? 'AI review' : 'Rule'}</span>
      </div>
      {isNode ? <button className="chip" onClick={() => select({ kind: 'node', id: f.file })}>{f.file}:{ln}</button> : <span className="chip">{f.file}:{ln}</span>}
      <h4>Evidence</h4>
      {f.rule === 'hardcoded-secret' || !text ? (f.evidence.length ? <CodeBlock lines={f.evidence} start={f.lines[0]} hl={f.lines} wrap /> : <p className="dim small">See line {ln}.</p>)
        : <SourceView text={text} hl={f.lines} focus={f.lines[0]} window={4} />}
      <h4>Why it can break</h4>
      <p className="prose">{f.why}</p>
      {f.note && <p className="muted small" style={{ marginTop: 8 }}>{f.note}</p>}
      {f.fix && <><h4>Suggested fix</h4><DiffBlock diff={f.fix} file={`${f.file}:${f.lines[0]}`} /></>}
      <h4>Blast radius: {blast.length} file{blast.length === 1 ? '' : 's'} depend on this</h4>
      <FileChips ids={blast} />
      <h4>Your call</h4>
      <div className="row wrap-ok">
        {([['accepted', 'Accept'], ['false_positive', 'False positive'], ['fixed', 'Mark fixed']] as const).map(([k, l]) => (
          <button key={k} className={`btn btn-sm ${a.feedback[f.id] === k ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={a.feedback[f.id] === k} onClick={() => mark(k)}>{l}</button>
        ))}
      </div>
      <p className="xs dim" style={{ marginTop: 8 }}>Saved for this repository and used to hide repeats on later analyses.</p>
    </>
  );
}

/* ---------------- Call site ---------------- */
function SiteDetail({ id }: { id: string }) {
  const { a, setA, select, fmt, toast } = useWS();
  const s = a.callSites.find(x => x.id === id);
  const text = useSource(a.id, s?.file ?? null);
  const [calls, setCalls] = useState(String(s?.callsPerMonth ?? ''));
  const [saving, setSaving] = useState(false);
  useEffect(() => setCalls(String(s?.callsPerMonth ?? '')), [s?.callsPerMonth, id]);
  if (!s) return <p className="muted">That call site is not in this analysis.</p>;
  const total = a.callSites.reduce((x, c) => x + (c.monthlyCostUsd ?? 0), 0);
  const save = async () => {
    const v = Number(calls.replace(/[,_\s]/g, ''));
    if (!Number.isFinite(v) || v < 0) { toast('Enter a whole number of calls per month.'); return; }
    setSaving(true);
    try { setA(await api<Analysis>(`/analyses/${a.id}/callsites`, { method: 'PATCH', json: { siteId: s.id, callsPerMonth: v } })); toast('Volume saved. Costs and savings are recalculated.'); }
    catch (e) { toast((e as Error).message); } finally { setSaving(false); }
  };
  const recs = a.recommendations.filter(r => r.siteId === s.id);
  const resolved = { literal: 'written in the code', constant: 'from a constant', 'env-default': 'default of an environment variable', dynamic: 'decided at runtime' }[s.modelResolved];
  return (
    <>
      <h2>{s.fn}</h2>
      <div className="drawer-head"><QualityPill q={s.quality} /><span className="pill">{s.provider}</span><span className="pill">{s.api}</span></div>
      <button className="chip" onClick={() => select({ kind: 'node', id: s.file })}>{s.file}:{s.lines[0]}</button>
      <div className="stat-grid" style={{ marginTop: 16 }}>
        <div className="stat"><b className="num">{s.monthlyCostUsd == null ? '—' : fmt(s.monthlyCostUsd)}</b><span>per month{s.callsSource !== 'usage' ? ', estimated' : ''}</span></div>
        <div className="stat"><b className="num">{s.monthlyCostUsd != null && total ? `${((s.monthlyCostUsd / total) * 100).toFixed(0)}%` : '—'}</b><span>of AI spend</span></div>
        <div className="stat"><b className="num">{compact(s.inputTokens)}</b><span>input tokens per call{s.callsSource === 'usage' ? ' (usage)' : ', estimated'}</span></div>
        <div className="stat"><b className="num">{compact(s.outputTokens)}</b><span>output tokens per call ({s.outputTokensSource === 'usage' ? 'usage' : s.outputTokensSource === 'max-tokens' ? 'capped by max tokens' : 'estimated'})</span></div>
      </div>
      <h4>Calls per month</h4>
      <div className="row">
        <label className="sr" htmlFor="calls">Calls per month</label>
        <input id="calls" className="input input-sm num" inputMode="numeric" value={calls} onChange={e => setCalls(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} style={{ maxWidth: 180 }} />
        <button className="btn btn-ghost btn-sm" onClick={save} disabled={saving || calls === String(s.callsPerMonth)}>Save</button>
      </div>
      <p className="xs dim" style={{ marginTop: 6 }}>{s.callsSource === 'default' ? 'Default assumption. Set the real number, or import usage data.' : s.callsSource === 'usage' ? 'From imported usage data.' : 'Set by you.'}</p>
      {s.monthlyCostUsd == null && <p className="notice" style={{ marginTop: 10 }}>No price is known for “{s.model}”, so this call is left out of totals.</p>}
      <h4>Details</h4>
      <dl className="kv">
        <dt>Model</dt><dd>{s.model} <span className="dim">({resolved})</span></dd>
        <dt>Max tokens</dt><dd>{s.maxTokens ?? 'not set'}</dd>
        <dt>Streaming</dt><dd>{s.streaming ? 'yes' : 'no'}</dd>
        <dt>Tools</dt><dd>{s.tools ? 'yes' : 'no'}</dd>
        <dt>In a loop</dt><dd>{s.inLoop ? 'yes' : 'no'}</dd>
        <dt>Timeout</dt><dd>{s.hasTimeout ? 'set' : 'not set'}</dd>
      </dl>
      {!!s.flags.length && <><h4>Flags</h4><div className="chips">{s.flags.map(f => <span key={f} className="chip">{f}</span>)}</div></>}
      {s.systemPrompt && <>
        <h4>System prompt · {s.systemPrompt.tokens.toLocaleString('en-US')} tokens <Est /></h4>
        <p className="xs dim" style={{ marginBottom: 6 }}>{s.systemPrompt.source}, {s.systemPrompt.static ? 'the same on every call' : 'with placeholders'}</p>
        <pre className="code wrap-lines" style={{ maxHeight: 200, padding: 12 }}>{s.systemPrompt.text.slice(0, 3000)}{s.systemPrompt.text.length > 3000 ? '\n…' : ''}</pre>
        <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => select({ kind: 'prompt', id: s.id })}><Sparkles className="icon" aria-hidden />Optimise prompt</button>
      </>}
      <h4>Recommendations</h4>
      {recs.length ? <div className="rows">{recs.map(r => (
        <button key={r.id} className="item" onClick={() => select({ kind: 'rec', id: r.id })}>
          <span className="item-top"><span className="item-title">{r.title}</span><QualityPill q={r.status} /></span>
        </button>))}</div> : <p className="small dim">None for this call.</p>}
      <h4>Source</h4>
      <SourceView text={text} hl={s.lines} focus={s.lines[0]} window={6} />
    </>
  );
}

/* ---------------- Recommendation ---------------- */
function RecDetail({ id }: { id: string }) {
  const { a, select, fmt, openValidate, replay } = useWS();
  const r = a.recommendations.find(x => x.id === id);
  if (!r) return <p className="muted">That recommendation is not in this analysis.</p>;
  const s = a.callSites.find(c => c.id === r.siteId);
  const v = a.validations.find(x => x.id === r.validationId);
  const running = replay?.recId === r.id ? replay : null;
  return (
    <>
      <h2>{r.title}</h2>
      <div className="drawer-head"><QualityPill q={r.status} /><span className="pill">{r.kind.replace('-', ' ')}</span><span className="pill">{r.qualityRisk} risk to quality</span></div>
      {s && <button className="chip" onClick={() => select({ kind: 'site', id: s.id })}>{s.fn} · {s.model}</button>}
      <div className="metric" style={{ marginTop: 6 }}>
        {r.status === 'proven' && v ? <><b className="num ok">{fmt(v.monthlySaving)}</b><span>saved per month, verified by replay</span></>
          : r.status === 'atrisk' ? <><b className="bad">Not counted</b><span>quality dropped more than the limit</span></>
            : r.saving ? <><b className="num">{fmt(r.saving.low)} to {fmt(r.saving.high)}</b><span>per month, estimated, not yet counted</span></>
              : <><b>No saving claimed</b><span>this change caps risk rather than cost</span></>}
      </div>
      <p className="prose" style={{ marginTop: 14 }}>{r.detail}</p>
      {(r.change.del.length > 0 || r.change.add.length > 0) && <><h4>The change</h4><DiffBlock diff={r.change} file={s ? `${s.file}:${s.lines[0]}` : undefined} /></>}
      <h4>Validation</h4>
      {running ? (
        <div className="stack">
          <p className="small">Replaying both versions: {running.done} of {running.total} inputs.</p>
          <div className="share" style={{ height: 6 }}><i style={{ width: `${(running.done / Math.max(1, running.total)) * 100}%`, background: 'var(--blue)' }} /></div>
        </div>
      ) : r.status === 'testing' ? <div className="skel" style={{ height: 40 }} />
        : v ? (
          <div className="stack">
            <CIChart mean={v.meanDiff} ci={v.ci} delta={v.delta} />
            <dl className="kv">
              <dt>Inputs</dt><dd>{v.n} {v.inputsSource === 'synthetic' ? <span className="pill syn">synthetic</span> : 'uploaded'}</dd>
              <dt>Scoring</dt><dd>{v.scoring}</dd>
              <dt>Difference</dt><dd className="num">{v.meanDiff.toFixed(1)} points, 95% interval {v.ci[0].toFixed(1)} to {v.ci[1].toFixed(1)}</dd>
              <dt>Limit</dt><dd>-{v.delta} points</dd>
            </dl>
            <div className="row wrap-ok">
              <a className="btn btn-ghost btn-sm" href={`/r/${v.id}`} target="_blank" rel="noreferrer"><ExternalLink className="icon" aria-hidden />Open full report</a>
              {r.replayable && <button className="btn btn-quiet btn-sm" onClick={() => openValidate(r.id)}>Run again</button>}
            </div>
          </div>
        ) : r.replayable ? (
          <div className="stack">
            <p className="small muted">Not validated yet. Replay the current and the cheaper version on the same inputs with your own API key. Nothing runs until you confirm the cost.</p>
            <button className="btn btn-primary btn-sm" style={{ justifySelf: 'start' }} onClick={() => openValidate(r.id)}><FlaskConical className="icon" aria-hidden />Validate this saving</button>
          </div>
        ) : (
          <p className="small muted">{r.kind === 'prompt-bloat' ? 'Run Optimise on this prompt first. The rewrite can then be replayed.' : 'This change does not alter a single call, so it cannot be replayed. Ship it behind a flag and confirm with usage data.'}</p>
        )}
      {r.kind === 'prompt-bloat' && s && <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} onClick={() => select({ kind: 'prompt', id: s.id })}><Sparkles className="icon" aria-hidden />Open prompt optimiser</button>}
    </>
  );
}

/* ---------------- Prompt optimiser ---------------- */
interface OptimiseResult { original: string; rewrite: string; before: number; after: number; method: 'llm' | 'rules'; checklist: { instruction: string; kept: boolean; where: string | null }[] }

function PromptDetail({ id }: { id: string }) {
  const { a, setA, select, toast, fmt } = useWS();
  const s = a.callSites.find(x => x.id === id);
  const [res, setRes] = useState<OptimiseResult | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setRes(null), [id]);
  if (!s?.systemPrompt) return <p className="muted">This call has no system prompt.</p>;
  const run = async () => {
    setBusy(true);
    try {
      const r = await api<{ result: OptimiseResult; analysis: Analysis }>(`/analyses/${a.id}/optimise`, { method: 'POST', json: { siteId: s.id } });
      setRes(r.result); setA(r.analysis);
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const rec = a.recommendations.find(r => r.siteId === s.id && r.kind === 'prompt-bloat');
  const kept = res?.checklist.filter(c => c.kept).length ?? 0;
  return (
    <>
      <h2>Optimise the {s.fn} prompt</h2>
      <div className="drawer-head"><span className="pill num">{s.systemPrompt.tokens.toLocaleString('en-US')} tokens</span><Est /></div>
      <p className="small muted">Produces a shorter rewrite that keeps every instruction, constraint, output format and safety rule. The rewrite stays Unvalidated until it passes the quality gate.</p>
      {!res && (busy ? <div className="stack" style={{ marginTop: 16 }}><div className="skel" style={{ height: 18 }} /><div className="skel" style={{ height: 120 }} /></div>
        : <button className="btn btn-primary btn-sm" style={{ marginTop: 14 }} onClick={run}><Sparkles className="icon" aria-hidden />Write a shorter version</button>)}
      {res && <>
        <div className="stat-grid" style={{ marginTop: 16 }}>
          <div className="stat"><b className="num">{res.before.toLocaleString('en-US')}</b><span>tokens now, estimated</span></div>
          <div className="stat"><b className="num ok">{res.after.toLocaleString('en-US')}</b><span>tokens after ({res.before ? Math.round((1 - res.after / res.before) * 100) : 0}% fewer)</span></div>
        </div>
        {rec?.saving && <p className="small" style={{ marginTop: 10 }}>About {fmt(rec.saving.low)} to {fmt(rec.saving.high)} a month at the current volume, estimated.</p>}
        <p className="xs dim" style={{ marginTop: 6 }}>{res.method === 'llm' ? 'Rewritten by Claude and checked against the original.' : 'Rewritten with deterministic rules: repeated sentences and filler removed.'}</p>
        <h4>Instructions found: {kept} of {res.checklist.length} kept</h4>
        <div className="stack" style={{ gap: 6 }}>
          {res.checklist.slice(0, 40).map((c, i) => (
            <div key={i} className="small" style={{ display: 'grid', gridTemplateColumns: '18px 1fr', gap: 8 }}>
              <span className={c.kept ? 'ok' : 'bad'} aria-label={c.kept ? 'kept' : 'missing'}>{c.kept ? '✓' : '!'}</span>
              <span><span>{c.instruction.slice(0, 160)}</span>{c.where && <span className="dim xs" style={{ display: 'block' }}>Now: {c.where.slice(0, 140)}</span>}</span>
            </div>
          ))}
        </div>
        <h4>Side by side</h4>
        <div className="side">
          <pre className="code wrap-lines" style={{ padding: 10 }} aria-label="Original">{res.original}</pre>
          <pre className="code wrap-lines" style={{ padding: 10 }} aria-label="Rewrite">{res.rewrite}</pre>
        </div>
        {rec && <button className="btn btn-primary btn-sm" style={{ marginTop: 14 }} onClick={() => select({ kind: 'rec', id: rec.id })}>Go to the recommendation</button>}
      </>}
    </>
  );
}

export type { GraphNode, Finding };
