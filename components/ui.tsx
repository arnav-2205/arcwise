'use client';
import type { ReactNode } from 'react';
import type { Diff, Quality, Severity } from '../lib/types';
import { QUALITY_LABEL } from './theme';

export const QualityPill = ({ q }: { q: Quality }) => <span className={`pill ${q}`}><span className="dot" />{QUALITY_LABEL[q]}</span>;
export const SevPill = ({ s }: { s: Severity }) => <span className={`pill sev-${s}`}>{s}</span>;
export const Est = ({ children = 'estimated' }: { children?: ReactNode }) => <span className="pill est">{children}</span>;

export function CodeBlock({ lines, start = 1, hl, wrap }: { lines: string[]; start?: number; hl?: [number, number]; wrap?: boolean }) {
  return (
    <pre className={`code${wrap ? ' wrap-lines' : ''}`}>
      {lines.map((l, i) => {
        const n = start + i;
        return <span key={i} className={`ln${hl && n >= hl[0] && n <= hl[1] ? ' hl' : ''}`}><b>{n}</b>{l || ' '}</span>;
      })}
    </pre>
  );
}

/** A diff as a review artifact: file header with counts, then the patch on the terminal surface. */
export function DiffBlock({ diff, file }: { diff: Diff; file?: string }) {
  if (!diff.del.length && !diff.add.length) return null;
  return (
    <div className="diff-card">
      <header>
        <span className="file">{file ?? 'suggested change'}</span>
        <span className="spacer" />
        <span className="plus num">+{diff.add.length}</span>
        <span className="minus num">−{diff.del.length}</span>
      </header>
      <pre className="code wrap-lines">
        {diff.del.map((l, i) => <span key={`d${i}`} className="ln del"><b>−</b>{l}</span>)}
        {diff.add.map((l, i) => <span key={`a${i}`} className="ln add"><b>+</b>{l}</span>)}
      </pre>
    </div>
  );
}

/** 95% interval of the quality difference against the limit. Colours follow the theme. */
export function CIChart({ mean, ci, delta }: { mean: number; ci: [number, number]; delta: number }) {
  const lo = Math.min(-delta * 3, Math.floor(ci[0] - 2)), hi = Math.max(delta * 2, Math.ceil(ci[1] + 2));
  const x = (v: number) => 24 + ((v - lo) / (hi - lo)) * 432;
  const pass = ci[0] > -delta;
  const col = pass ? 'var(--diff-add)' : 'var(--diff-remove)';
  const faint = { fill: 'var(--text-faint)', fontSize: 11, fontFamily: 'var(--font-monospace)' } as const;
  return (
    <svg viewBox="0 0 480 96" style={{ width: '100%', height: 'auto' }} role="img" aria-label={`Quality difference ${mean.toFixed(1)} points, 95% interval ${ci[0].toFixed(1)} to ${ci[1].toFixed(1)}, limit minus ${delta}`}>
      <rect x={24} y={18} width={x(-delta) - 24} height={44} style={{ fill: 'var(--diff-remove-bg)' }} />
      <line x1={24} y1={40} x2={456} y2={40} style={{ stroke: 'var(--background-modifier-border-strong)' }} strokeWidth={1.5} />
      <line x1={x(0)} y1={22} x2={x(0)} y2={58} style={{ stroke: 'var(--background-modifier-border-strong)' }} strokeDasharray="2 3" />
      <line x1={x(-delta)} y1={12} x2={x(-delta)} y2={68} style={{ stroke: 'var(--diff-remove)' }} strokeWidth={1.5} strokeDasharray="4 3" />
      <line x1={x(ci[0])} y1={40} x2={x(ci[1])} y2={40} style={{ stroke: col }} strokeWidth={5} strokeLinecap="round" />
      <circle cx={x(mean)} cy={40} r={6} style={{ fill: col }} />
      <text x={x(-delta) + 5} y={14} style={{ ...faint, fill: 'var(--diff-remove)' }}>limit −{delta}</text>
      <text x={x(0)} y={84} textAnchor="middle" style={faint}>0</text>
      <text x={24} y={84} style={faint}>{lo}</text>
      <text x={456} y={84} textAnchor="end" style={faint}>+{hi}</text>
    </svg>
  );
}

export function Empty({ icon, children, action }: { icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  return <div className="empty">{icon}<div>{children}</div>{action}</div>;
}
