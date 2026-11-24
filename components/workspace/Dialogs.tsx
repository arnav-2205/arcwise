'use client';
import { FileUp, KeyRound, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, shortDate, type Me } from '../../lib/client';
import type { Settings } from '../../lib/types';
import { useWS } from './context';

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="row"><h2>{title}</h2><span className="spacer" /><button className="drawer-close" style={{ position: 'static' }} onClick={onClose} aria-label="Close"><X className="icon" /></button></div>
        {children}
      </div>
    </div>
  );
}

/** Replay approval: what will run, on whose key, at what cost. Nothing runs until "Approve and run". */
export function ValidateDialog({ recId, onClose }: { recId: string; onClose: () => void }) {
  const { a, cfg, settings, fmt, toast, refresh } = useWS();
  const rec = a.recommendations.find(r => r.id === recId)!;
  const site = a.callSites.find(s => s.id === rec.siteId)!;
  const provider = /^Anthropic/.test(site.provider) ? 'anthropic' : 'openai';
  const providerName = provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
  const [keys, setKeys] = useState<{ openai: boolean; anthropic: boolean; canStore: boolean } | null>(null);
  const [key, setKey] = useState('');
  const [store, setStore] = useState(true);
  const [source, setSource] = useState<'upload' | 'synthetic'>('upload');
  const [inputs, setInputs] = useState<{ name: string; text: string; count: number } | null>(null);
  const [delta, setDelta] = useState(String(settings.defaultDelta));
  const [estimate, setEstimate] = useState<{ n: number; costUsd: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => { api<typeof keys>(`/analyses/${a.id}/keys`).then(setKeys).catch(() => {}); }, [a.id]);
  const n = source === 'upload' ? inputs?.count ?? 0 : 200;
  useEffect(() => {
    setEstimate(null);
    if (n < 50) return;
    api<{ n: number; costUsd: number }>(`/analyses/${a.id}/recommendations/${rec.id}/estimate`, { method: 'POST', json: { n } }).then(setEstimate).catch(e => setError((e as Error).message));
  }, [n, a.id, rec.id]);

  const pick = async (f: File) => {
    const text = await f.text();
    const count = text.split('\n').filter(l => l.trim()).length;
    setInputs({ name: f.name, text, count });
    setError(count < 50 ? `This file has ${count} lines. At least 50 inputs are needed; 200 is better.` : null);
  };

  const run = async () => {
    setError(null);
    const d = Number(delta);
    if (!(d > 0 && d <= 50)) { setError('Set the limit to a number of points between 0 and 50.'); return; }
    if (source === 'upload' && (!inputs || inputs.count < 50)) { setError('Upload a JSONL file with at least 50 inputs.'); return; }
    if (!keys?.[provider] && !key.trim()) { setError(`Add your ${providerName} API key. Replays run on your own account.`); return; }
    if (!estimate) { setError('The cost estimate is not ready yet.'); return; }
    setBusy(true);
    try {
      if (key.trim() && store && keys?.canStore) await api(`/analyses/${a.id}/keys`, { method: 'PUT', json: { provider, key: key.trim() } });
      await api(`/analyses/${a.id}/recommendations/${rec.id}/validate`, {
        method: 'POST',
        json: { inputs: source === 'upload' ? inputs!.text : undefined, synthetic: source === 'synthetic', key: key.trim() && !(store && keys?.canStore) ? key.trim() : undefined, delta: d, confirmedCostUsd: estimate.costUsd },
      });
      await refresh();
      toast('Replay started. Progress shows on the recommendation.');
      onClose();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <Modal title="Validate this saving" onClose={onClose}>
      <p className="muted">{rec.title}. Both versions run on the same inputs and their outputs are compared.</p>

      <div className="field">
        <span className="label">Test inputs</span>
        <div className="seg" role="group" aria-label="Test inputs" style={{ justifySelf: 'start' }}>
          <button aria-pressed={source === 'upload'} onClick={() => setSource('upload')}>Upload real inputs</button>
          <button aria-pressed={source === 'synthetic'} onClick={() => setSource('synthetic')} disabled={!cfg?.llm}>Generate synthetic</button>
        </div>
        {source === 'upload' ? (
          <>
            <input ref={file} type="file" accept=".jsonl,.json,.txt" hidden onChange={e => e.target.files?.[0] && pick(e.target.files[0])} />
            <button className="btn btn-sm" style={{ justifySelf: 'start' }} onClick={() => file.current?.click()}><FileUp className="icon" aria-hidden />{inputs ? `${inputs.name} (${inputs.count} lines)` : 'Choose a JSONL file'}</button>
            <p className="hint">One JSON object per line, like <code>{'{"input": "…", "label": "billing"}'}</code>. The label is optional. Secrets are redacted on upload. Up to 1,000 lines.</p>
          </>
        ) : <p className="hint">200 inputs written from the prompt and the calling code. The report labels them synthetic.{cfg?.llm ? '' : ' Needs an Anthropic key on the server.'}</p>}
      </div>

      <div className="field">
        <label htmlFor="pkey">{providerName} API key</label>
        {keys?.[provider] && !key ? <p className="small"><KeyRound className="icon ok" style={{ verticalAlign: -3, marginRight: 6 }} aria-hidden />A key is saved for this repository, encrypted.</p> : null}
        <input id="pkey" className="input mono" type="password" autoComplete="off" placeholder={keys?.[provider] ? 'Leave empty to use the saved key' : provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'} value={key} onChange={e => setKey(e.target.value)} />
        {keys?.canStore ? (
          <label className="row small muted"><input type="checkbox" checked={store} onChange={e => setStore(e.target.checked)} />Save it encrypted for later replays of this repository</label>
        ) : <p className="hint">This server has no encryption key set, so the key is used for this replay only and not stored.</p>}
      </div>

      <div className="field">
        <label htmlFor="delta">Quality limit (points out of 100)</label>
        <input id="delta" className="input input-sm num" style={{ maxWidth: 100 }} inputMode="decimal" value={delta} onChange={e => setDelta(e.target.value)} />
        <p className="hint">Passes only if the lower end of the 95% interval of the quality difference is above minus this number.</p>
      </div>

      {/* Approval card */}
      <div className="approval" role="group" aria-label="Approval">
        <span className="kicker" style={{ color: 'var(--warn)' }}>Needs your approval</span>
        <span className="tool">replay · {site.fn}</span>
        <dl className="args">
          <dt>current</dt><dd>{site.model}</dd>
          <dt>candidate</dt><dd>{rec.candidate?.model ?? site.model}{rec.candidate?.systemPrompt ? ' + shorter prompt' : ''}</dd>
          <dt>inputs</dt><dd>{n || '—'} {source === 'synthetic' ? '(synthetic)' : ''}</dd>
          <dt>billed to</dt><dd>your {providerName} account</dd>
          <dt>est. cost</dt><dd>{estimate ? fmt(estimate.costUsd) : n < 50 ? 'shown once there are 50 inputs' : '…'}{cfg?.llm && estimate ? ' + judge calls on the server key if output is free text' : ''}</dd>
        </dl>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn btn-quiet" onClick={onClose}>Deny</button>
        <button className="btn btn-warn" disabled={busy || !estimate} onClick={run}>{busy ? 'Starting…' : 'Approve and run'}</button>
      </div>
    </Modal>
  );
}

type Health = { label: string; state: 'ok' | 'warn' | 'off'; value: string };

/** Settings, framed into sections. Runtime status reads like a health check. */
export function SettingsDialog({ onClose, onSaved, me }: { onClose: () => void; onSaved: (s: Settings) => void; me?: Me | null }) {
  const { settings, toast, cfg } = useWS();
  const [fx, setFx] = useState(String(settings.fxRate));
  const [asOf, setAsOf] = useState(settings.fxAsOf);
  const [delta, setDelta] = useState(String(settings.defaultDelta));
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const r = Number(fx), d = Number(delta);
    if (!(r > 0)) { setError('Enter the number of rupees per US dollar.'); return; }
    if (!(d > 0 && d <= 50)) { setError('Set the default limit between 0 and 50 points.'); return; }
    try { onSaved(await api<Settings>('/settings', { method: 'PUT', json: { fxRate: r, fxAsOf: asOf, defaultDelta: d } })); toast('Settings saved.'); onClose(); }
    catch (e) { setError((e as Error).message); }
  };
  const health: Health[] = [
    { label: 'Signed in', state: me?.user ? 'ok' : 'off', value: me?.user ? `${me.user.login}${me.user.id.startsWith('guest:') ? ' (guest)' : ' via GitHub'}` : 'no' },
    { label: 'GitHub sign-in', state: cfg?.github ? 'ok' : 'warn', value: cfg?.github ? 'configured' : 'not configured' },
    { label: 'Claude explanations', state: cfg?.llm ? 'ok' : 'off', value: cfg?.llm ? 'on' : 'off: structure only' },
    { label: 'Saved provider keys', state: cfg?.canStoreKeys ? 'ok' : 'warn', value: cfg?.canStoreKeys ? 'encrypted at rest' : 'no encryption key' },
    { label: 'Price list', state: cfg?.stalePrices ? 'warn' : 'ok', value: cfg ? `as of ${shortDate(cfg.pricingAsOf)}${cfg.stalePrices ? `, ${cfg.stalePrices} to re-check` : ''}` : '…' },
  ];
  const color = { ok: 'var(--ok)', warn: 'var(--warn)', off: 'var(--text-faint)' };
  return (
    <Modal title="Settings" onClose={onClose}>
      <section className="section-frame">
        <header><span className="kicker">Money</span></header>
        <div className="body stack">
          <div className="field"><label htmlFor="fx">Exchange rate (INR per USD)</label><input id="fx" className="input num" inputMode="decimal" value={fx} onChange={e => setFx(e.target.value)} /></div>
          <div className="field"><label htmlFor="asof">Rate as of</label><input id="asof" className="input" type="date" value={asOf} onChange={e => setAsOf(e.target.value)} /></div>
        </div>
      </section>
      <section className="section-frame">
        <header><span className="kicker">Quality gate</span></header>
        <div className="body">
          <div className="field"><label htmlFor="dd">Default quality limit (points)</label><input id="dd" className="input num" inputMode="decimal" value={delta} onChange={e => setDelta(e.target.value)} /><p className="hint">Used for new replays. You can change it per replay.</p></div>
        </div>
      </section>
      <section>
        <p className="kicker" style={{ marginBottom: 6 }}>Runtime</p>
        <div className="health">
          {health.map(h => (
            <div key={h.label}>
              <i className="light" style={{ background: color[h.state] }} aria-hidden />
              <span>{h.label}</span>
              <span className="state" style={{ color: color[h.state] }}>{h.value}</span>
            </div>
          ))}
        </div>
      </section>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="actions"><button className="btn btn-quiet" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={save}>Save settings</button></div>
    </Modal>
  );
}
