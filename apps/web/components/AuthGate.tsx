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
        <div className="auth-header">
          <div className="auth-logo-badge">
            <span className="logo-spark">✦</span>
          </div>
          <h1>Configuration Required</h1>
          <p className="muted">
            Run <code>npm run db:start</code>, then configure your Supabase URL and anon key.
          </p>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="shell" style={{ textAlign: 'center', marginTop: '120px' }}>
        <p className="skeleton">Initializing secure session…</p>
      </div>
    );
  }

  if (!session) return <SignIn />;

  return <>{children}</>;
}

function SignIn() {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!supabase || !email || !password) return;
    setBusy(true);
    setError(null);
    setMessage(null);

    const result =
      mode === 'in'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

    if (result.error) {
      setError(result.error.message);
    } else if (mode === 'up' && !result.data.session) {
      setMessage('Account created! Sign in with your credentials.');
      setMode('in');
    }
    setBusy(false);
  };

  return (
    <div className="auth">
      <div className="auth-header">
        <div className="auth-logo-badge">
          <span className="logo-spark">✦</span>
        </div>
        <h1>{mode === 'in' ? 'Welcome to Project Learner' : 'Create an Account'}</h1>
        <p className="muted">Your projects, code sandboxes, and learning progress stay synced.</p>
      </div>

      <form onSubmit={(e) => void submit(e)}>
        <label htmlFor="email">Email Address</label>
        <input
          id="email"
          className="textinput"
          type="email"
          autoComplete="email"
          placeholder="name@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          className="textinput"
          type="password"
          autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
          placeholder="Min 6 characters"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {error && <div className="notice error">{error}</div>}
        {message && <div className="notice info">{message}</div>}

        <button
          type="submit"
          className="btn primary"
          style={{ width: '100%', marginTop: '20px' }}
          disabled={busy || !email || !password}
        >
          {busy ? 'Connecting…' : mode === 'in' ? 'Sign in to Workspace' : 'Create Account'}
        </button>

        <div style={{ textAlign: 'center', marginTop: '16px' }}>
          <button
            type="button"
            className="btn ghost"
            style={{ fontSize: '13px' }}
            onClick={() => {
              setMode(mode === 'in' ? 'up' : 'in');
              setError(null);
              setMessage(null);
            }}
          >
            {mode === 'in' ? "Don't have an account? Create one" : 'Already have an account? Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
}
