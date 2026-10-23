'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { BrandLogo } from '../BrandLogo';
import { LEARNER_NAV_ITEMS } from '../../lib/navLinks';
import { MobileNav } from './MobileNav';
import { SideNav } from './SideNav';

/**
 * The frame for a signed-in learner with PROJECT_LEARNER on: a fixed bar with
 * the logo, and the sections down a left sidebar with the account at its foot.
 * Below 860px the sidebar folds into a drawer behind a menu button.
 *
 * The sidebar is a sibling of the bar, not a child: the bar's backdrop filter
 * makes it the containing block for anything fixed inside it, which would clip
 * the sidebar to the bar's 68px.
 *
 * `data-sidenav` on <html> is what makes room for it: pages move right of the
 * sidebar and the workspace's history moves to the right edge. Nothing sets
 * it with the flag off, so no page changes then.
 *
 * The account menu closes on Escape (focus goes back to its button), on a
 * click outside it, and on any route change.
 */

export interface LearnerNavProps {
  name: string;
  email: string | null;
  onSignOut: () => void;
}

export function LearnerNav({ name, email, onSignOut }: LearnerNavProps) {
  const pathname = usePathname();
  const [accountOpen, setAccountOpen] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const accountToggleRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setAccountOpen(false);
    setDrawer(false);
  }, []);

  useEffect(() => {
    close();
  }, [pathname, close]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.sidenav = 'on';
    return () => {
      delete root.dataset.sidenav;
    };
  }, []);

  useEffect(() => {
    if (!accountOpen && !drawer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      close();
      if (accountOpen) accountToggleRef.current?.focus();
    };
    // The drawer has its own backdrop; this is for the account menu.
    const onPointer = (event: PointerEvent) => {
      if (!drawer && accountRef.current && !accountRef.current.contains(event.target as Node)) setAccountOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [accountOpen, drawer, close]);

  return (
    <>
      <header className="lumina-navbar">
        <div className="lumina-nav-container nav-learner">
          <MobileNav
            open={drawer}
            onOpen={() => {
              setAccountOpen(false);
              setDrawer(true);
            }}
            onClose={close}
            items={LEARNER_NAV_ITEMS}
            pathname={pathname}
            name={name}
            email={email}
            onSignOut={onSignOut}
          />
          <Link href="/ask" className="lumina-brand" aria-label="Project Learner — your workspace">
            <BrandLogo height={46} />
          </Link>
        </div>
      </header>

      <SideNav
        items={LEARNER_NAV_ITEMS}
        pathname={pathname}
        name={name}
        email={email}
        accountOpen={accountOpen}
        onToggleAccount={() => setAccountOpen((open) => !open)}
        onSignOut={onSignOut}
        accountRef={accountRef}
        accountToggleRef={accountToggleRef}
      />
    </>
  );
}
