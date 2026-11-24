'use client';
import { Github } from 'lucide-react';
import { useState } from 'react';
import { signInUrl, type Me } from '../lib/client';

/** Account form: create an account or sign in with email and password. Everyone needs an account. */
export default function SignIn({ me, next = '/start', initialMode = 'signup' }: { me: Me; next?: string; initialMode?: 'signup' | 'login' }) {
  const [mode, setMode] = useState<'signup' | 'login'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError('Enter a valid email address.'); return; }
    if (password.length < 8) { setError('Use a password of at least 8 characters.'); return; }
    setBusy(true);
    try {
      const res = await fetch(`/auth/${mode}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, name, next }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Something went wrong. Try again.');
      location.href = data.next ?? next;
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };

  return (
    <div className="signin-box">
      <div>
        <h3>{mode === 'signup' ? 'Create your account' : 'Welcome back'}</h3>
        <p className="small muted" style={{ marginTop: 4 }}>{mode === 'signup' ? 'An account keeps your analyses private to you.' : 'Sign in to see your analyses.'}</p>
      </div>
      <form className="stack" onSubmit={submit} noValidate>
        {mode === 'signup' && (
          <div className="field"><label htmlFor="acc-name">Name</label>
            <input id="acc-name" className="input" autoComplete="name" value={name} onChange={e => setName(e.target.value)} placeholder="Optional" /></div>
        )}
        <div className="field"><label htmlFor="acc-email">Email</label>
          <input id="acc-email" className="input" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></div>
        <div className="field"><label htmlFor="acc-pw">Password</label>
          <input id="acc-pw" className="input" type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required minLength={8} value={password} onChange={e => setPassword(e.target.value)} />
          {mode === 'signup' && <p className="hint">At least 8 characters.</p>}</div>
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>{busy ? 'One moment…' : mode === 'signup' ? 'Create account' : 'Sign in'}</button>
      </form>
      <p className="small muted">
        {mode === 'signup' ? 'Already have an account? ' : 'New to Arcwise? '}
        <button type="button" className="btn btn-quiet btn-sm" style={{ padding: '0 4px', color: 'var(--text-accent)' }} onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setError(null); }}>
          {mode === 'signup' ? 'Sign in' : 'Create an account'}
        </button>
      </p>
      {me.auth.github && <a className="btn" href={signInUrl(next)} style={{ justifySelf: 'start' }}><Github className="icon" aria-hidden />Continue with GitHub</a>}
      {me.auth.dev && (
        <form method="post" action={`/auth/guest?next=${encodeURIComponent(next)}`}><button className="btn btn-quiet btn-sm" type="submit">Continue as guest</button></form>
      )}
    </div>
  );
}
