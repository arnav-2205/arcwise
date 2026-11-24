'use client';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { Me } from '../lib/client';

/* The homepage's dock on every page: authored glyphs, classes, measurements, and its motion
   (tile-by-tile entrance, spring magnification toward the pointer or keyboard focus, and the
   specular rim that follows the pointer). The motion below is ported from the authored page's
   initDock / drawDock / drawSpec with the same constants. Styles: .dock-nav rules in globals.css. */
const G = {
  home: <svg viewBox="0 0 16 16"><path d="M8 14V9" /><path d="M8 9c0-2.4 1.7-4.3 4-4.3.2 2.6-1.6 4.6-4 4.3Z" /><path d="M8 10.5C7.9 8.4 6.4 6.8 4.4 6.8 4.3 8.9 5.9 10.6 8 10.5Z" /></svg>,
  how: <svg viewBox="0 0 16 16"><path d="M1.6 12.4c2.4-3.4 4.3-5.1 5.7-5.1 2 0 3 3.6 5 3.6 1.1 0 1.9-.5 2.4-1.4" /><path d="M4.3 6.2C5.5 4.4 6.6 3.5 7.6 3.5c1.5 0 2.2 2.4 3.7 2.4" /></svg>,
  analyses: <svg viewBox="0 0 16 16"><path d="M4 2.4h5.3L12 5.1v8.5H4z" /><path d="M9.2 2.4V5h2.7" /><path d="M6 8.4h4M6 10.8h2.8" /></svg>,
  start: <svg viewBox="0 0 16 16"><path d="M6.6 2.5h5.1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6.6" /><path d="M2.6 8h6.6" /><path d="m7 5.6 2.4 2.4L7 10.4" /></svg>,
};
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function useDockMotion(root: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const nav = root.current;
    if (!nav) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const narrow = matchMedia('(max-width: 900px)');
    const fineHover = () => !reduced && matchMedia('(hover:hover) and (pointer:fine)').matches;
    type DItem = { el: HTMLElement; w: number; h: number; v: number; vel: number; target: number };
    type SItem = { el: HTMLElement; ang: number; tAng: number; br: number; tBr: number; focused: boolean; reach: number };
    const DOCK = { items: [] as DItem[], on: false, live: false, key: false, dirty: false, u: 1 };
    const SPEC = { items: [] as SItem[], on: false, dirty: false };
    let aimX = 0, aimY = 0, aimSeen = false, aimMoved = false, raf = 0, prev = performance.now();
    DOCK.items = [...nav.querySelectorAll<HTMLElement>('[data-dock]')].map(el => ({ el, w: 0, h: 0, v: 0, vel: 0, target: 0 }));
    SPEC.items = [...nav.querySelectorAll<HTMLElement>('[data-spec]')].map(el => ({ el, ang: 2.4, tAng: 2.4, br: 0, tBr: 0, focused: false, reach: el.classList.contains('dock') ? 250 : 185 }));
    SPEC.on = fineHover();

    const measure = () => {
      DOCK.on = fineHover();
      DOCK.u = innerWidth / (narrow.matches ? 760 : 1600);
      for (const st of DOCK.items) { st.el.style.width = st.el.style.height = st.el.style.transform = ''; st.el.dataset.near = 'false'; st.v = st.vel = st.target = 0; }
      for (const st of DOCK.items) { const r = st.el.getBoundingClientRect(); st.w = r.width; st.h = r.height; }
      DOCK.live = false; DOCK.dirty = true; aimMoved = aimSeen;
      wake();
    };
    const rest = () => { DOCK.live = false; DOCK.dirty = true; for (const st of DOCK.items) { st.target = 0; st.el.dataset.near = 'false'; } };

    const drawDock = (dt: number) => {
      if (!DOCK.on) return;
      const dockEl = nav.querySelector('.dock')!;
      if (aimSeen && aimMoved && !DOCK.key) {
        const rr = dockEl.getBoundingClientRect();
        if (aimX > rr.left - 48 && aimX < rr.right + 48 && aimY > rr.top - 44 && aimY < rr.bottom + 104) {
          for (const st of DOCK.items) {
            const r = st.el.getBoundingClientRect();
            const prox = clamp01(1 - Math.abs(aimX - (r.left + r.width * 0.5)) / (128 * DOCK.u));
            st.target = prox * prox * (3 - 2 * prox);
            st.el.dataset.near = st.target > 0.08 ? 'true' : 'false';
          }
          DOCK.live = true; DOCK.dirty = true;
        } else if (DOCK.live) rest();
      }
      if (!DOCK.dirty) return;
      let moving = false;
      for (const st of DOCK.items) {
        st.vel += (st.target - st.v) * 190 * dt;
        st.vel *= Math.exp(-23 * dt);
        st.v += st.vel * dt;
        if (Math.abs(st.target - st.v) < 0.001 && Math.abs(st.vel) < 0.004) { st.v = st.target; st.vel = 0; } else moving = true;
        const v = Math.min(Math.max(st.v, 0), 1.08);
        const mark = st.el.classList.contains('dock-mark');
        const ew = mark ? 14 * DOCK.u : Math.min(18 * DOCK.u, st.w * 0.24);
        const eh = mark ? 14 * DOCK.u : 16 * DOCK.u;
        st.el.style.width = (st.w + ew * v).toFixed(2) + 'px';
        st.el.style.height = (st.h + eh * v).toFixed(2) + 'px';
        st.el.style.transform = 'translateY(' + (v * 3.5 * DOCK.u).toFixed(2) + 'px)';
      }
      if (!moving) DOCK.dirty = false;
    };

    const drawSpec = (dt: number) => {
      if (!SPEC.on) return;
      if (aimSeen && aimMoved) {
        for (const st of SPEC.items) {
          const r = st.el.getBoundingClientRect();
          const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.5;
          const dx = Math.max(r.left - aimX, 0, aimX - r.right), dy = Math.max(r.top - aimY, 0, aimY - r.bottom);
          const d = Math.sqrt(dx * dx + dy * dy);
          st.tAng = d === 0
            ? Math.atan2(2 / Math.max(r.height, 1), -2 / Math.max(r.width, 1)) + ((aimX - cx) / Math.max(r.width * 0.5, 1)) * 0.30 + ((cy - aimY) / Math.max(r.height * 0.5, 1)) * 0.15
            : Math.atan2(cy - aimY, aimX - cx);
          const raw = clamp01(1 - d / (st.reach * DOCK.u));
          st.tBr = Math.max(raw * raw * (3 - 2 * raw), st.focused ? 0.9 : 0);
        }
        SPEC.dirty = true;
      }
      if (!SPEC.dirty) return;
      let moving = false;
      for (const st of SPEC.items) {
        const diff = ((st.tAng - st.ang + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        st.ang += diff * (1 - Math.exp(-dt * 8));
        st.br += (st.tBr - st.br) * (1 - Math.exp(-dt * 9));
        if (Math.abs(diff) < 0.001 && Math.abs(st.tBr - st.br) < 0.002) { st.ang = st.tAng; st.br = st.tBr; } else moving = true;
        st.el.style.setProperty('--spec-angle', st.ang.toFixed(4) + 'rad');
        st.el.style.setProperty('--spec-bright', (clamp01(st.br) * 0.92).toFixed(3));
      }
      if (!moving) SPEC.dirty = false;
    };

    const frame = (now: number) => {
      raf = 0;
      const dt = Math.min(0.05, (now - prev) / 1000); prev = now;
      drawDock(dt); drawSpec(dt); aimMoved = false;
      if (DOCK.dirty || SPEC.dirty) wake();
    };
    function wake() { if (!raf) { prev = performance.now(); raf = requestAnimationFrame(frame); } }

    const onMove = (e: PointerEvent) => { if (e.pointerType === 'touch') return; aimX = e.clientX; aimY = e.clientY; aimSeen = true; aimMoved = true; DOCK.key = false; DOCK.dirty = SPEC.dirty = true; wake(); };
    const onLeave = () => { aimSeen = false; rest(); for (const st of SPEC.items) st.tBr = st.focused ? 0.9 : 0; SPEC.dirty = true; wake(); };
    const onFocusIn = (e: FocusEvent) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('[data-dock]');
      if (!item || !DOCK.on) return;
      const idx = DOCK.items.findIndex(st => st.el === item);
      DOCK.items.forEach((st, i) => { st.target = i === idx ? 1 : Math.abs(i - idx) === 1 ? 0.24 : 0; st.el.dataset.near = st.target > 0.08 ? 'true' : 'false'; });
      DOCK.live = false; DOCK.key = true; DOCK.dirty = true; wake();
    };
    const onFocusOut = () => requestAnimationFrame(() => { if (!nav.contains(document.activeElement)) { DOCK.key = false; rest(); wake(); } });
    const specFocus = SPEC.items.map(st => {
      const fi = () => { st.focused = true; SPEC.dirty = true; wake(); }, fo = () => { st.focused = false; SPEC.dirty = true; wake(); };
      st.el.addEventListener('focusin', fi); st.el.addEventListener('focusout', fo);
      return () => { st.el.removeEventListener('focusin', fi); st.el.removeEventListener('focusout', fo); };
    });

    // entrance: the capsule fades, the tiles drop in one by one (authored .js / .is-ready / .intro-done)
    // Timers rather than rAF, so a background tab can never leave the dock hidden.
    nav.classList.add('js');
    const t1 = setTimeout(() => { void nav.offsetHeight; nav.classList.add('is-ready'); }, 40);
    const t2 = setTimeout(() => { nav.classList.add('is-ready', 'intro-done'); measure(); }, 1400);

    measure();
    document.fonts?.ready.then(measure);
    addEventListener('resize', measure);
    addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    nav.addEventListener('focusin', onFocusIn);
    nav.addEventListener('focusout', onFocusOut);
    return () => {
      cancelAnimationFrame(raf); clearTimeout(t1); clearTimeout(t2);
      removeEventListener('resize', measure); removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      nav.removeEventListener('focusin', onFocusIn); nav.removeEventListener('focusout', onFocusOut);
      specFocus.forEach(f => f());
    };
  }, [root]);
}

