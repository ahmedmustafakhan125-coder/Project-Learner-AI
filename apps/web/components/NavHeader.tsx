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

  const navItems = [
    { href: '/ask', label: '4-Agent Workspace', icon: '✨' },
    { href: '/projects', label: 'Projects Library', icon: '📂' },
    { href: '/projects/new', label: 'New Blueprint', icon: '⚡' },
  ];

  return (
    <header className="lumina-navbar">
      <div className="lumina-nav-container">
        <Link href="/ask" className="lumina-brand">
          <div className="lumina-logo-icon">
            <span className="logo-spark">✦</span>
          </div>
          <div className="lumina-brand-text">
            <span className="brand-title">Project <span>Learner</span></span>
            <span className="brand-badge">AI</span>
          </div>
        </Link>

        <nav className="lumina-nav-links">
          {navItems.map((item) => {
            const isActive = pathname === item.href || (item.href !== '/ask' && pathname?.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`lumina-nav-link ${isActive ? 'active' : ''}`}
              >
                <span className="nav-icon">{item.icon}</span>
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
            <div className="user-indicator guest">
              <span className="status-dot" />
              <span>Guest</span>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
