'use client';
import { useEffect, useState } from 'react';
import type { Analysis, Settings } from './types';

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { ...(init?.json !== undefined ? { 'content-type': 'application/json' } : {}), ...init?.headers },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export interface AppConfig { llm: boolean; canStoreKeys: boolean; settings: Settings; fixtures: string[]; pricingAsOf: string; stalePrices: number; github: boolean }

export interface Me { user: { id: string; login: string; name: string | null; avatarUrl: string | null } | null; auth: { github: boolean; dev: boolean } }

export function useMe() {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => { api<Me>('/me').then(setMe).catch(() => setMe({ user: null, auth: { github: false, dev: false } })); }, []);
  return me;
}

export const signInUrl = (next = '/') => `/auth/github?next=${encodeURIComponent(next)}`;

/* ---------- theme: system by default, manual override saved per browser ---------- */
export type ThemeChoice = 'system' | 'light' | 'dark';
export function getTheme(): ThemeChoice {
  try { const t = localStorage.getItem('aw-theme'); return t === 'light' || t === 'dark' ? t : 'system'; } catch { return 'system'; }
}
export function setTheme(t: ThemeChoice) {
  try { if (t === 'system') localStorage.removeItem('aw-theme'); else localStorage.setItem('aw-theme', t); } catch { /* storage blocked: still apply for this page */ }
  if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
}

/** Formats a USD amount in the chosen currency. Small amounts keep decimals so they never read as zero. */
export function money(usd: number, s: Pick<Settings, 'currency' | 'fxRate'>): string {
  const v = s.currency === 'INR' ? usd * s.fxRate : usd;
  const sym = s.currency === 'INR' ? '₹' : '$';
  const locale = s.currency === 'INR' ? 'en-IN' : 'en-US';
  const abs = Math.abs(v);
  const digits = abs === 0 ? 0 : abs < 1 ? 3 : abs < 100 ? 2 : 0;
  return sym + v.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const compact = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString('en-US');

export const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export const basename = (p: string) => p.split('/').pop() ?? p;

export function relTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return shortDate(iso);
}

export type { Analysis };
