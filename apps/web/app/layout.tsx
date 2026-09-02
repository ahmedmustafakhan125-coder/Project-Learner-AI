import type { Metadata } from 'next';
import './globals.css';
import { NavHeader } from '../components/NavHeader';

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
  title: 'Lumina AI — Education Platform',
  description: 'Learn programming by building real projects, with four AI specialists answering every question in parallel.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Sora:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <NavHeader />
        {children}
      </body>
    </html>
  );
}
