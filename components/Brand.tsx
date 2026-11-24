import Link from 'next/link';

/** Two arcs over a node: quiet, single accent. */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path d="M5 25 A13 13 0 0 1 27 25" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" opacity=".85" />
      <path d="M10.5 25 A7 7 0 0 1 21.5 25" fill="none" stroke="var(--interactive-accent)" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="16" cy="11.5" r="2.4" fill="var(--interactive-accent)" />
    </svg>
  );
}

export function Brand({ href = '/' }: { href?: string }) {
  return <Link href={href} className="brand"><BrandMark />Arcwise</Link>;
}
