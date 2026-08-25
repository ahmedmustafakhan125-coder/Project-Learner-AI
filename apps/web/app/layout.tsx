import type { Metadata } from 'next';
import './globals.css';

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
