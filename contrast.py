"""Solve GobboNet's Reduced palette. Ratios are COMPUTED, never asserted."""
def _lin(c):
    c /= 255.0
    return c/12.92 if c <= 0.04045 else ((c+0.055)/1.055)**2.4
def lum(hexs):
    h = hexs.lstrip('#'); r,g,b = (int(h[i:i+2],16) for i in (0,2,4))
    return 0.2126*_lin(r)+0.7152*_lin(g)+0.0722*_lin(b)
def ratio(a,b):
    la,lb = lum(a),lum(b); hi,lo = max(la,lb),min(la,lb)
    return (hi+0.05)/(lo+0.05)
def hex_of(rgb):
    return '#%02x%02x%02x' % tuple(max(0,min(255,round(c))) for c in rgb)
def rgb_of(hexs):
    h = hexs.lstrip('#'); return [int(h[i:i+2],16) for i in (0,2,4)]

def retune(src, bg, target, desat=0.55):
    """Pull a neon toward its own grey (cuts chroma) then scale to hit `target`.
    Hue is preserved: this is the same colour, quieter -- not a different palette."""
    r,g,b = rgb_of(src)
    grey = 0.2126*r + 0.7152*g + 0.0722*b
    base = [c + (grey - c)*desat for c in (r,g,b)]
    lo_s, hi_s, best = 0.0, 2.0, None
    for _ in range(60):
        s = (lo_s+hi_s)/2
        cand = hex_of([c*s for c in base])
        rr = ratio(cand,bg); best = (cand,rr)
        if rr > target: hi_s = s
        else: lo_s = s
    return best

BG = '#020205'
SURFACE = '#080814'
# token, current, role, target ratio on BG
PLAN = [
    ('--white',       '#e0f8ff', 'body text',      9.0),
    ('--cyan-bright', '#00f3ff', 'accent / links', 8.0),
    ('--cyan-mid',    '#00b8ff', 'accent 2',       6.5),
    ('--cyan-dim',    '#005a88', 'secondary text', 5.0),
    ('--green-neon',  '#00ff73', 'success',        7.5),
    ('--magenta',     '#d900ff', 'highlight',      5.5),
    ('--red-neon',    '#ff003c', 'error',          5.5),
]
print(f"{'token':14} {'now':9} {'ratio':>6}   {'reduced':9} {'ratio':>6}  role")
out = {}
for tok, cur, role, target in PLAN:
    new, rr = retune(cur, BG, target)
    out[tok] = new
    print(f"{tok:14} {cur:9} {ratio(cur,BG):6.1f} -> {new:9} {rr:6.1f}  {role}")
print()
print("AA 4.5 floor met by all:", all(ratio(v,BG) >= 4.5 for v in out.values()))
print("none above 15:1 (halation):", all(ratio(v,BG) < 15 for v in out.values()))
print("also legible on --surface #080814:",
      all(ratio(v,SURFACE) >= 4.5 for v in out.values()))
import json; open('reduced.json','w').write(json.dumps(out, indent=2))
