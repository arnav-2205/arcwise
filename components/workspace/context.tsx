'use client';
import { createContext, useContext } from 'react';
import type { AppConfig } from '../../lib/client';
import type { Analysis, Settings } from '../../lib/types';

export type Tab = 'overview' | 'understand' | 'risks' | 'cost';
export type Sel = { kind: 'node' | 'finding' | 'site' | 'rec' | 'prompt'; id: string } | null;

export interface WS {
  a: Analysis;
  setA: (a: Analysis) => void;
  cfg: AppConfig | null;
  settings: Settings;
  fmt: (usd: number) => string;
  tab: Tab;
  setTab: (t: Tab) => void;
  sel: Sel;
  select: (s: Sel) => void;
  search: string;
  tour: { flow: number; step: number } | null;
  setTour: (t: { flow: number; step: number } | null) => void;
  toast: (msg: string) => void;
  refresh: () => Promise<void>;
  openValidate: (recId: string) => void;
  replay: { recId: string; done: number; total: number } | null;
}

export const Ctx = createContext<WS | null>(null);
export const useWS = () => { const v = useContext(Ctx); if (!v) throw new Error('Workspace context missing'); return v; };
