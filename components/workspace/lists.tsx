'use client';
import { AlertTriangle, BookOpenCheck, Coins, FileUp, FlaskConical, GitCompare, Network, ShieldCheck, Sparkles, Upload } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { api, basename, compact, shortDate } from '../../lib/client';
import { headlineSavings, mid } from '../../lib/savings';
import type { Analysis, Finding, Severity } from '../../lib/types';
import { LAYERS, SEV_COLOR, SEV_RANK } from '../theme';
import { Empty, Est, QualityPill, SevPill } from '../ui';
import { useWS } from './context';

export const isDismissed = (a: Analysis, f: Finding) => a.feedback[f.id] === 'false_positive' || a.feedback[f.id] === 'fixed';
export const totalCost = (a: Analysis) => a.callSites.reduce((s, c) => s + (c.monthlyCostUsd ?? 0), 0);
const lines = (f: Finding) => (f.lines[0] === f.lines[1] ? `${f.lines[0]}` : `${f.lines[0]}-${f.lines[1]}`);

/* ---------------- Overview ---------------- */
export function OverviewList() {
  const { a, fmt, setTab, cfg } = useWS();
  const active = a.findings.filter(f => !isDismissed(a, f));
  const sev = (s: Severity) => active.filter(f => f.severity === s).length;
  const h = headlineSavings(a.recommendations, a.ledger);
  const unknownPrice = a.callSites.filter(s => s.monthlyCostUsd == null).length;
  const allUsage = a.callSites.length > 0 && a.callSites.every(s => s.callsSource === 'usage');
  return (
    <>
      <p className="kicker">Overview</p>
      <p className="prose" style={{ margin: '6px 0 16px' }}>{a.overview?.description}</p>
      <dl className="kv">
        <dt>Languages</dt><dd>{a.overview?.languages.map(l => `${l.name} (${l.files})`).join(', ')}</dd>
        {!!a.overview?.frameworks.length && <><dt>Frameworks</dt><dd>{a.overview.frameworks.join(', ')}</dd></>}
        <dt>Layers</dt><dd>{LAYERS.filter(l => a.graph?.nodes.some(n => n.layer === l.key)).map(l => `${l.name} ${a.graph!.nodes.filter(n => n.layer === l.key).length}`).join(', ')}</dd>
        <dt>Size</dt><dd className="num">{a.overview?.fileCount} files, {a.overview?.loc.toLocaleString('en-US')} lines</dd>
      </dl>
      <h3>At a glance</h3>
      <div style={{ borderTop: '1px solid var(--background-modifier-border)' }}>
        <button className="metric" onClick={() => setTab('understand')}>
          <span className="row muted small"><Network className="icon" aria-hidden />How it works</span>
          <b className="num">{a.graph?.flows.length ?? 0} flows</b>
          <span className="small muted num">{a.graph?.nodes.length} modules · {a.graph?.edges.length} links</span>
        </button>
        <button className="metric" onClick={() => setTab('risks')}>
          <span className="row muted small"><AlertTriangle className="icon" aria-hidden />Risks</span>
          <b className="num">{active.length} findings</b>
          <span className="row wrap-ok small num" style={{ gap: 12 }}>
            {(['critical', 'high', 'medium', 'low'] as Severity[]).map(s => <span key={s} style={{ color: SEV_COLOR[s] }}>{sev(s)} {s}</span>)}
          </span>
        </button>
        <button className="metric" onClick={() => setTab('cost')}>
          <span className="row muted small"><Coins className="icon" aria-hidden />AI cost per month{!allUsage && <Est />}</span>
          <b className="num">{fmt(totalCost(a))}</b>
          <span className="row wrap-ok small num" style={{ gap: 12 }}>
            <span className="muted">{a.callSites.length} AI call sites</span>
            <span className="ok">{fmt(h.proven)} proven</span>
            <span className="muted">{fmt(h.unvalidated)} not yet validated</span>
          </span>
          {unknownPrice > 0 && <span className="xs dim">{unknownPrice} call site{unknownPrice > 1 ? 's have' : ' has'} no known price and {unknownPrice > 1 ? 'are' : 'is'} not in this total.</span>}
        </button>
      </div>
      {a.changes && (a.changes.added.length + a.changes.modified.length + a.changes.removed.length > 0) && (
        <>
          <h3><GitCompare className="icon" style={{ verticalAlign: -3, marginRight: 6 }} aria-hidden />Changed since the last analysis</h3>
          <p className="small muted num">{a.changes.modified.length} modified, {a.changes.added.length} added, {a.changes.removed.length} removed.</p>
        </>
      )}
      <h3>This analysis</h3>
      <p className="small muted">
        {a.llm.used
          ? <>Summaries by Claude. Used {compact(a.llm.inputTokens)} input and {compact(a.llm.outputTokens)} output tokens{a.llm.costUsd != null ? <>, about {fmt(a.llm.costUsd)}</> : null}.</>
          : <>Summaries come from the code structure. {cfg && !cfg.llm ? 'Set ANTHROPIC_API_KEY and model ids on the server for written explanations.' : ''}</>}
      </p>
      {a.warnings.map((w, i) => <p key={i} className="notice" style={{ marginTop: 8 }}>{w}</p>)}
    </>
  );
}

