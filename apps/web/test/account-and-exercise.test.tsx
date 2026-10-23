/**
 * The account menu and the practice preview, rendered to markup.
 *
 * The account menu names who is signed in and offers a new password in place;
 * About left it. The practice preview loads the /sandbox route: a `srcdoc`
 * frame inherits the app's CSP, which refused every inline script on the page,
 * so the exercise drew but its "Run & Check" never ran.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AccountPanel } from '../components/nav/AccountPanel';
import { UserMenu } from '../components/nav/UserMenu';
import { PracticePreview } from '../components/PracticePreview';

const noop = () => {};

describe('account menu', () => {
  it('shows the name, the email, Reset password and Sign out, and no About', () => {
    const html = renderToStaticMarkup(
      <UserMenu name="Ada Lovelace" email="ada@example.com" open onToggle={noop} onSignOut={noop} />,
    );
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('ada@example.com');
    expect(html).toContain('Reset password');
    expect(html).toContain('Sign out');
    expect(html).not.toContain('About');
  });

  it('starts with the password form closed', () => {
    const html = renderToStaticMarkup(<AccountPanel name="Ada" email={null} onSignOut={noop} />);
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('@');
  });
});

describe('practice preview', () => {
  const page = '<!DOCTYPE html><html><body><button id="go">Run</button><script>document.title = "ok";</script></body></html>';

  it('loads the /sandbox route instead of an inline srcdoc frame', () => {
    const html = renderToStaticMarkup(<PracticePreview html={page} />);
    expect(html).toContain('src="/sandbox?runtime=web"');
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain('srcdoc');
    // The page travels by message once the frame says it is ready, never in the markup.
    expect(html).not.toContain('document.title');
  });
});