export default function DockNav({ me }: { me?: Me | null }) {
  const path = usePathname() ?? '/';
  const [hash, setHash] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useDockMotion(ref);
  useEffect(() => { const h = () => setHash(location.hash); h(); addEventListener('hashchange', h); return () => removeEventListener('hashchange', h); }, []);
  const active = path.startsWith('/a/') || hash === '#analyses' ? 'analyses' : hash === '#how' || hash === '#gate' ? 'how' : path === '/start' ? 'start' : path === '/' ? 'home' : '';
  const item = (key: keyof typeof G, href: string, label: string, d: number, extra = '') => (
    <a className={`dock-item${extra}${active === key ? ' is-active' : ''}`} data-dock data-spec href={href} style={{ '--d': `${d}ms` } as React.CSSProperties}
      onClick={() => setHash(href.includes('#') ? href.slice(href.indexOf('#')) : '')}>
      <span className="glyph" aria-hidden>{G[key]}</span><span>{label}</span>
    </a>
  );
  return (
    <div className="dock-nav" ref={ref}>
      <nav className="dock" data-spec aria-label="Primary">
        <a className="dock-item dock-mark" data-dock data-spec href="/" aria-label="Arcwise home" style={{ '--d': '120ms' } as React.CSSProperties}>
          <svg viewBox="0 0 22 24" aria-hidden><path d="M11 1.3c-2.1 0-3.95 1.2-4.75 2.95C3.95 4.55 2.3 6.25 2.3 8.35c0 2.3 1.9 4.2 4.3 4.2h8.8c2.4 0 4.3-1.9 4.3-4.2 0-2.1-1.65-3.8-4-4.1C14.95 2.5 13.1 1.3 11 1.3Z" /><path d="M9.6 12.55h2.8v4.2c1.35.3 2.45 1.15 3.15 2.4-1.35.4-2.4.15-3.15-.4v4.15H9.6v-4.15c-.75.55-1.8.8-3.15.4.7-1.25 1.8-2.1 3.15-2.4v-4.2Z" /></svg>
        </a>
        {item('home', '/', 'Home', 180)}
        {item('how', '/#how', 'How it works', 230)}
        {item('analyses', '/start#analyses', 'Analyses', 280)}
        {item('start', '/start', me?.user ? me.user.login : 'Start', 330, ' dock-item--enter')}
      </nav>
    </div>
  );
}
