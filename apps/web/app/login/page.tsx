'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { supabase, supabaseConfigured } from '../../lib/supabase';
import { BrandLogo } from '@/components/BrandLogo';

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="shell text-center" style={{ marginTop: '100px' }}><p className="skeleton">Loading authentication...</p></div>}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextUrl = searchParams.get('next') || '/ask';
  const modeParam = searchParams.get('mode') || searchParams.get('tab');

  const [mode, setMode] = useState<'in' | 'up'>(
    modeParam === 'signup' || modeParam === 'up' || modeParam === 'register' ? 'up' : 'in',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const m = searchParams.get('mode') || searchParams.get('tab');
    if (m === 'signup' || m === 'up' || m === 'register') {
      setMode('up');
      setError(null);
      setMessage(null);
    } else if (m === 'signin' || m === 'in' || m === 'login') {
      setMode('in');
      setError(null);
      setMessage(null);
    }
  }, [searchParams]);

  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        router.replace(nextUrl);
      }
    });
  }, [router, nextUrl]);

  if (!supabaseConfigured) {
    return (
      <main className="shell auth-page-container">
        <div className="auth glassmorphic-card">
          <div className="auth-header">
            <BrandLogo height={40} />
            <h1>Configuration Required</h1>
            <p className="muted">
              Supabase credentials not detected in environment. Start your local Supabase instance or check <code>.env.local</code>.
            </p>
          </div>
          <div style={{ textAlign: 'center', marginTop: '20px' }}>
            <Link href="/" className="btn ghost">← Back to Home</Link>
          </div>
        </div>
      </main>
    );
  }

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!supabase || !email || !password) return;
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const result =
        mode === 'in'
          ? await supabase.auth.signInWithPassword({ email, password })
          : await supabase.auth.signUp({ email, password });

      if (result.error) {
        setError(result.error.message);
      } else if (mode === 'up' && !result.data.session) {
        setMessage('Account created successfully! Please sign in with your credentials.');
        setMode('in');
      } else if (result.data.session) {
        router.replace(nextUrl);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="shell auth-page-container">
      <div className="auth-glow-backdrop" />
      <div className="auth glassmorphic-card auth-standalone-card">
        <div className="auth-header">
          <Link href="/" className="auth-brand-link">
            <BrandLogo height={40} />
          </Link>
          
          <div className="auth-tabs-toggle">
            <button
              type="button"
              className={`auth-tab-btn ${mode === 'in' ? 'active' : ''}`}
              onClick={() => { setMode('in'); setError(null); setMessage(null); }}
            >
              Sign In
            </button>
            <button
              type="button"
              className={`auth-tab-btn ${mode === 'up' ? 'active' : ''}`}
              onClick={() => { setMode('up'); setError(null); setMessage(null); }}
            >
              Create Account
            </button>
          </div>

          <p className="muted auth-subtitle">
            {mode === 'in' 
              ? 'Access your 4-agent workspaces, adaptive projects, and execution sandboxes.'
              : 'Start your personalized AI engineering learning journey with zero setup.'}
          </p>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className="field-group">
            <label htmlFor="email">Email Address</label>
            <input
              id="email"
              className="textinput"
              type="email"
              autoComplete="email"
              placeholder="developer@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="field-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              className="textinput"
              type="password"
              autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
              placeholder="••••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error && <div className="notice error">{error}</div>}
          {message && <div className="notice info">{message}</div>}

          <button
            type="submit"
            className="btn primary auth-submit-btn"
            disabled={busy || !email || !password}
          >
            {busy ? (
              <span className="btn-loading">
                <span className="spinner-dots" /> Authenticating…
              </span>
            ) : mode === 'in' ? (
              'Sign In to Workspace →'
            ) : (
              'Create Free Account →'
            )}
          </button>
        </form>

        <div className="auth-footer-nav">
          <Link href="/" className="auth-back-link">
            ← Back to Product Overview
          </Link>
          <Link href="/about" className="auth-back-link">
            Learn about the architecture
          </Link>
        </div>
      </div>
    </main>
  );
}
