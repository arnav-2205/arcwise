import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Arcwise', template: '%s · Arcwise' },
  description: 'Arcwise maps a GitHub repository: how it works, where it might break, and what its AI calls cost, with savings proven by a quality gate.',
};
export const viewport: Viewport = {
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#383B34' }, { media: '(prefers-color-scheme: dark)', color: '#1E1F22' }],
};

// Applies a saved light/dark choice before first paint; otherwise the system setting wins.
const themeBoot = '';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head><link rel="stylesheet" href="/threeui/threeui.css" /><script dangerouslySetInnerHTML={{ __html: themeBoot }} /></head>
      <body>{children}</body>
    </html>
  );
}
