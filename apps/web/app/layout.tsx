import type { Metadata } from 'next';
import './globals.css';

/**
 * Rendered per request so the CSP nonce can be stamped onto Next's inline
 * hydration scripts. A statically prerendered page has those scripts baked in at
 * build time, which no per-request nonce can ever match — the page then renders
 * and silently never hydrates.
 *
 * Little is lost: every page sits behind AuthGate and is learner-specific, so
 * there was no meaningful static output to keep.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'AI Education Platform',
  description: 'Learn programming by building real projects, with four specialists answering every question.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
