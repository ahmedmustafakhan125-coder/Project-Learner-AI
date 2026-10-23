/**
 * What the navigation links to.
 *
 * Kept out of the components so the rules are plain functions a test can pin:
 * with PROJECT_LEARNER off the items must stay exactly what they were.
 */

export interface NavItem {
  href: string;
  label: string;
}

/** Signed out, flag on or off. */
export const PUBLIC_NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Home' },
  { href: '/about', label: 'About' },
];

/** Signed in with the flag off: today's bar. */
export const SIGNED_IN_NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Home' },
  { href: '/ask', label: 'Workspace' },
  { href: '/projects', label: 'Projects' },
  { href: '/brain', label: 'Brain' },
  { href: '/about', label: 'About' },
];

/** Signed in with the flag on: the left sidebar. Home and About leave; the logo leads to the workspace. */
export const LEARNER_NAV_ITEMS: readonly NavItem[] = [
  { href: '/ask', label: 'Workspace' },
  { href: '/projects', label: 'Projects' },
  { href: '/brain', label: 'Brain' },
];

export function navItemsFor(signedIn: boolean, learner: boolean): readonly NavItem[] {
  if (!signedIn) return PUBLIC_NAV_ITEMS;
  return learner ? LEARNER_NAV_ITEMS : SIGNED_IN_NAV_ITEMS;
}

/** The bar's rule, unchanged from before the learner bar: `/` exactly, anything else by prefix. */
export function isActive(href: string | null, pathname: string | null): boolean {
  if (!href || !pathname) return false;
  if (href === '/') return pathname === '/';
  return pathname.startsWith(href);
}
