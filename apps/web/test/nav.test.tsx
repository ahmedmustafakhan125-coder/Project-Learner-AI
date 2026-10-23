/**
 * The navigation: what it links to, and the learner's sidebar.
 *
 * With PROJECT_LEARNER off the bar must be exactly the one from before, so the
 * item lists are pinned literally. With it on, the sections are plain links
 * down a left sidebar, the account sits at its foot, and For you is gone.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { isActive, LEARNER_NAV_ITEMS, navItemsFor } from '../lib/navLinks';
import { NavLinkList, SideNav } from '../components/nav/SideNav';

const noop = () => undefined;

/** The whole `<a …>` tag for a link, whatever order its attributes render in. */
const linkTag = (html: string, href: string) => html.match(new RegExp(`<a[^>]*href="${href}"[^>]*>`))?.[0] ?? '';

describe('navItemsFor', () => {
  const shape = (signedIn: boolean, learner: boolean) =>
    navItemsFor(signedIn, learner).map((item) => [item.href, item.label]);

  it('signed out, the bar is Home and About whatever the flag', () => {
    const expected = [
      ['/', 'Home'],
      ['/about', 'About'],
    ];
    expect(shape(false, false)).toEqual(expected);
    expect(shape(false, true)).toEqual(expected);
  });

  it('signed in with the flag off, the bar is exactly the one from before', () => {
    expect(shape(true, false)).toEqual([
      ['/', 'Home'],
      ['/ask', 'Workspace'],
      ['/projects', 'Projects'],
      ['/brain', 'Brain'],
      ['/about', 'About'],
    ]);
  });

  it('signed in with the flag on, the sidebar is Workspace, Projects and Brain, and nothing else', () => {
    expect(shape(true, true)).toEqual([
      ['/ask', 'Workspace'],
      ['/projects', 'Projects'],
      ['/brain', 'Brain'],
    ]);
  });
});

describe('isActive', () => {
  it('matches / exactly and everything else by prefix, as the bar always has', () => {
    expect(isActive('/', '/')).toBe(true);
    expect(isActive('/', '/ask')).toBe(false);
    expect(isActive('/projects', '/projects/abc')).toBe(true);
    expect(isActive('/ask', '/assess/1')).toBe(false);
    expect(isActive(null, '/ask')).toBe(false);
    expect(isActive('/ask', null)).toBe(false);
  });
});

describe('the learner sidebar', () => {
  const sidebar = (pathname: string) =>
    renderToStaticMarkup(
      <SideNav
        items={LEARNER_NAV_ITEMS}
        pathname={pathname}
        name="Ada Lovelace"
        email="ada@example.com"
        accountOpen={false}
        onToggleAccount={noop}
        onSignOut={noop}
      />,
    );

  it('links each section to its page, with no menus to open', () => {
    const html = sidebar('/ask');
    expect(html).toContain('href="/ask"');
    expect(html).toContain('href="/projects"');
    expect(html).toContain('href="/brain"');
    expect(html).not.toContain('For you');
    expect(html).not.toContain('nav-panel-workspace');
  });

  it('marks the section you are in, including below its page', () => {
    const html = sidebar('/projects/p1');
    expect(linkTag(html, '/projects')).toContain('aria-current="page"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it('puts the account at the foot, closed until asked', () => {
    const html = sidebar('/brain');
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Reset password');
  });

  it('gives the drawer the same links', () => {
    const html = renderToStaticMarkup(<NavLinkList items={LEARNER_NAV_ITEMS} pathname="/brain" />);
    expect(html.match(/<a /g)).toHaveLength(3);
    expect(linkTag(html, '/brain')).toContain('aria-current="page"');
  });
});
