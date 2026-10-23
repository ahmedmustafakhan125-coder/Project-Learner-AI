import Link from 'next/link';
import type { ReactNode, Ref } from 'react';

import { isActive, type NavItem } from '../../lib/navLinks';
import { UserMenu } from './UserMenu';

/**
 * The learner's sections down the left edge, and their account at its foot.
 *
 * Plain links: each section's own page carries its detail, so nothing here
 * waits on data. Below 860px the sidebar is hidden and the drawer shows the
 * same list.
 */

/** Drawn at 24×24 with a 1.8 stroke in the link's own colour. */
const ICONS: Record<string, ReactNode> = {
  // A speech bubble: the workspace is where the four specialists answer.
  '/ask': <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-5 4z" />,
  // A folder.
  '/projects': (
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l2 2h8.8A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
  ),
  // Three linked nodes: the brain is a graph of what the learner knows.
  '/brain': (
    <>
      <circle cx="6" cy="7" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M8.5 6.8 15.5 6.2M7.2 9.2l3.6 6.6M16.8 8.2l-3.6 7.6" />
    </>
  ),
};

export function NavLinkList({
  items,
  pathname,
  onNavigate,
}: {
  items: readonly NavItem[];
  pathname: string | null;
  /** Called when a link is followed, so a drawer can close even on its own page. */
  onNavigate?: () => void;
}) {
  return (
    <ul className="side-nav-list">
      {items.map((item) => {
        const active = isActive(item.href, pathname);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              className={`side-nav-link ${active ? 'active' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={onNavigate}
            >
              {ICONS[item.href] && (
                <svg
                  className="side-nav-icon"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  {ICONS[item.href]}
                </svg>
              )}
              <span>{item.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export interface SideNavProps {
  items: readonly NavItem[];
  pathname: string | null;
  name: string;
  email: string | null;
  accountOpen: boolean;
  onToggleAccount: () => void;
  onSignOut: () => void;
  /** The account menu, so a click outside it can close it. */
  accountRef?: Ref<HTMLDivElement>;
  /** Lets the frame return focus here when Escape closes the account menu. */
  accountToggleRef?: Ref<HTMLButtonElement>;
}

export function SideNav({
  items,
  pathname,
  name,
  email,
  accountOpen,
  onToggleAccount,
  onSignOut,
  accountRef,
  accountToggleRef,
}: SideNavProps) {
  return (
    <aside className="side-nav">
      <nav className="side-nav-links" aria-label="Main">
        <NavLinkList items={items} pathname={pathname} />
      </nav>

      <div className="side-nav-foot">
        <UserMenu
          name={name}
          email={email}
          open={accountOpen}
          onToggle={onToggleAccount}
          onSignOut={onSignOut}
          rootRef={accountRef}
          toggleRef={accountToggleRef}
        />
      </div>
    </aside>
  );
}
