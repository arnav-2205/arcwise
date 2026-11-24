'use client';
import { useMe } from '../lib/client';
import AnalyzeForm from './AnalyzeForm';
import DockNav from './DockNav';
import RecentAnalyses from './RecentAnalyses';
import SignIn from './SignIn';
import World from './World';

const ANSWERS: [string, string, string, string?][] = [
  ['How it works', 'Map every file.', 'Files become nodes in a graph you can explore. Open one for a plain-English summary, what it uses, what uses it, and the source.'],
  ['Risks', 'Line-exact findings.', 'Rules for TypeScript, JavaScript and Python, plus an optional AI review. Every finding cites lines checked against the code.'],
  ['AI cost', 'Every call, priced.', 'OpenAI, Anthropic, Google, OpenRouter, the AI SDK, LangChain and LiteLLM calls are found, their prompts resolved and priced.'],
  ['Quality gate', 'Proven, not promised.', 'A saving counts only after both versions run on the same inputs and quality holds inside your limit.', 'gate'],
];

const SHOTS: [string, string, string, boolean?][] = [
  ['overview', 'Overview', 'What the app does, its flows, risks and AI spend at a glance.', true],
  ['understand', 'Understand', 'A graph of every file and how they connect.'],
  ['risks', 'Risks', 'Findings with the exact lines and a suggested fix.'],
  ['cost', 'Cost', 'Every AI call priced, flagged and ready to optimise.', true],
];

/** /start: the app's front door, inside the same moss world as the homepage. */
export default function Landing() {
  const me = useMe();
  const next = typeof window !== 'undefined' ? location.pathname + location.search : '/start';
  return (
    <>
      <World ghost="ARCWISE" />
      <DockNav me={me} />
      <main className="above">
        <section className="start">
          <div>
            <h1>Start with a repository</h1>
            <p className="lede">Paste a GitHub link or open a sample. Arcwise reads the code, never runs it, and builds your map in about a minute.</p>
            <dl className="stats">
              <div><dt>Risks</dt><dd>line-exact</dd></div>
              <div><dt>AI savings</dt><dd>proven</dd></div>
              <div><dt>Your code</dt><dd>never executed</dd></div>
            </dl>
          </div>
          <div className="card-surface" id="analyze-card">
            {!me ? <div className="skel" style={{ height: 160 }} /> : me.user ? (
              <>
                <p className="kicker" style={{ marginBottom: 12 }}>Analyze</p>
                <AnalyzeForm />
              </>
            ) : <SignIn me={me} next={next} />}
          </div>
        </section>

        <section id="analyses" className="start-below" style={{ gridTemplateColumns: '1fr' }}>
          <div className="paper" style={{ padding: 24 }}>
            <p className="kicker" style={{ marginBottom: 12 }}>Your analyses</p>
            {!me ? <div className="skel" style={{ height: 60 }} /> : me.user ? <>
              <RecentAnalyses />
              <form method="post" action="/auth/logout" style={{ marginTop: 14 }}><button className="btn btn-quiet btn-sm" type="submit">Sign out of {me.user.login}</button></form>
            </> : (
              <div className="row wrap-ok" style={{ gap: 14 }}>
                <p className="muted" style={{ flex: '1 1 260px' }}>Sign in to keep a list of the repositories you have analyzed.</p>
                <a className="btn btn-primary" href="#analyze-card">Sign in above</a>
              </div>
            )}
          </div>
        </section>

        <section className="start-below" style={{ gridTemplateColumns: '1fr' }} aria-labelledby="sample-title">
          <div>
            <p className="kicker" style={{ color: 'rgba(255,255,255,.5)', marginBottom: 10 }}>Sample analysis</p>
            <h2 id="sample-title" style={{ color: '#fff', fontWeight: 300, fontSize: 'clamp(1.6rem, 2.6vw, 2.2rem)', marginBottom: 22 }}>What you get for a repository</h2>
            <div className="shots">
              {SHOTS.map(([file, title, text, wide]) => (
                <figure key={file} className={`paper shot${wide ? ' wide' : ''}`}>
                  <img src={`/landing-pages/shots/${file}.jpg`} alt={`${title}: ${text}`} loading="lazy" />
                  <figcaption><b>{title}</b> {text}</figcaption>
                </figure>
              ))}
            </div>
            <a className="btn btn-primary" style={{ marginTop: 22 }} href="/start?sample=helpdesk">Open this sample yourself</a>
          </div>
        </section>

        <section id="how" className="start-below" aria-label="What Arcwise answers">
          {ANSWERS.map(([label, title, body, id]) => (
            <article key={label} id={id} className="paper">
              <p className="label">{label}</p>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </section>
      </main>
    </>
  );
}
