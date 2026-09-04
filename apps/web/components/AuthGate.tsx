'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Session } from '@supabase/supabase-js';
import { supabase, supabaseConfigured } from '../lib/supabase';
import { BrandLogo } from './BrandLogo';

/**
 * Authentication Gate for protected workspace routes.
 *
 * Prompts user to authenticate or redirects to the dedicated /login page.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
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
      if (!data.session) {
        const nextUrl = pathname ? `/login?next=${encodeURIComponent(pathname)}` : '/login';
        router.replace(nextUrl);
      }
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_e, next) => {
      setSession(next);
      if (!next) {
        const nextUrl = pathname ? `/login?next=${encodeURIComponent(pathname)}` : '/login';
        router.replace(nextUrl);
      }
    });

    return () => sub.subscription.unsubscribe();
  }, [router, pathname]);

  if (!supabaseConfigured) {
    return (
      <div className="auth glassmorphic-card" style={{ maxWidth: '480px', margin: '80px auto' }}>
        <div className="auth-header">
          <BrandLogo height={40} />
          <h1>Configuration Required</h1>
          <p className="muted">
            Run <code>npm run db:start</code>, then configure your Supabase URL and anon key in <code>.env.local</code>.
          </p>
        </div>
        <div style={{ textAlign: 'center', marginTop: '20px' }}>
          <Link href="/" className="btn ghost">← Back to Home</Link>
        </div>
      </div>
    );
  }

  if (!ready || !session) {
    return (
      <div className="shell" style={{ textAlign: 'center', marginTop: '120px' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}><BrandLogo height={40} /></div>
        <p className="skeleton" style={{ fontSize: '15px' }}>
          {!ready ? 'Initializing secure session…' : 'Redirecting to Sign In…'}
        </p>
      </div>
    );
  }

  return <>{children}</>;
}

