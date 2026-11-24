'use client';
import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import type { GEdge, GNode } from './Graph3D';
import { LAYERS, QUALITY_COLOR } from './theme';

const Graph3D = dynamic(() => import('./Graph2D'), { ssr: false, loading: () => <div className="skel" style={{ position: 'absolute', inset: 0, borderRadius: 0 }} /> });

/** Illustrative map for the landing page. Not real data, and labelled as such. */
function demo() {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const spec: [string, string[]][] = [
    ['interface', ['app/page.tsx', 'app/inbox/page.tsx', 'app/api/tickets/route.ts', 'app/api/webhook/route.ts', 'app/api/search/route.ts', 'components/ReplyBox.tsx', 'components/TicketList.tsx', 'app/settings/page.tsx', 'app/api/billing/route.ts']],
    ['service', ['lib/ticketService.ts', 'lib/routerService.ts', 'lib/replyService.ts', 'lib/threadService.ts', 'lib/kbSearch.ts', 'lib/slaTimer.ts', 'lib/authGuard.ts', 'lib/notifier.ts', 'lib/billing.ts', 'lib/reports.ts', 'lib/audit.ts']],
    ['ai', ['lib/ai/classify.ts', 'lib/ai/route.ts', 'lib/ai/draft.ts', 'lib/ai/summarize.ts', 'lib/ai/embed.ts', 'lib/ai/sentiment.ts']],
    ['data', ['lib/db/ticketRepo.ts', 'lib/db/userRepo.ts', 'lib/db/kbIndex.ts', 'lib/cache.ts', 'lib/queue.ts', 'lib/storage.ts', 'lib/db/client.ts']],
  ];
  const quality = ['proven', 'testing', 'unvalidated', 'atrisk', 'unvalidated', 'proven'] as const;
  const nodes: GNode[] = [];
  spec.forEach(([layer, files]) => files.forEach((f, i) => {
    const L = LAYERS.find(l => l.key === layer)!;
    nodes.push({ id: f, label: f.split('/').pop()!, sub: f, layer, color: L.color, size: layer === 'ai' ? 0.24 + rnd() * 0.16 : 0.15 + rnd() * 0.12, ring: layer === 'ai' ? QUALITY_COLOR[quality[i]] : null });
  }));
  const edges: GEdge[] = [];
  const byLayer = (k: string) => nodes.filter(n => n.layer === k);
  const link = (a: string, b: string, k: number) => byLayer(a).forEach(n => { for (let j = 0; j < k; j++) { const t = byLayer(b)[(rnd() * byLayer(b).length) | 0]; if (!edges.some(e => e.from === n.id && e.to === t.id)) edges.push({ from: n.id, to: t.id }); } });
  link('interface', 'service', 2); link('service', 'ai', 1); link('service', 'data', 2); link('ai', 'data', 1);
  return { nodes, edges };
}

export default function HeroGraph() {
  const { nodes, edges } = useMemo(demo, []);
  const arcs = useMemo<[string, string][]>(() => [['lib/ai/classify.ts', 'lib/ai/route.ts']], []);
  return (
    <div className="map-frame" role="img" aria-label="Illustration of an Arcwise map: four stacked layers of files, with AI calls marked by quality rings.">
      <Graph3D nodes={nodes} edges={edges} layers={LAYERS} arcs={arcs} autoRotate={0.08} interactive={false} />
      <div className="map-legend" aria-hidden>
        {LAYERS.slice(0, 4).map(l => <span key={l.key}><i className="legend-dot" style={{ background: l.color }} />{l.name}</span>)}
        <span><i className="legend-dot" style={{ background: '#C8453A' }} />Redundant calls</span>
      </div>
      <p className="map-caption">Illustration. Your repository gets its own map.</p>
    </div>
  );
}
