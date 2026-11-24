'use client';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getTheme, setTheme, type ThemeChoice } from '../lib/client';

const NEXT: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' };
const LABEL: Record<ThemeChoice, string> = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' };

/** Cycles system → light → dark. System follows the operating system setting. */
export default function ThemeSwitch({ compact = false }: { compact?: boolean }) {
  const [t, setT] = useState<ThemeChoice>('system');
  useEffect(() => setT(getTheme()), []);
  const Icon = t === 'light' ? Sun : t === 'dark' ? Moon : Monitor;
  return (
    <button className={compact ? 'nav-row' : 'btn btn-quiet btn-sm'} onClick={() => { const n = NEXT[t]; setTheme(n); setT(n); }} title={LABEL[t]} aria-label={LABEL[t]}>
      <Icon className="icon" aria-hidden />{compact ? <span className="hide-collapsed">{LABEL[t]}</span> : null}
    </button>
  );
}
