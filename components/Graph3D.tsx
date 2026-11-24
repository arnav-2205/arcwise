'use client';
// WebGL map of the codebase: layers are stacked discs, files are glowing nodes, imports are links.
// Data-flow pulses travel along the links. One renderer, instanced meshes, so large repos stay smooth.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';

export interface GNode { id: string; label: string; sub?: string; layer: string; color: string; size: number; dim?: boolean; ring?: string | null }
export interface GEdge { from: string; to: string }
export interface GLayer { key: string; name: string; color: string }

interface Props {
  nodes: GNode[];
  edges: GEdge[];
  layers: GLayer[];
  selected?: string | null;
  highlight?: Set<string> | null;
  arcs?: [string, string][];
  focus?: string | null;
  onSelect?: (id: string | null) => void;
  interactive?: boolean;
  autoRotate?: number;
  zoom?: boolean;
}

/** Canvas colours come from the CSS tokens so the map follows the light or dark theme. */
const BG = new THREE.Color('#F2F0EB');
const ACCENT = new THREE.Color('#2F6A8A');
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const get = (v: string, fb: string) => cs.getPropertyValue(v).trim() || fb;
  BG.set(get('--canvas-bg', '#F2F0EB'));
  ACCENT.set(get('--interactive-accent', '#2F6A8A'));
}
const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3(), tmpC = new THREE.Color();

function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }

/** Deterministic layout: one disc per layer, files grouped by folder along a sunflower spiral. */
function layout(nodes: GNode[], layers: GLayer[]) {
  const order = layers.map(l => l.key).filter(k => nodes.some(n => n.layer === k));
  const gap = 2.2;
  const top = ((order.length - 1) * gap) / 2;
  const pos = new Map<string, THREE.Vector3>();
  const discs: { key: string; y: number; r: number }[] = [];
  order.forEach((key, li) => {
    const list = nodes.filter(n => n.layer === key).sort((a, b) => a.id.localeCompare(b.id));
    const r = Math.max(1.6, Math.sqrt(list.length) * 0.62 + 0.9);
    const y = top - li * gap;
    discs.push({ key, y, r });
    const golden = Math.PI * (3 - Math.sqrt(5));
    list.forEach((n, i) => {
      const t = Math.sqrt((i + 0.5) / list.length);
      const a = i * golden + li * 1.3;
      pos.set(n.id, new THREE.Vector3(Math.cos(a) * t * r, y + (hash(n.id) - 0.5) * 0.5, Math.sin(a) * t * r));
    });
  });
  return { pos, discs };
}

