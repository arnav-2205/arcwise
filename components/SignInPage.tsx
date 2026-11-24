'use client';
import { useEffect, useState } from 'react';
import { useMe } from '../lib/client';
import DockNav from './DockNav';
import SignIn from './SignIn';
import World from './World';

/** /signin: the account door, inside the moss world. ?mode=login|signup and ?next=/path are honoured. */
export default function SignInPage() {
  const me = useMe();
  const [q, setQ] = useState<{ next: string; mode: 'signup' | 'login' } | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    const n = p.get('next') ?? '/start';
    setQ({ next: n.startsWith('/') && !n.startsWith('//') ? n : '/start', mode: p.get('mode') === 'login' ? 'login' : 'signup' });
  }, []);
  useEffect(() => { if (me?.user && q) location.replace(q.next); }, [me, q]);
  return (
    <>
      <World ghost="ARCWISE" />
      <DockNav me={me} />
      <main className="above start" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,420px)' }}>
        <div>
          <h1>Your map starts with an account</h1>
          <p className="lede">Create an account once. Your analyses, findings and savings stay private to you.</p>
        </div>
        <div className="card-surface">{me && q && !me.user ? <SignIn me={me} next={q.next} initialMode={q.mode} /> : <div className="skel" style={{ height: 280 }} />}</div>
      </main>
    </>
  );
}
