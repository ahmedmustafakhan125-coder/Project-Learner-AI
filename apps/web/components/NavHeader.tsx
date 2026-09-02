'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

export function NavHeader() {
  const pathname = usePathname();
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, next) => setSession(next));
    return () => sub.subscription.unsubscribe();
  }, []);

  const handleSignOut = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
  };

  const publicNavItems = [
    { href: '/', label: 'Home' },
    { href: '/about', label: 'About' },
  ];

  const authNavItems = [
    { href: '/', label: 'Home' },
    { href: '/ask', label: 'Workspace' },
    { href: '/projects', label: 'Projects' },
    { href: '/about', label: 'About' },
  ];

  const currentNavItems = session ? authNavItems : publicNavItems;

  return (
    <header className="lumina-navbar">
      <div className="lumina-nav-container">
        <Link href="/" className="lumina-brand">
          <div className="lumina-logo-icon">
            <span className="logo-spark">✦</span>
          </div>
          <div className="lumina-brand-text">
            <span className="brand-title">Project <span>Learner</span></span>
            <span className="brand-badge">AI</span>
          </div>
        </Link>

        <nav className="lumina-nav-links">
          {currentNavItems.map((item) => {
            const isActive =
              item.href === '/'
                ? pathname === '/'
                : pathname === item.href || (item.href !== '/' && pathname?.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`lumina-nav-link ${isActive ? 'active' : ''}`}
              >
                <span>{item.label}</span>
                {isActive && <span className="active-pill" />}
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
