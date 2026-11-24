'use client';
import { CheckCircle2, Printer, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, money, shortDate } from '../lib/client';
import type { ValidationReport } from '../lib/types';
import DockNav from './DockNav';
import World from './World';
import { CIChart } from './ui';

interface Shared { report: ValidationReport; repo: string; title: string | null; usesShorterPrompt: boolean; callsPerMonth: number | null; pricingAsOf: string }

/** Public, shareable validation report. Shows the evidence, never source code. Amounts in USD. */
export default function Report({ vid }: { vid: string }) {
  const [d, setD] = useState<Shared | null | false>(null);
  useEffect(() => { api<Shared>(`/reports/${vid}`).then(setD).catch(() => setD(false)); }, [vid]);
  const fmt = (usd: number) => money(usd, { currency: 'USD', fxRate: 1 });
  const v = d ? d.report : null;

  return (
    <>
      <World ghost="PROOF" /><DockNav />
      <main className="report above">
        {d === null && <div className="skel" style={{ height: 240 }} />}
        {d === false && <div className="empty"><h2>Report not found</h2><p>This validation report does not exist on this server, or the link is incomplete.</p></div>}
        {d && v && (
          <>
            <div>
              <p className="kicker">Validation report · {d.repo}</p>
              <h1 style={{ marginTop: 6, fontSize: '1.6rem' }}>{d.title ?? 'Validation report'}</h1>
              <p className="mono xs dim" style={{ marginTop: 6 }}>{v.siteId}</p>
            </div>
            <div className={`verdict ${v.passed ? 'pass' : 'fail'}`}>
              {v.passed ? <CheckCircle2 size={26} className="ok" aria-hidden /> : <XCircle size={26} className="bad" aria-hidden />}
              <div>
                <h2>{v.passed ? 'Proven: quality held' : 'At risk: quality dropped'}</h2>
                <p className="prose" style={{ marginTop: 4, fontSize: '.98rem' }}>{v.passed
                  ? <>The lower end of the 95% interval ({v.ci[0].toFixed(1)}) is above the limit of −{v.delta} points. Verified saving: <b className="num">{fmt(v.monthlySaving)} per month</b>.</>
                  : <>The lower end of the 95% interval ({v.ci[0].toFixed(1)}) is below the limit of −{v.delta} points. No saving is counted.</>}</p>
              </div>
            </div>
            <section>
              <p className="kicker" style={{ marginBottom: 8 }}>What was tested</p>
              <dl className="kv">
                <dt>Current version</dt><dd><span className="mono">{v.baseline.model}</span>, {fmt(v.baseline.costPerCall)} per call (measured)</dd>
                <dt>Cheaper version</dt><dd><span className="mono">{v.candidate.model}</span>{d.usesShorterPrompt ? ' with the shorter prompt' : ''}, {fmt(v.candidate.costPerCall)} per call (measured)</dd>
                <dt>Inputs</dt><dd>{v.n} {v.inputsSource === 'synthetic' ? <span className="pill syn">synthetic, generated from the prompt</span> : 'real inputs uploaded by the team'}{v.errors ? `; ${v.errors} replays failed and are excluded` : ''}</dd>
                <dt>Scoring</dt><dd>{v.scoring}</dd>
                <dt>Run on</dt><dd>{shortDate(v.createdAt)}</dd>
              </dl>
            </section>
            <section>
              <p className="kicker" style={{ marginBottom: 8 }}>Quality difference: cheaper minus current, points out of 100</p>
              <CIChart mean={v.meanDiff} ci={v.ci} delta={v.delta} />
              <p className="small muted num">Mean {v.meanDiff.toFixed(2)}, 95% bootstrap interval {v.ci[0].toFixed(2)} to {v.ci[1].toFixed(2)}, from {v.n} paired samples.</p>
            </section>
            <section>
              <p className="kicker" style={{ marginBottom: 8 }}>{v.passed ? 'Example pairs, lowest scores first' : 'Failing examples'}</p>
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead><tr><th>Input</th><th>Current</th><th>Cheaper</th><th>Score</th></tr></thead>
                  <tbody>{v.examples.map((e, i) => <tr key={i}><td>{e.input}</td><td className="mono">{e.baseline}</td><td className="mono">{e.candidate}</td><td className="num">{e.score.toFixed(0)}</td></tr>)}</tbody>
                </table>
              </div>
            </section>
            <p className="xs dim">Prices are list prices as of {shortDate(d.pricingAsOf)}. The monthly saving uses measured token counts{d.callsPerMonth != null ? ` at ${d.callsPerMonth.toLocaleString('en-US')} calls per month` : ''}.</p>
          </>
        )}
      </main>
    </>
  );
}
