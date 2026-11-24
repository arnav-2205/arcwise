"""Renders the homepage card images from real Arcwise output (help-desk sample analysis).
Usage: python scripts/render-hero-cards.py .data/analyses/<id>.json
Card 1 (3:2): the analysis' actual file graph. Card 2 (2:1): the quality-gate interval chart."""
import json, math, random, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = 'public/landing-pages/inner-green-assets/'
FONT = 'C:/Windows/Fonts/segoeui.ttf'
FONT_L = 'C:/Windows/Fonts/segoeuil.ttf'
LAYER = {'interface': (169, 198, 212), 'service': (214, 218, 204), 'ai': (166, 207, 140), 'data': (224, 194, 142), 'config': (170, 176, 160)}
S = 2  # supersample for smooth edges

def gradient(w, h, top, bottom):
    im = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(im)
    for y in range(h):
        t = y / (h - 1)
        d.line([(0, y), (w, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return im

def graph_card(a):
    W, H = 1200 * S, 800 * S
    nodes = a['graph']['nodes']; edges = a['graph']['edges']
    idx = {n['id']: i for i, n in enumerate(nodes)}
    links = [(idx[e['from']], idx[e['to']]) for e in edges if e['from'] in idx and e['to'] in idx]
    N = len(nodes); random.seed(4)
    x = [random.uniform(-1, 1) for _ in range(N)]; y = [random.uniform(-1, 1) for _ in range(N)]
    deg = [0] * N
    for a_, b_ in links: deg[a_] += 1; deg[b_] += 1
    for it in range(600):  # small force layout, same model as the app's graph
        fx = [0.0] * N; fy = [0.0] * N; t = 1 - it / 600
        for i in range(N):
            for j in range(i + 1, N):
                dx, dy = x[j] - x[i], y[j] - y[i]; d2 = dx * dx + dy * dy + 1e-4; f = 0.012 / d2
                fx[i] -= dx * f; fy[i] -= dy * f; fx[j] += dx * f; fy[j] += dy * f
        for i, j in links:
            dx, dy = x[j] - x[i], y[j] - y[i]; d = math.hypot(dx, dy) + 1e-6; f = (d - 0.42) * 0.08
            fx[i] += dx / d * f; fy[i] += dy / d * f; fx[j] -= dx / d * f; fy[j] -= dy / d * f
        for i in range(N):
            fx[i] -= x[i] * 0.02; fy[i] -= y[i] * 0.02
            x[i] += max(-.05, min(.05, fx[i])) * t; y[i] += max(-.05, min(.05, fy[i])) * t
    minx, maxx, miny, maxy = min(x), max(x), min(y), max(y)
    px = lambda i: (int(150 * S + (x[i] - minx) / (maxx - minx) * (W - 300 * S)), int(110 * S + (y[i] - miny) / (maxy - miny) * (H - 250 * S)))
    im = gradient(W, H, (62, 67, 58), (44, 48, 41))
    d = ImageDraw.Draw(im, 'RGBA')
    for i, j in links:
        d.line([px(i), px(j)], fill=(205, 212, 192, 95), width=3 * S)
    font = ImageFont.truetype(FONT, 26 * S)
    order = sorted(range(N), key=lambda i: -deg[i])
    for i in range(N):
        cx, cy = px(i); r = (10 + min(14, math.sqrt(deg[i]) * 5)) * S
        col = LAYER.get(nodes[i]['layer'], LAYER['service'])
        d.ellipse([cx - r - 6 * S, cy - r - 6 * S, cx + r + 6 * S, cy + r + 6 * S], fill=col + (40,))
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col + (255,))
    for i in order[:9]:  # label the hubs, like the app does at overview zoom
        cx, cy = px(i); r = (10 + min(14, math.sqrt(deg[i]) * 5)) * S
        d.text((cx, cy + r + 10 * S), nodes[i]['name'], font=font, fill=(240, 243, 234, 235), anchor='ma')
    im = im.resize((1200, 800), Image.LANCZOS)
    im.save(OUT + 'card-map.jpg', quality=92); print('card-map.jpg', im.size, N, 'files', len(links), 'links')

def gate_card():
    W, H = 1200 * S, 600 * S
    im = gradient(W, H, (238, 241, 231), (222, 227, 213))
    d = ImageDraw.Draw(im, 'RGBA')
    ink, faint, ok, bad = (35, 38, 31), (124, 129, 119), (78, 140, 76), (190, 70, 58)
    f_s = ImageFont.truetype(FONT, 26 * S); f_l = ImageFont.truetype(FONT_L, 50 * S)
    d.text((90 * S, 70 * S), 'QUALITY DIFFERENCE, CHEAPER MINUS CURRENT', font=f_s, fill=faint)
    x0, x1, yb = 90 * S, W - 90 * S, 300 * S
    lo, hi = -6, 4
    X = lambda v: x0 + (v - lo) / (hi - lo) * (x1 - x0)
    d.rectangle([x0, yb - 70 * S, X(-2), yb + 70 * S], fill=bad + (26,))
    d.line([x0, yb, x1, yb], fill=(180, 186, 170), width=4 * S)
    for v in range(lo, hi + 1, 2):
        d.line([X(v), yb - 10 * S, X(v), yb + 10 * S], fill=(160, 166, 150), width=3 * S)
    for yy in range(yb - 90 * S, yb + 90 * S, 22 * S):  # dashed limit
        d.line([X(-2), yy, X(-2), yy + 12 * S], fill=bad, width=4 * S)
    d.text((X(-2) + 14 * S, yb - 100 * S), 'limit', font=f_s, fill=bad)
    d.line([X(-1.2), yb, X(0.9), yb], fill=ok, width=16 * S)
    for xx in (X(-1.2), X(0.9)):
        d.ellipse([xx - 8 * S, yb - 8 * S, xx + 8 * S, yb + 8 * S], fill=ok)
    d.ellipse([X(-0.2) - 20 * S, yb - 20 * S, X(-0.2) + 20 * S, yb + 20 * S], fill=ok, outline=(255, 255, 255), width=5 * S)
    # Proven pill
    pill = 'Proven: quality held'
    tw = d.textlength(pill, font=f_l)
    px0, py0 = 90 * S, 430 * S
    d.rounded_rectangle([px0, py0, px0 + tw + 90 * S, py0 + 92 * S], radius=46 * S, fill=(56, 59, 52))
    d.ellipse([px0 + 30 * S, py0 + 36 * S, px0 + 50 * S, py0 + 56 * S], fill=(166, 207, 140))
    d.text((px0 + 66 * S, py0 + 46 * S), pill, font=f_l, fill=(255, 255, 255), anchor='lm')
    im = im.resize((1200, 600), Image.LANCZOS)
    im.save(OUT + 'card-gate.jpg', quality=92); print('card-gate.jpg', im.size)

graph_card(json.load(open(sys.argv[1], encoding='utf8')))
gate_card()