/* ---------------- Understand ---------------- */
export function UnderstandList() {
  const { a, sel, select, search, tour, setTour } = useWS();
  const q = search.trim().toLowerCase();
  const nodes = a.graph?.nodes ?? [];
  const flows = a.graph?.flows ?? [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  return (
    <>
      <h2>How it works</h2>
      <p className="muted" style={{ marginBottom: 8 }}>Click a node on the map or a file below. Each one is explained in plain English.</p>
      {tour ? (() => {
        const f = flows[tour.flow], id = f.steps[tour.step], n = byId.get(id);
        return (
          <>
            <h3>{f.name}</h3>
            <div className="section-frame"><div className="body">
              <p className="kicker num">Step {tour.step + 1} of {f.steps.length}</p>
              <p className="mono" style={{ fontWeight: 600, margin: '4px 0 6px', overflowWrap: 'anywhere', fontSize: '.88rem' }}>{n?.id}</p>
              <p className="prose" style={{ marginBottom: 14, fontSize: '.98rem' }}>{n?.summary}</p>
              <div className="row wrap-ok">
                <button className="btn btn-sm" disabled={tour.step === 0} onClick={() => setTour({ ...tour, step: tour.step - 1 })}>Back</button>
                <button className="btn btn-primary btn-sm" disabled={tour.step === f.steps.length - 1} onClick={() => setTour({ ...tour, step: tour.step + 1 })}>Next step</button>
                <button className="btn btn-quiet btn-sm" onClick={() => setTour(null)}>Leave tour</button>
                <button className="btn btn-quiet btn-sm" onClick={() => select({ kind: 'node', id })}>Open file</button>
              </div>
            </div></div>
          </>
        );
      })() : (
        <>
          <h3>Guided tours</h3>
          {flows.length ? (
            <div className="rows">
              {flows.map((f, i) => (
                <button key={i} className="item" onClick={() => setTour({ flow: i, step: 0 })}>
                  <span className="item-title"><BookOpenCheck className="icon dim" style={{ verticalAlign: -3, marginRight: 8 }} aria-hidden />{f.name}</span>
                  <span className="item-meta">{f.steps.length} steps, in dependency order</span>
                </button>
              ))}
            </div>
          ) : <p className="small muted">No entry points with dependencies were found, so there are no tours.</p>}
        </>
      )}
      {LAYERS.map(L => {
        const items = nodes.filter(n => n.layer === L.key && (!q || `${n.id} ${n.summary}`.toLowerCase().includes(q)));
        if (!items.length) return null;
        return (
          <div key={L.key}>
            <h3 style={{ color: L.color }}>{L.name} <span className="dim num">{items.length}</span></h3>
            <div className="rows">
              {items.slice(0, 300).map(n => (
                <button key={n.id} className="item" aria-current={sel?.kind === 'node' && sel.id === n.id} onClick={() => select({ kind: 'node', id: n.id })}>
                  <span className="item-title">{n.name}</span>
                  <span className="item-path">{n.id}</span>
                </button>
              ))}
              {items.length > 300 && <p className="xs dim">{items.length - 300} more. Use search to narrow the list.</p>}
            </div>
          </div>
        );
      })}
      {q && !nodes.some(n => `${n.id} ${n.summary}`.toLowerCase().includes(q)) && <p className="muted small" style={{ marginTop: 16 }}>No file matches &ldquo;{search}&rdquo;. Try part of a file name or a word from its summary.</p>}
    </>
  );
}

/* ---------------- Risks ---------------- */
export function RisksList() {
  const { a, sel, select, search } = useWS();
  const [sev, setSev] = useState<Severity | 'all'>('all');
  const [source, setSource] = useState<'all' | 'rule' | 'llm'>('all');
  const [sort, setSort] = useState<'severity' | 'confidence' | 'category'>('severity');
  const [showDismissed, setShowDismissed] = useState(false);
  const conf = { high: 3, medium: 2, low: 1 };
  const q = search.trim().toLowerCase();
  const list = useMemo(() => a.findings
    .filter(f => (sev === 'all' || f.severity === sev) && (source === 'all' || f.source === source) && (showDismissed || !isDismissed(a, f)))
    .filter(f => !q || `${f.title} ${f.file} ${f.category}`.toLowerCase().includes(q))
    .sort((x, y) => sort === 'severity' ? SEV_RANK[y.severity] - SEV_RANK[x.severity] || conf[y.confidence] - conf[x.confidence]
      : sort === 'confidence' ? conf[y.confidence] - conf[x.confidence] || SEV_RANK[y.severity] - SEV_RANK[x.severity]
        : x.category.localeCompare(y.category)), [a, sev, source, sort, showDismissed, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = a.findings.filter(f => !isDismissed(a, f));
  const dismissed = a.findings.length - active.length;
  return (
    <>
      <h2>Where it might break</h2>
      <p className="muted">{active.length} open finding{active.length === 1 ? '' : 's'}. Each one cites a file and line range that were checked against the code. Select one to see what depends on it.</p>
      <div className="toolbar">
        {(['all', 'critical', 'high', 'medium', 'low'] as const).map(s => (
          <button key={s} className="toggle-chip" aria-pressed={sev === s} onClick={() => setSev(s)}>
            {s === 'all' ? 'All' : `${s[0].toUpperCase() + s.slice(1)} ${active.filter(f => f.severity === s).length}`}
          </button>
        ))}
      </div>
      <div className="toolbar">
        <span>Source</span>
        {([['all', 'All'], ['rule', 'Rules'], ['llm', 'AI review']] as const).map(([k, l]) => <button key={k} className="toggle-chip" aria-pressed={source === k} onClick={() => setSource(k)}>{l}</button>)}
        <span style={{ marginLeft: 8 }}>Sort</span>
        {([['severity', 'Severity'], ['confidence', 'Confidence'], ['category', 'Category']] as const).map(([k, l]) => <button key={k} className="toggle-chip" aria-pressed={sort === k} onClick={() => setSort(k)}>{l}</button>)}
      </div>
      {dismissed > 0 && <button className="btn btn-quiet btn-xs" onClick={() => setShowDismissed(!showDismissed)}>{showDismissed ? 'Hide' : 'Show'} {dismissed} marked fixed or false positive</button>}
      <div className="rows" style={{ marginTop: 10 }}>
        {list.map(f => (
          <button key={f.id} className={`item${isDismissed(a, f) ? ' dismissed' : ''}`} aria-current={sel?.kind === 'finding' && sel.id === f.id} onClick={() => select({ kind: 'finding', id: f.id })}>
            <span className="item-top"><span className="item-title">{f.title}</span><SevPill s={f.severity} /></span>
            <span className="item-path">{f.file}:{lines(f)}</span>
            <span className="item-meta">
              <span>{f.category}</span><span>{f.confidence} confidence</span><span>{f.source === 'llm' ? 'AI review' : 'Rule'}</span>
              {a.feedback[f.id] && <span className="ok">{{ accepted: 'Accepted', false_positive: 'False positive', fixed: 'Fixed' }[a.feedback[f.id]]}</span>}
            </span>
          </button>
        ))}
        {!list.length && <Empty icon={<ShieldCheck aria-hidden />}>{a.findings.length ? 'No findings match these filters.' : 'No findings. The rules found nothing to flag in this code.'}</Empty>}
      </div>
    </>
  );
}

/* ---------------- Cost ---------------- */
type CostView = 'sites' | 'prompts' | 'recs' | 'ledger' | 'usage';

export function CostList() {
  const ws = useWS();
  const { a, fmt, sel, select, search } = ws;
  const [view, setView] = useState<CostView>('sites');
  const total = totalCost(a);
  const h = headlineSavings(a.recommendations, a.ledger);
  const q = search.trim().toLowerCase();
  const sites = [...a.callSites].filter(s => !q || `${s.fn} ${s.file} ${s.model} ${s.provider}`.toLowerCase().includes(q)).sort((x, y) => (y.monthlyCostUsd ?? -1) - (x.monthlyCostUsd ?? -1));
  const allUsage = a.callSites.length > 0 && a.callSites.every(s => s.callsSource === 'usage');

  if (!a.callSites.length) return (
    <>
      <h2>AI cost</h2>
      <Empty icon={<Coins aria-hidden />}>Arcwise found no calls to an AI model in this repository. It looks for OpenAI, Anthropic, Google, the Vercel AI SDK, LangChain, LiteLLM and direct HTTP calls to those APIs.</Empty>
    </>
  );
  return (
    <>
      <h2>AI cost</h2>
      <div className="metric" style={{ borderBottom: 0, paddingBottom: 4 }}>
        <span className="row"><span className="kicker">Per month</span>{!allUsage && <Est />}</span>
        <b className="num">{fmt(total)}</b>
        <span className="row wrap-ok small num" style={{ gap: 14 }}>
          <span className="ok">{fmt(h.proven)} proven saving</span>
          <span className="muted">{fmt(h.unvalidated)} not yet validated</span>
        </span>
      </div>
      <nav className="subnav" role="tablist" aria-label="Cost views">
        {([['sites', 'Call sites'], ['prompts', 'System prompts'], ['recs', 'Recommendations'], ['ledger', 'Savings ledger'], ['usage', 'Usage data']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={view === k} onClick={() => setView(k)}>{l}</button>
        ))}
      </nav>

      {view === 'sites' && (
        <div className="rows">
          {sites.map(s => (
            <button key={s.id} className="item" aria-current={sel?.kind === 'site' && sel.id === s.id} onClick={() => select({ kind: 'site', id: s.id })}>
              <span className="item-top"><span className="item-title">{s.fn}</span><span className="num">{s.monthlyCostUsd == null ? <span className="dim">no price</span> : fmt(s.monthlyCostUsd)}</span></span>
              <span className="item-path">{s.file} · {s.provider} {s.api} · {s.model}</span>
              {s.monthlyCostUsd != null && total > 0 && <span className="share"><i style={{ width: `${(s.monthlyCostUsd / total) * 100}%` }} /></span>}
              <span className="item-meta num">
                <QualityPill q={s.quality} />
                {total > 0 && s.monthlyCostUsd != null && <span>{((s.monthlyCostUsd / total) * 100).toFixed(0)}% of spend</span>}
                <span>{compact(s.callsPerMonth)} calls/mo {s.callsSource === 'default' ? '(default)' : s.callsSource === 'usage' ? '(usage)' : ''}</span>
                <span>{compact(s.inputTokens)} in / {compact(s.outputTokens)} out</span>
              </span>
              {!!s.flags.length && <span className="chips">{s.flags.map(f => <span key={f} className="chip">{f}</span>)}</span>}
            </button>
          ))}
          <p className="xs dim">Volumes start at a default of 10,000 calls a month per call site. Open a call site to set its real volume, or import usage data.</p>
        </div>
      )}

      {view === 'prompts' && (() => {
        const withPrompt = a.callSites.filter(s => s.systemPrompt).sort((x, y) => y.systemPrompt!.tokens - x.systemPrompt!.tokens);
        const other = (a.prompts ?? []).filter(x => !x.usedBy);
        if (!withPrompt.length && !other.length) return <Empty icon={<Sparkles aria-hidden />}>No system prompts were found in the code.</Empty>;
        return (
          <div className="rows">
            {withPrompt.map(s => {
              const share = s.monthlyCostUsd && total ? (s.systemPrompt!.tokens / Math.max(1, s.inputTokens)) * (s.monthlyCostUsd / total) * 100 : null;
              return (
                <div key={s.id} className="item">
                  <span className="item-top"><span className="item-title">{s.fn}</span><span className="num">{s.systemPrompt!.tokens.toLocaleString('en-US')} tokens</span></span>
                  <span className="item-path">{s.systemPrompt!.source} · {s.systemPrompt!.static ? 'static' : 'has placeholders'}</span>
                  <span className="item-meta num"><Est>tokens estimated</Est>{share != null && <span>about {share.toFixed(1)}% of total spend</span>}</span>
                  <span className="row" style={{ marginTop: 4 }}>
                    <button className="btn btn-ghost btn-xs" onClick={() => select({ kind: 'prompt', id: s.id })}><Sparkles className="icon" aria-hidden />Optimise</button>
                    <button className="btn btn-quiet btn-xs" onClick={() => select({ kind: 'site', id: s.id })}>Call site</button>
                  </span>
                </div>
              );
            })}
            {!!other.length && <>
              <h3>Other prompts in the code</h3>
              <p className="small muted" style={{ marginBottom: 6 }}>Found in the code but not linked to a detected call, for example chatbot prompts passed through a helper.</p>
              {other.map(x => (
                <div key={x.id} className="item">
                  <span className="item-top"><span className="item-title mono" style={{ fontSize: '.86rem' }}>{x.name}</span><span className="num">{x.tokens.toLocaleString('en-US')} tokens</span></span>
                  <span className="item-path">{x.file}:{x.line}</span>
                  <span className="small muted" style={{ whiteSpace: 'pre-wrap', maxHeight: 60, overflow: 'hidden' }}>{x.text.slice(0, 220)}{x.text.length > 220 ? '…' : ''}</span>
                </div>
              ))}
            </>}
            <p className="xs dim">Token counts use about 4 characters per token until the provider tokenizer is used.</p>
          </div>
        );
      })()}

      {view === 'recs' && (
        <div className="rows">
          <p className="small muted">The headline counts only the best option per call site, so nothing is counted twice. Only Proven items count as saved.</p>
          {[...a.recommendations].sort((x, y) => (y.saving ? mid(y.saving) : -1) - (x.saving ? mid(x.saving) : -1)).map(r => {
            const s = a.callSites.find(c => c.id === r.siteId);
            const v = a.validations.find(x => x.id === r.validationId);
            return (
              <button key={r.id} className="item" aria-current={sel?.kind === 'rec' && sel.id === r.id} onClick={() => select({ kind: 'rec', id: r.id })}>
                <span className="item-top"><span className="item-title">{r.title}</span><QualityPill q={r.status} /></span>
                <span className="item-path">{s?.fn} · {r.kind.replace('-', ' ')}</span>
                <span className="item-meta num">
                  {r.status === 'proven' && v ? <span className="ok">{fmt(v.monthlySaving)} per month, verified</span>
                    : r.status === 'atrisk' ? <span className="bad">Not counted: quality dropped</span>
                      : r.saving ? <span>{fmt(r.saving.low)} to {fmt(r.saving.high)} per month, estimated</span>
                        : <span>No saving claimed</span>}
                  <span>{r.qualityRisk} risk to quality</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {view === 'ledger' && (
        <>
          <p className="small muted" style={{ marginBottom: 12 }}>Every saving here passed the quality gate. This total is what performance-based pricing would bill against.</p>
          <div className="metric" style={{ borderBottom: 0 }}>
            <span className="kicker">Verified per month</span>
            <b className="num ok">{fmt(h.proven)}</b>
          </div>
          <h3>Entries</h3>
          {a.ledger.length ? (
            <div className="rows">
              {a.ledger.map(e => (
                <div key={e.id} className="item">
                  <span className="item-top"><span className="item-title">{e.title}</span><span className="num ok">{fmt(e.monthlySaving)}</span></span>
                  <span className="item-path">{e.siteId} · {shortDate(e.createdAt)}</span>
                  <a className="btn btn-ghost btn-xs" style={{ justifySelf: 'start' }} href={`/r/${e.validationId}`} target="_blank" rel="noreferrer">Open validation report</a>
                </div>
              ))}
            </div>
          ) : <Empty icon={<FlaskConical aria-hidden />} action={<button className="btn btn-ghost btn-sm" onClick={() => setView('recs')}>See recommendations</button>}>The ledger is empty. A saving is added here only after its replay passes the quality gate.</Empty>}
        </>
      )}

      {view === 'usage' && <UsageImport />}

      <p className="xs dim" style={{ marginTop: 20 }}>Prices are list prices as of {shortDate(a.pricingAsOf)}. Currency rate {ws.settings.fxRate} INR per USD as of {shortDate(ws.settings.fxAsOf)}.</p>
    </>
  );
}

function UsageImport() {
  const { a, setA, toast } = useWS();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (file: File) => {
    if (file.size > 20 * 1024 * 1024) { toast('That file is over 20 MB. Export a shorter date range.'); return; }
    setBusy(true);
    try {
      const r = await api<{ analysis: Analysis; matched: string[]; unmatched: string[] }>(`/analyses/${a.id}/usage`, { method: 'POST', json: { name: file.name, text: await file.text() } });
      setA(r.analysis);
      toast(r.matched.length ? `Imported. Real volumes now used for ${r.matched.join(', ')}.${r.unmatched.length ? ` No call site uses ${r.unmatched.join(', ')}.` : ''}` : `Imported, but no call site uses ${r.unmatched.join(', ')}.`);
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  return (
    <>
      <p className="small muted" style={{ marginBottom: 12 }}>Replace estimated volumes and token counts with real ones. Arcwise reads OpenAI and Anthropic usage CSV exports, and Langfuse, Helicone or OpenTelemetry GenAI JSON.</p>
      <div className="empty">
        <FileUp aria-hidden />
        <p>Usage is matched to call sites by model. When several call sites use the same model, the volume is split evenly between them.</p>
        <input ref={input} type="file" accept=".csv,.json,application/json,text/csv" hidden onChange={e => e.target.files?.[0] && upload(e.target.files[0])} />
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => input.current?.click()}><Upload className="icon" aria-hidden />{busy ? 'Importing' : 'Upload usage export'}</button>
      </div>
      {!!a.usageImports.length && (
        <>
          <h3>Imported</h3>
          <div className="rows">
            {a.usageImports.map((u, i) => <div key={i} className="item"><span className="item-title">{u.name}</span><span className="item-meta num">{u.format} · {u.rows.toLocaleString('en-US')} rows · {shortDate(u.importedAt)}</span></div>)}
          </div>
        </>
      )}
    </>
  );
}

export { basename };
