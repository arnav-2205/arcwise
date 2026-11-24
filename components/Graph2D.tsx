'use client';
// Obsidian-style graph view: a calm 2D force layout drawn on canvas. Circles with labels, thin links
// with small arrowheads, hover fades everything but the neighbourhood. The simulation settles and stops.
import { useEffect, useRef } from 'react';
import type { GEdge, GLayer, GNode } from './Graph3D';

interface Props {
  nodes: GNode[];
  edges: GEdge[];
  layers?: GLayer[];
  selected?: string | null;
  highlight?: Set<string> | null;
  arcs?: [string, string][];
  focus?: string | null;
  onSelect?: (id: string | null) => void;
  interactive?: boolean;
  zoom?: boolean;
  autoRotate?: number;
}

// Sylva moss field: pale nodes and white labels on moss charcoal
const C = { bg: '#363931', link: '#555A4D', linkHi: '#B9BFAD', label: '#E9ECE3', labelFaint: '#6E7366', ring: '#EEF1E7', arc: '#F2A196' };
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };

export default function Graph2D(p: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const st = useRef({ props: p, wake: () => {} });
  st.current.props = p;
  const key = p.nodes.map(n => n.id).join('|') + '#' + p.edges.length;

  useEffect(() => {
    const cv = canvas.current!;
    const ctx = cv.getContext('2d')!;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const { nodes, edges } = st.current.props;
    const idx = new Map(nodes.map((n, i) => [n.id, i]));
    const N = nodes.length;
    const links = edges.map(e => [idx.get(e.from), idx.get(e.to)] as const).filter((l): l is readonly [number, number] => l[0] != null && l[1] != null && l[0] !== l[1]);
    const deg = new Array(N).fill(0);
    for (const [a, b] of links) { deg[a]++; deg[b]++; }
    const nb: Set<number>[] = nodes.map(() => new Set());
    for (const [a, b] of links) { nb[a].add(b); nb[b].add(a); }
    // deterministic start positions, so the layout is the same every visit
    const R = Math.sqrt(N) * 28 + 60;
    const x = new Float64Array(N), y = new Float64Array(N), vx = new Float64Array(N), vy = new Float64Array(N);
    nodes.forEach((n, i) => { const a = hash(n.id) * Math.PI * 2, r = Math.sqrt(hash(n.id + '#')) * R; x[i] = Math.cos(a) * r; y[i] = Math.sin(a) * r; });
    const radius = (i: number) => 3.5 + Math.min(6.5, Math.sqrt(deg[i]) * 1.6);
    // the few best-connected files keep a label at overview zoom
    const hubs = new Set([...deg.keys()].sort((a, b) => deg[b] - deg[a]).slice(0, Math.min(6, Math.ceil(N / 8))).filter(i => deg[i] > 1));

    let alpha = 1;
    const cam = { x: 0, y: 0, k: 1, tx: 0, ty: 0, tk: 1 };
    let w = 0, h = 0, dpr = 1, hover = -1, dragNode = -1, panning = false, moved = 0, last = { x: 0, y: 0 }, raf = 0, fitted = false, userMoved = false;

    const tick = () => {
      const rep = 2600 * alpha;
      for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
        let dx = x[j] - x[i], dy = y[j] - y[i]; let d2 = dx * dx + dy * dy;
        if (d2 > 160000) continue;
        if (d2 < 1) { dx = (hash(String(i * N + j)) - .5); dy = .5; d2 = 1; }
        const f = rep / d2, d = Math.sqrt(d2);
        vx[i] -= dx / d * f; vy[i] -= dy / d * f; vx[j] += dx / d * f; vy[j] += dy / d * f;
      }
      for (const [a, b] of links) {
        const dx = x[b] - x[a], dy = y[b] - y[a], d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d - 105) * 0.05 * alpha;
        vx[a] += dx / d * f; vy[a] += dy / d * f; vx[b] -= dx / d * f; vy[b] -= dy / d * f;
      }
      for (let i = 0; i < N; i++) {
        vx[i] -= x[i] * 0.008 * alpha; vy[i] -= y[i] * 0.008 * alpha;
        if (i === dragNode) { vx[i] = vy[i] = 0; continue; }
        vx[i] *= 0.6; vy[i] *= 0.6; x[i] += vx[i]; y[i] += vy[i];
      }
      alpha *= 0.985;
    };
    // Lay the graph out before the first frame (bounded for big repos), so it opens settled and framed.
    const warm = reduced ? 300 : Math.max(40, Math.min(320, Math.floor(2.5e7 / Math.max(1, N * N))));
    for (let i = 0; i < warm; i++) tick();
    if (reduced) alpha = 0;

    const fit = () => {
      if (!N || !w) return;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < N; i++) { minX = Math.min(minX, x[i]); maxX = Math.max(maxX, x[i]); minY = Math.min(minY, y[i]); maxY = Math.max(maxY, y[i]); }
      const k = Math.min(1.6, 0.85 * Math.min(w / Math.max(1, maxX - minX + 80), h / Math.max(1, maxY - minY + 80)));
      cam.tk = k; cam.tx = (minX + maxX) / 2; cam.ty = (minY + maxY) / 2;
    };

    const toWorld = (sx: number, sy: number) => ({ x: (sx - w / 2) / cam.k + cam.x, y: (sy - h / 2) / cam.k + cam.y });
    const pick = (sx: number, sy: number) => {
      const q = toWorld(sx, sy); let best = -1, bd = Infinity;
      for (let i = 0; i < N; i++) { const d = Math.hypot(x[i] - q.x, y[i] - q.y); if (d < radius(i) + 5 / cam.k && d < bd) { bd = d; best = i; } }
      return best;
    };

    const draw = () => {
      const props = st.current.props;
      const vis = new Map(props.nodes.map(n => [n.id, n]));
      const hl = props.highlight;
      const focusSet = hover >= 0 ? new Set([hover, ...nb[hover]]) : null;
      const active = (i: number) => focusSet ? focusSet.has(i) : hl ? hl.has(nodes[i].id) : !(vis.get(nodes[i].id)?.dim);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
      ctx.setTransform(dpr * cam.k, 0, 0, dpr * cam.k, dpr * (w / 2 - cam.x * cam.k), dpr * (h / 2 - cam.y * cam.k));
      // links
      ctx.lineWidth = 1 / cam.k;
      for (const [a, b] of links) {
        const on = active(a) && active(b);
        const strong = on && (focusSet || hl);
        ctx.strokeStyle = strong ? C.linkHi : C.link; ctx.globalAlpha = on ? 1 : 0.25;
        const dx = x[b] - x[a], dy = y[b] - y[a], d = Math.hypot(dx, dy) || 1, rb = radius(b) + 2;
        const ex = x[b] - dx / d * rb, ey = y[b] - dy / d * rb;
        ctx.beginPath(); ctx.moveTo(x[a], y[a]); ctx.lineTo(ex, ey); ctx.stroke();
        if (cam.k > 0.45) { // small arrowhead
          const s = 5 / Math.max(cam.k, .8), ux = dx / d, uy = dy / d;
          ctx.fillStyle = ctx.strokeStyle as string;
          ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - ux * s - uy * s * .5, ey - uy * s + ux * s * .5); ctx.lineTo(ex - ux * s + uy * s * .5, ey - uy * s - ux * s * .5); ctx.fill();
        }
      }
      // redundant-call arcs
      ctx.globalAlpha = 1; ctx.strokeStyle = C.arc; ctx.lineWidth = 2 / cam.k;
      for (const [fa, fb] of props.arcs ?? []) {
        const a = idx.get(fa), b = idx.get(fb); if (a == null || b == null) continue;
        const mx = (x[a] + x[b]) / 2 - (y[b] - y[a]) * .3, my = (y[a] + y[b]) / 2 + (x[b] - x[a]) * .3;
        ctx.beginPath(); ctx.moveTo(x[a], y[a]); ctx.quadraticCurveTo(mx, my, x[b], y[b]); ctx.stroke();
      }
      // nodes
      for (let i = 0; i < N; i++) {
        const v = vis.get(nodes[i].id) ?? nodes[i], on = active(i), r = radius(i);
        ctx.globalAlpha = on ? 1 : 0.22;
        ctx.fillStyle = v.color; ctx.beginPath(); ctx.arc(x[i], y[i], r, 0, Math.PI * 2); ctx.fill();
        if (v.ring && on) { ctx.strokeStyle = v.ring; ctx.lineWidth = 2 / cam.k; ctx.beginPath(); ctx.arc(x[i], y[i], r + 3 / cam.k + 1, 0, Math.PI * 2); ctx.stroke(); }
        if (props.selected === nodes[i].id || i === hover) { ctx.strokeStyle = C.ring; ctx.lineWidth = 2 / cam.k; ctx.beginPath(); ctx.arc(x[i], y[i], r + 5 / cam.k + 2, 0, Math.PI * 2); ctx.stroke(); }
      }
      // labels below nodes, like Obsidian; shown when zoomed in or for the focused neighbourhood
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const fs = 12 / cam.k; ctx.font = `300 ${fs}px Lexend, -apple-system, "Segoe UI", sans-serif`;
      const placed: [number, number, number, number][] = [];
      const order = [...Array(N).keys()].sort((a, b) => Number(focusSet?.has(b) ?? 0) - Number(focusSet?.has(a) ?? 0) || deg[b] - deg[a]);
      for (const i of order) {
        const on = active(i);
        // Like Obsidian: labels appear as you zoom in; at overview only hubs and the focused neighbourhood
        const show = cam.k > 1.35 || (focusSet ? focusSet.has(i) : hl ? hl.has(nodes[i].id) : hubs.has(i));
        if (!show) continue;
        const tw = ctx.measureText(nodes[i].label).width, lx = x[i] - tw / 2, ly = y[i] + radius(i) + 4 / cam.k, lh = fs * 1.2;
        if (placed.some(([a, b, c, d]) => lx < c && lx + tw > a && ly < d && ly + lh > b)) continue;
        placed.push([lx, ly, lx + tw, ly + lh]);
        ctx.globalAlpha = on ? 1 : 0.2;
        ctx.fillStyle = on ? C.label : C.labelFaint;
        ctx.fillText(nodes[i].label, x[i], y[i] + radius(i) + 4 / cam.k);
      }
      ctx.globalAlpha = 1;
    };

    const loop = () => {
      raf = 0;
      if (alpha > 0.004) tick();
      else if (!fitted) { fit(); fitted = true; }
      cam.k += (cam.tk - cam.k) * 0.18; cam.x += (cam.tx - cam.x) * 0.18; cam.y += (cam.ty - cam.y) * 0.18;
      draw();
      const settling = alpha > 0.004 || Math.abs(cam.tk - cam.k) > 1e-3 || Math.abs(cam.tx - cam.x) > .1 || Math.abs(cam.ty - cam.y) > .1;
      if (settling) raf = requestAnimationFrame(loop);
    };
    const wake = () => { if (!raf) raf = requestAnimationFrame(loop); };
    st.current.wake = wake;

    const resize = () => {
      const r = cv.parentElement!.getBoundingClientRect(); w = r.width; h = r.height; dpr = Math.min(devicePixelRatio || 1, 2);
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = w + 'px'; cv.style.height = h + 'px';
      if (!userMoved && w && h) { fit(); if (!fitted) { cam.k = cam.tk; cam.x = cam.tx; cam.y = cam.ty; fitted = true; } } wake();
    };
    const ro = new ResizeObserver(resize); ro.observe(cv.parentElement!); resize();

    const pos = (e: PointerEvent | WheelEvent) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const onDown = (e: PointerEvent) => {
      const q = pos(e); moved = 0; last = q; cv.setPointerCapture(e.pointerId);
      const i = st.current.props.interactive ? pick(q.x, q.y) : -1;
      if (i >= 0) { dragNode = i; } else panning = true;
    };
    const onMove = (e: PointerEvent) => {
      const q = pos(e); const dx = q.x - last.x, dy = q.y - last.y; moved += Math.abs(dx) + Math.abs(dy); last = q;
      if (dragNode >= 0 && moved > 3) { const wq = toWorld(q.x, q.y); x[dragNode] = wq.x; y[dragNode] = wq.y; alpha = Math.max(alpha, 0.15); wake(); return; }
      if (panning) { userMoved = true; cam.tx -= dx / cam.k; cam.ty -= dy / cam.k; cam.x = cam.tx; cam.y = cam.ty; wake(); return; }
      if (!st.current.props.interactive) return;
      const i = pick(q.x, q.y);
      if (i !== hover) { hover = i; cv.style.cursor = i >= 0 ? 'pointer' : 'grab'; wake(); }
    };
    const onUp = () => {
      if (moved < 4 && st.current.props.interactive) { const i = pick(last.x, last.y); st.current.props.onSelect?.(i >= 0 ? nodes[i].id : null); }
      dragNode = -1; panning = false;
    };
    const onLeave = () => { if (hover !== -1) { hover = -1; wake(); } };
    const onWheel = (e: WheelEvent) => {
      if (!st.current.props.zoom) return;
      e.preventDefault(); userMoved = true;
      const q = pos(e), before = toWorld(q.x, q.y);
      cam.tk = cam.k = Math.max(0.15, Math.min(4, cam.k * Math.exp(-e.deltaY * 0.0015)));
      const after = toWorld(q.x, q.y); cam.x += before.x - after.x; cam.y += before.y - after.y; cam.tx = cam.x; cam.ty = cam.y;
      wake();
    };
    cv.addEventListener('pointerdown', onDown); cv.addEventListener('pointermove', onMove); cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointerleave', onLeave); cv.addEventListener('wheel', onWheel, { passive: false });
    (st.current as unknown as { focusOn: (id: string | null) => void }).focusOn = (id) => {
      const i = id ? idx.get(id) : undefined;
      if (i != null) { cam.tx = x[i]; cam.ty = y[i]; cam.tk = Math.max(cam.k, 1.2); } else if (id === null && fitted) fit();
      wake();
    };
    (st.current as unknown as { ctl: { zoom: (f: number) => void; fit: () => void } }).ctl = {
      zoom: f => { userMoved = true; cam.tk = Math.max(0.15, Math.min(4, cam.tk * f)); wake(); },
      fit: () => { userMoved = false; fit(); wake(); },
    };
    wake();
    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      cv.removeEventListener('pointerdown', onDown); cv.removeEventListener('pointermove', onMove); cv.removeEventListener('pointerup', onUp);
      cv.removeEventListener('pointerleave', onLeave); cv.removeEventListener('wheel', onWheel);
    };
  }, [key]);

  useEffect(() => { st.current.wake(); }, [p.nodes, p.highlight, p.arcs, p.selected]);
  useEffect(() => { (st.current as unknown as { focusOn?: (id: string | null) => void }).focusOn?.(p.focus ?? null); }, [p.focus]);

  const ctl = () => (st.current as unknown as { ctl?: { zoom: (f: number) => void; fit: () => void } }).ctl;
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <canvas ref={canvas} style={{ display: 'block', cursor: 'grab', touchAction: 'none' }} aria-hidden />
      {p.zoom && (
        <div className="map-tools">
          <button type="button" onClick={() => ctl()?.zoom(1.3)} aria-label="Zoom in" title="Zoom in">+</button>
          <button type="button" onClick={() => ctl()?.zoom(1 / 1.3)} aria-label="Zoom out" title="Zoom out">−</button>
          <button type="button" onClick={() => ctl()?.fit()} aria-label="Fit the whole map" title="Fit">⤢</button>
        </div>
      )}
    </div>
  );
}