export default function Graph3D(p: Props) {
  const host = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const state = useRef<{ apply?: (p: Props) => void; dispose?: () => void; props: Props }>({ props: p });
  state.current.props = p;

  // Build the scene when the node set changes
  const key = p.nodes.map(n => n.id).join('|') + '#' + p.edges.length;
  useEffect(() => {
    const el = host.current!;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);
    readTheme();
    const scene = new THREE.Scene();
    const fog = new THREE.Fog(BG.getHex(), 20, 50);
    scene.fog = fog;
    const cam = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    scene.add(new THREE.AmbientLight(0xffffff, 0.95));
    const key1 = new THREE.PointLight(0xffffff, 1.2, 0, 0); key1.position.set(8, 12, 10); scene.add(key1);
    const rim = new THREE.PointLight(0xffffff, 0.45, 0, 0); rim.position.set(-10, -6, -8); scene.add(rim);

    const { nodes, layers, edges } = state.current.props;
    const { pos, discs } = layout(nodes, layers);
    const idx = new Map(nodes.map((n, i) => [n.id, i]));
    const N = nodes.length;

    // Nodes
    const sphere = new THREE.IcosahedronGeometry(1, 3);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05, emissive: 0xffffff, emissiveIntensity: 0.0 });
    mat.onBeforeCompile = sh => {
      // a little self-light so colours stay true on both themes; no glow
      sh.fragmentShader = sh.fragmentShader.replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = vColor * 0.22;');
    };
    const mesh = new THREE.InstancedMesh(sphere, mat, Math.max(1, N));
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, N) * 3), 3);
    scene.add(mesh);
    const cur = nodes.map(n => ({ s: 0.001, c: new THREE.Color(n.color) }));
    const tgt = nodes.map(n => ({ s: n.size, c: new THREE.Color(n.color) }));
    const delay = nodes.map(n => { const li = discs.findIndex(d => d.key === n.layer); return (discs.length - 1 - li) * 0.22 + hash(n.id) * 0.5; });

    // Rings (quality badges / selection)
    const ringGeo = new THREE.TorusGeometry(1, 0.06, 8, 48);
    const ringMesh = new THREE.InstancedMesh(ringGeo, new THREE.MeshBasicMaterial({ toneMapped: false }), Math.max(1, N));
    ringMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, N) * 3), 3);
    scene.add(ringMesh);
    const selMat = new THREE.MeshBasicMaterial({ color: ACCENT.getHex(), toneMapped: false });
    const sel = new THREE.Mesh(ringGeo, selMat);
    sel.visible = false; scene.add(sel);

    // Edges
    const valid = edges.filter(e => idx.has(e.from) && idx.has(e.to));
    const ePos = new Float32Array(valid.length * 6), eCol = new Float32Array(valid.length * 6);
    valid.forEach((e, i) => { const a = pos.get(e.from)!, b = pos.get(e.to)!; ePos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6); });
    const eGeo = new THREE.BufferGeometry();
    eGeo.setAttribute('position', new THREE.BufferAttribute(ePos, 3));
    eGeo.setAttribute('color', new THREE.BufferAttribute(eCol, 3));
    // Edge colours are mixed from the canvas colour toward the node colours, which works on light and dark.
    const lines = new THREE.LineSegments(eGeo, new THREE.LineBasicMaterial({ vertexColors: true, depthWrite: false }));
    scene.add(lines);
    const eCur = valid.map(() => 0.25), eTgt = valid.map(() => 0.25);

    // A few quiet pulses travelling along the brightest links
    const P = reduced ? 0 : Math.min(48, valid.length);
    const pPos = new Float32Array(Math.max(1, P) * 3);
    const pGeo = new THREE.BufferGeometry(); pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    const pMat = new THREE.PointsMaterial({ color: ACCENT.getHex(), size: 0.07, transparent: true, opacity: 0.75, depthWrite: false });
    const pts = new THREE.Points(pGeo, pMat);
    scene.add(pts);
    const pulses = Array.from({ length: P }, () => ({ e: (Math.random() * valid.length) | 0, t: Math.random(), v: 0.25 + Math.random() * 0.5 }));

    // Layer discs
    const discMeshes = discs.map(d => {
      const L = layers.find(l => l.key === d.key)!;
      const g = new THREE.Group(); g.position.y = d.y - 0.45;
      const fill = new THREE.Mesh(new THREE.CircleGeometry(d.r + 0.8, 96), new THREE.MeshBasicMaterial({ color: L.color, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
      const edge = new THREE.Mesh(new THREE.RingGeometry(d.r + 0.78, d.r + 0.82, 128), new THREE.MeshBasicMaterial({ color: L.color, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
      fill.rotation.x = edge.rotation.x = -Math.PI / 2;
      g.add(fill, edge); scene.add(g);
      return { ...d, fill, edge, name: L.name, color: L.color };
    });
    const span = Math.max(6, ...discs.map(d => d.r * 2.2), discs.length * 2.6);

    // Arcs (redundant pairs)
    let arcGroup = new THREE.Group(); scene.add(arcGroup);
    const buildArcs = (arcs: [string, string][]) => {
      scene.remove(arcGroup); arcGroup.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
      arcGroup = new THREE.Group();
      for (const [a, b] of arcs) {
        const A = pos.get(a), B = pos.get(b);
        if (!A || !B || a === b) continue;
        const mid = A.clone().add(B).multiplyScalar(0.5); mid.y += 1.2 + A.distanceTo(B) * 0.25;
        arcGroup.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([A, mid, B]), 48, 0.035, 8), new THREE.MeshBasicMaterial({ color: 0xff5a5f, toneMapped: false })));
      }
      scene.add(arcGroup);
    };

    // Camera rig
    const rig = { yaw: 0.8, pitch: 0.42, dist: span * 1.55, tdist: span * 1.55, target: new THREE.Vector3(), ttarget: new THREE.Vector3(), last: 0, down: null as null | { x: number; y: number; moved: number } };
    let hover: number | null = null;

    // Apply visual props without rebuilding
    state.current.apply = (q: Props) => {
      const qi = new Map(q.nodes.map(n => [n.id, n]));
      nodes.forEach((n, i) => {
        const v = qi.get(n.id) ?? n;
        const dimmed = v.dim || (q.highlight && !q.highlight.has(n.id));
        tgt[i].c.set(v.color);
        if (dimmed) tgt[i].c.lerp(BG, 0.82);
        tgt[i].s = dimmed ? Math.min(v.size, 0.16) : v.size;
        const rc = v.ring && !dimmed ? new THREE.Color(v.ring) : null;
        ringMesh.setColorAt(i, rc ?? BG);
        (ringMesh.userData.on ??= [])[i] = !!rc;
      });
      if (ringMesh.instanceColor) ringMesh.instanceColor.needsUpdate = true;
      valid.forEach((e, i) => {
        const a = qi.get(e.from), b = qi.get(e.to);
        const hl = q.highlight ? (q.highlight.has(e.from) && q.highlight.has(e.to)) : !(a?.dim || b?.dim);
        eTgt[i] = q.highlight ? (hl ? 1 : 0.03) : hl ? 0.32 : 0.05;
      });
      buildArcs(q.arcs ?? []);
      if (q.focus && pos.has(q.focus)) { rig.ttarget.copy(pos.get(q.focus)!); rig.tdist = Math.max(7, span * 0.75); }
      else if (q.focus === null) { rig.ttarget.set(0, 0, 0); rig.tdist = span * 1.55; }
    };
    state.current.apply(state.current.props);

    // Interaction
    const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
    const pick = (e: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(mouse, cam);
      const hit = ray.intersectObject(mesh)[0];
      return { i: hit?.instanceId ?? null, x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const canvas = renderer.domElement;
    canvas.style.touchAction = 'none';
    const onDown = (e: PointerEvent) => { rig.down = { x: e.clientX, y: e.clientY, moved: 0 }; rig.last = performance.now(); canvas.setPointerCapture(e.pointerId); };
    const onMove = (e: PointerEvent) => {
      if (rig.down && e.buttons) {
        const dx = e.clientX - rig.down.x, dy = e.clientY - rig.down.y;
        rig.down.x = e.clientX; rig.down.y = e.clientY; rig.down.moved += Math.abs(dx) + Math.abs(dy);
        rig.yaw -= dx * 0.006; rig.pitch = Math.max(-0.15, Math.min(1.25, rig.pitch + dy * 0.005)); rig.last = performance.now();
        return;
      }
      if (!state.current.props.interactive) return;
      const h = pick(e);
      hover = h.i;
      canvas.style.cursor = h.i != null ? 'pointer' : 'grab';
      const t = tip.current!;
      if (h.i == null) { t.hidden = true; return; }
      const n = state.current.props.nodes[h.i] ?? nodes[h.i];
      t.hidden = false; t.style.left = `${h.x}px`; t.style.top = `${h.y}px`;
      t.innerHTML = '';
      const b = document.createElement('b'); b.textContent = n.label; t.appendChild(b);
      if (n.sub) { const s = document.createElement('span'); s.textContent = n.sub; t.appendChild(s); }
    };
    const onUp = (e: PointerEvent) => {
      if (rig.down && rig.down.moved < 5 && state.current.props.interactive) {
        const h = pick(e);
        state.current.props.onSelect?.(h.i != null ? nodes[h.i].id : null);
      }
      rig.down = null;
    };
    const onLeave = () => { hover = null; if (tip.current) tip.current.hidden = true; };
    const onWheel = (e: WheelEvent) => {
      if (!state.current.props.zoom) return;
      e.preventDefault();
      rig.tdist = Math.max(4, Math.min(span * 3, rig.tdist * (1 + Math.sign(e.deltaY) * 0.09))); rig.last = performance.now();
    };
    canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize); ro.observe(el); resize();

    // Layer labels (DOM, projected)
    const labelEls = discMeshes.map(d => {
      const div = document.createElement('div');
      div.className = 'layer-label'; div.textContent = d.name; div.style.color = d.color;
      labels.current?.appendChild(div);
      return div;
    });

    const t0 = performance.now();
    let raf = 0, prev = t0;
    const up = new THREE.Vector3();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const dt = Math.min(0.05, (now - prev) / 1000); prev = now;
      const t = (now - t0) / 1000;
      const props = state.current.props;
      if (!reduced && now - rig.last > 2500 && hover == null && !props.selected) rig.yaw += dt * (props.autoRotate ?? 0.06);
      rig.dist += (rig.tdist - rig.dist) * 0.07; rig.target.lerp(rig.ttarget, 0.07);
      const cp = Math.cos(rig.pitch);
      cam.position.set(rig.target.x + rig.dist * cp * Math.sin(rig.yaw), rig.target.y + rig.dist * Math.sin(rig.pitch), rig.target.z + rig.dist * cp * Math.cos(rig.yaw));
      cam.lookAt(rig.target);
      up.copy(cam.up);

      const intro = (i: number) => reduced ? 1 : Math.min(1, Math.max(0, (t - delay[i]) / 0.8));
      for (let i = 0; i < N; i++) {
        const k = intro(i); const ease = k * k * (3 - 2 * k);
        cur[i].s += (tgt[i].s - cur[i].s) * 0.12; cur[i].c.lerp(tgt[i].c, 0.14);
        const breathe = reduced ? 1 : 1 + Math.sin(t * 1.6 + i) * 0.04;
        const s = Math.max(0.0001, cur[i].s * ease * breathe);
        tmpM.compose(pos.get(nodes[i].id)!, tmpQ.identity(), tmpS.set(s, s, s)); mesh.setMatrixAt(i, tmpM);
        mesh.setColorAt(i, cur[i].c);
        const on = (ringMesh.userData.on as boolean[] | undefined)?.[i];
        const rs = on ? s * 1.45 + 0.04 : 0.0001;
        tmpM.compose(pos.get(nodes[i].id)!, cam.quaternion, tmpS.set(rs, rs, rs)); ringMesh.setMatrixAt(i, tmpM);
      }
      mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      ringMesh.instanceMatrix.needsUpdate = true;

      for (let i = 0; i < valid.length; i++) {
        eCur[i] += (eTgt[i] - eCur[i]) * 0.1;
        const a = idx.get(valid[i].from)!, b = idx.get(valid[i].to)!;
        const k = Math.min(intro(a), intro(b)) * eCur[i];
        tmpC.copy(BG).lerp(cur[a].c, k); eCol[i * 6] = tmpC.r; eCol[i * 6 + 1] = tmpC.g; eCol[i * 6 + 2] = tmpC.b;
        tmpC.copy(BG).lerp(cur[b].c, k); eCol[i * 6 + 3] = tmpC.r; eCol[i * 6 + 4] = tmpC.g; eCol[i * 6 + 5] = tmpC.b;
      }
      eGeo.attributes.color.needsUpdate = true;

      if (P) {
        for (let i = 0; i < P; i++) {
          const pl = pulses[i];
          pl.t += dt * pl.v;
          if (pl.t >= 1 || eTgt[pl.e] < 0.1) {
            pl.t = 0;
            // prefer bright edges
            for (let tries = 0; tries < 6; tries++) { pl.e = (Math.random() * valid.length) | 0; if (eTgt[pl.e] >= 0.3) break; }
          }
          const off = eTgt[pl.e] < 0.1 ? 999 : 0;
          tmpP.set(ePos[pl.e * 6], ePos[pl.e * 6 + 1], ePos[pl.e * 6 + 2]).lerp(tmpS.set(ePos[pl.e * 6 + 3], ePos[pl.e * 6 + 4], ePos[pl.e * 6 + 5]), pl.t);
          pPos[i * 3] = tmpP.x + off; pPos[i * 3 + 1] = tmpP.y; pPos[i * 3 + 2] = tmpP.z;
        }
        pGeo.attributes.position.needsUpdate = true;
      }

      discMeshes.forEach((d, i) => {
        const k = reduced ? 1 : Math.min(1, Math.max(0, (t - (discs.length - 1 - i) * 0.22) / 0.9));
        (d.fill.material as THREE.MeshBasicMaterial).opacity = 0.06 * k;
        (d.edge.material as THREE.MeshBasicMaterial).opacity = 0.35 * k;
      });

      const selId = props.selected;
      const si = selId != null ? idx.get(selId) : undefined;
      sel.visible = si != null;
      if (si != null) { sel.position.copy(pos.get(nodes[si].id)!); sel.quaternion.copy(cam.quaternion); const s = cur[si].s * 1.9 + 0.12 + (reduced ? 0 : Math.sin(t * 4) * 0.03); sel.scale.set(s, s, s); }

      renderer.render(scene, cam);

      const w = el.clientWidth, h = el.clientHeight;
      discMeshes.forEach((d, i) => {
        const v = tmpP.set(-(d.r + 0.8) * Math.cos(rig.yaw), d.y - 0.45, (d.r + 0.8) * Math.sin(rig.yaw)).project(cam);
        const lab = labelEls[i];
        lab.style.left = `${(v.x * 0.5 + 0.5) * w}px`; lab.style.top = `${(-v.y * 0.5 + 0.5) * h}px`;
        lab.style.opacity = v.z < 1 ? '1' : '0';
      });
    };
    raf = requestAnimationFrame(frame);

    // Follow theme changes (system setting or the manual switch)
    const onTheme = () => {
      readTheme();
      fog.color.copy(BG); selMat.color.copy(ACCENT); pMat.color.copy(ACCENT);
      state.current.apply?.(state.current.props);
    };
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', onTheme);
    const mo = new MutationObserver(onTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    state.current.dispose = () => {
      cancelAnimationFrame(raf); ro.disconnect(); mo.disconnect(); mq.removeEventListener('change', onTheme);
      canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointerleave', onLeave); canvas.removeEventListener('wheel', onWheel);
      labelEls.forEach(l => l.remove());
      scene.traverse(o => { if (o instanceof THREE.Mesh || o instanceof THREE.Points || o instanceof THREE.LineSegments) { o.geometry.dispose(); const m = o.material as THREE.Material | THREE.Material[]; (Array.isArray(m) ? m : [m]).forEach(x => x.dispose()); } });
      renderer.dispose(); canvas.remove();
    };
    return () => state.current.dispose?.();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Visual-only updates
  useEffect(() => { state.current.apply?.(p); }, [p.nodes, p.highlight, p.arcs, p.focus, p.selected]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
      <div ref={labels} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} aria-hidden />
      <div ref={tip} className="graph-tip" hidden />
    </div>
  );
}
