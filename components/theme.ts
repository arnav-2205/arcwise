import type { GLayer } from './Graph3D';
import type { Quality, Severity } from '../lib/types';

// Mid-tone, low-chroma colours that read on both the light and the dark canvas.
export const LAYERS: GLayer[] = [
  { key: 'interface', name: 'Interface', color: '#A9C6D4' },
  { key: 'service', name: 'Services', color: '#C9CDBF' },
  { key: 'ai', name: 'AI calls', color: '#A6CF8C' },
  { key: 'data', name: 'Data', color: '#E0C28E' },
  { key: 'config', name: 'Config', color: '#9AA08F' },
];
export const layerOf = (k: string) => LAYERS.find(l => l.key === k) ?? LAYERS[1];

export const SEV_COLOR: Record<Severity, string> = { critical: '#F07F6E', high: '#F0A472', medium: '#EBC877', low: '#C9CDBF' };
export const SEV_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };
export const QUALITY_COLOR: Record<Quality, string> = { proven: '#A6CF8C', testing: '#A9C6D4', unvalidated: '#C9CDBF', atrisk: '#F07F6E' };
export const QUALITY_LABEL: Record<Quality, string> = { proven: 'Proven', testing: 'Testing', unvalidated: 'Unvalidated', atrisk: 'At risk' };
