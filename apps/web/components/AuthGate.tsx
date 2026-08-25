'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, supabaseConfigured } from '../lib/supabase';

/**
 * Email + password auth against Supabase.
 *
 * Deliberately minimal: this exists so the fan-out has a real user to attribute
 * usage and enforce budgets against. RLS keys off the same session, so signing
 * in is what makes every row this learner creates visible only to them.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!supabase) {
      setReady(true);
      return;
    }
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, next) => setSession(next));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!supabaseConfigured) {
    return (
      <div className="auth">
        <h1>Supabase is not configured</h1>
        <p className="muted">
          Run <code>npm run db:start</code>, then copy the printed URL and anon key into{' '}
          <code>.env</code> as <code>NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
          <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>.
        </p>
      </div>
    );
  }

  if (!ready) return <div className="shell"><p className="skeleton">Loading…</p></div>;
  if (!session) return <SignIn />;

  return <>{children}</>;
}

function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (mode: 'in' | 'up') => {
    if (!supabase) return;
    setBusy(true);
    setError(null);
    setMessage(null);

    const result =
      mode === 'in'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

    if (result.error) setError(result.error.message);
    else if (mode === 'up' && !result.data.session) {
      setMessage('Check your email to confirm the account, then sign in.');
    }
    setBusy(false);
  };

  return (
    <div className="auth">
      <h1>Sign in</h1>
      <p className="muted">Your projects and progress are tied to your account.</p>

      <label htmlFor="email">Email</label>
      <input
        id="email"
        className="textinput"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <label htmlFor="password">Password</label>
      <input
        id="password"
        className="textinput"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />

      {error && <div className="notice error">{error}</div>}
      {message && <div className="notice info">{message}</div>}

      <button className="btn primary" disabled={busy || !email || !password} onClick={() => void submit('in')}>
        {busy ? 'Working…' : 'Sign in'}
      </button>
      <button className="btn ghost" disabled={busy || !email || !password} onClick={() => void submit('up')}
        style={{ width: '100%', marginTop: 8 }}>
        Create an account
      </button>
    </div>
  );
}
