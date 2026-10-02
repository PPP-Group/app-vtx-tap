# Vetoriza a logo do VTX Tap (PNG 640x296) em partes separadas para animar no vídeo.
# Saída: src/marca/vtxtap.json  { w, h, partes: [{ id, cor, d, caixa:[x0,y0,x1,y1] }] }
import json, sys
import numpy as np
from PIL import Image
from scipy import ndimage
from skimage import measure

SRC = sys.argv[1]
OUT = sys.argv[2]
ESC = 6  # supersampling

im = np.asarray(Image.open(SRC).convert('RGBA')).astype(np.float32) / 255
a = im[..., 3]
rgb = im[..., :3]
roxo = (rgb[..., 2] > 0.55) | (rgb[..., 0] > 0.35)
H, W = a.shape

def sobe(m):
    img = Image.fromarray((m * 255).astype(np.uint8))
    return np.asarray(img.resize((W * ESC, H * ESC), Image.BICUBIC)).astype(np.float32) / 255

partes = []
for cor, mascara in (('tinta', a * (~roxo)), ('roxo', a * roxo)):
    g = sobe(mascara)
    rot, n = ndimage.label(g > 0.5)
    for i in range(1, n + 1):
        reg = (rot == i)
        if reg.sum() < 40 * ESC * ESC:
            continue
        campo = np.where(reg, g, 0.0)
        campo = np.pad(campo, 2)
        cs = measure.find_contours(campo, 0.5)
        d = []
        for c in cs:
            c = measure.approximate_polygon(c, tolerance=0.9)
            if len(c) < 4:
                continue
            pts = [((p[1] - 2) / ESC, (p[0] - 2) / ESC) for p in c]
            d.append('M' + 'L'.join(f'{x:.2f} {y:.2f}' for x, y in pts) + 'Z')
        ys, xs = np.nonzero(reg)
        caixa = [xs.min() / ESC, ys.min() / ESC, (xs.max() + 1) / ESC, (ys.max() + 1) / ESC]
        partes.append({'cor': cor, 'd': ''.join(d), 'caixa': [round(v, 2) for v in caixa]})

# nomes pelas posições
def nome(p):
    x0, y0, x1, y1 = p['caixa']
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    if p['cor'] == 'roxo':
        if x0 > 520: return 'onda'
        return 'x-cima' if cy < 90 else 'x-baixo'
    if y0 > 180:
        if x1 < 280: return 'tap-t'
        if x1 < 370: return 'tap-a'
        return 'tap-p'
    if x0 < 20: return 'v'
    return 't-haste' if (x1 - x0) < 60 else 'tx'
for p in partes:
    p['id'] = nome(p)
ondas = sorted([p for p in partes if p['id'] == 'onda'], key=lambda p: p['caixa'][0])
for k, p in enumerate(ondas):
    p['id'] = f'onda-{k + 1}'
partes.sort(key=lambda p: p['id'])
json.dump({'w': W, 'h': H, 'partes': partes}, open(OUT, 'w'), ensure_ascii=False)
for p in partes:
    print(p['id'], p['cor'], p['caixa'], len(p['d']))
