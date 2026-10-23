'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { api } from '../lib/api';
import { isActive, navItemsFor } from '../lib/navLinks';
import { supabase } from '../lib/supabase';
import { BrandLogo } from './BrandLogo';
import { LearnerNav } from './nav/LearnerNav';

export function NavHeader() {
  const pathname = usePathname();
  const [session, setSession] = useState<Session | null>(null);
  // Follows the server's flag. Until it answers, the bar is the one from before
  // PROJECT_LEARNER, so with the flag off nothing about it ever changes.
  const [learner, setLearner] = useState(false);
  // The learner's own `profiles.display_name` (row-level security: own row only).
  const [displayName, setDisplayName] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, next) => setSession(next));
    return () => sub.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id ?? null;
  useEffect(() => {
    setDisplayName(null);
    if (!supabase || !userId) return;
    let live = true;
    void supabase
      .from('profiles')
      .select('display_name')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => {
        const value = typeof data?.display_name === 'string' ? data.display_name.trim() : '';
        if (live && value) setDisplayName(value);
      });
    return () => {
      live = false;
    };
  }, [userId]);

  useEffect(() => {
    let live = true;
    api
      .getFeatures()
      .then((features) => live && setLearner(features.projectLearner))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const handleSignOut = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
  };

  if (session && learner) {
    // The bar and the sidebar beside it.
    return (
      <LearnerNav
        name={displayName ?? session.user.email?.split('@')[0] ?? 'You'}
        email={session.user.email ?? null}
        onSignOut={() => void handleSignOut()}
      />
    );
  }

  const currentNavItems = navItemsFor(Boolean(session), false);

  return (
    <header className="lumina-navbar">
      <div className="lumina-nav-container">
        <Link href="/" className="lumina-brand">
          <BrandLogo height={46} />
        </Link>

        <nav className="lumina-nav-links">
          {currentNavItems.map((item) => {
            const href = item.href;
            const active = isActive(href, pathname);
            return (
              <Link
                key={href}
                href={href}
                className={`lumina-nav-link ${active ? 'active' : ''}`}
              >
                <span>{item.label}</span>
                {active && <span className="active-pill" />}
              </Link>
            );
          })}
        </nav>

        <div className="lumina-nav-actions">
          {session ? (
            <div className="lumina-user-menu">
              <div className="user-indicator">
                <span className="status-ping" />
                <span className="user-email">{session.user.email?.split('@')[0]}</span>
              </div>
              <button
                onClick={() => void handleSignOut()}
                className="btn-signout"
                title="Sign out"
              >
                Sign out
              </button>
            </div>
          ) : (
            <div className="guest-nav-actions">
              <Link href="/login?mode=signin" className="btn-nav-signin">
                Sign In
              </Link>
              <Link href="/login?mode=signup&next=/ask" className="btn-nav-getstarted">
                Get Started
              </Link>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
