#!/usr/bin/env python3
"""Gera o modelo 3D da plaquinha (GLB) no tamanho real, para ver na mesa pela câmera (realidade aumentada).

Cartão de 85,6 x 54 mm, 0,8 mm de espessura, cantos de 3,18 mm (o tamanho de um cartão de crédito),
deitado com a frente para cima. A frente usa a arte deitada; o verso, a arte em pé.

    python3 deploy/placa-glb.py assets/img/placas/cartao-vtx-frente.webp assets/img/placas/cartao-vtx-verso.webp assets/3d/plaquinha-vtx.glb

Precisa de Pillow (pip install pillow). As medidas do glTF são em metros.
"""
import io, json, math, struct, sys
from PIL import Image

W, D, T, R = 0.0856, 0.054, 0.0008, 0.00318   # largura, profundidade, espessura, raio do canto
BORDA = (0xDC / 255, 0xD6 / 255, 0xEA / 255, 1.0)
PASSOS = 10                                      # segmentos por canto


def contorno():
    """Pontos do retângulo arredondado (x, z), com o ângulo sempre crescendo (sem voltas)."""
    pts = []
    cantos = [(W / 2 - R, -D / 2 + R, -90), (W / 2 - R, D / 2 - R, 0), (-W / 2 + R, D / 2 - R, 90), (-W / 2 + R, -D / 2 + R, 180)]
    for cx, cz, a0 in cantos:
        for i in range(PASSOS + 1):
            a = math.radians(a0 + 90 * i / PASSOS)
            pts.append((cx + R * math.cos(a), cz + R * math.sin(a)))
    return pts


def orientar(p, idx, normal):
    """Vira os triângulos que apontam para o lado errado (normal esperada)."""
    out = []
    for t in range(0, len(idx), 3):
        a, b, c = (p[idx[t + k]] for k in range(3))
        u = [b[k] - a[k] for k in range(3)]
        v = [c[k] - a[k] for k in range(3)]
        n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
        ok = sum(n[k] * normal(t)[k] for k in range(3)) >= 0
        out += [idx[t], idx[t + 1], idx[t + 2]] if ok else [idx[t], idx[t + 2], idx[t + 1]]
    return out


def jpeg(caminho, tamanho):
    im = Image.open(caminho).convert('RGB').resize(tamanho, Image.LANCZOS)
    b = io.BytesIO()
    im.save(b, 'JPEG', quality=88, optimize=True)
    return b.getvalue()


def main(frente, verso, saida):
    pts = contorno()
    n = len(pts)
    y1, y0 = T / 2, -T / 2
    # Frente (topo): u da esquerda para a direita (+x), v de cima (longe, -z) para baixo (perto, +z).
    topo_p = [(0.0, y1, 0.0)] + [(x, y1, z) for x, z in pts]
    topo_uv = [((x + W / 2) / W, (z + D / 2) / D) for x, _, z in topo_p]
    topo_i = []
    for i in range(n):
        topo_i += [0, 1 + (i + 1) % n, 1 + i]
    # Verso (baixo): arte em pé; vista de baixo com o lado comprido na vertical, sem espelhar.
    base_p = [(0.0, y0, 0.0)] + [(x, y0, z) for x, z in pts]
    base_uv = [((D / 2 - z) / D, (W / 2 - x) / W) for x, _, z in base_p]
    base_i = []
    for i in range(n):
        base_i += [0, 1 + i, 1 + (i + 1) % n]
    # Borda: tira lateral.
    lado_p, lado_n, lado_i = [], [], []
    for i in range(n):
        x, z = pts[i]
        x2, z2 = pts[(i + 1) % n]
        nx, nz = (z2 - z), -(x2 - x)
        m = math.hypot(nx, nz) or 1
        nx, nz = nx / m, nz / m
        k = len(lado_p)
        lado_p += [(x, y1, z), (x2, y1, z2), (x2, y0, z2), (x, y0, z)]
        lado_n += [(nx, 0, nz)] * 4
        lado_i += [k, k + 2, k + 1, k, k + 3, k + 2]
    topo_i = orientar(topo_p, topo_i, lambda t: (0, 1, 0))
    base_i = orientar(base_p, base_i, lambda t: (0, -1, 0))
    lado_i = orientar(lado_p, lado_i, lambda t: lado_n[lado_i[t]])

    img_f = jpeg(frente, (1024, 646))
    img_v = jpeg(verso, (646, 1024))

    buf = bytearray()
    views, accessors = [], []

    def pad():
        while len(buf) % 4:
            buf.append(0)

    def add_view(data, target=None):
        pad()
        off = len(buf)
        buf.extend(data)
        v = {'buffer': 0, 'byteOffset': off, 'byteLength': len(data)}
        if target:
            v['target'] = target
        views.append(v)
        return len(views) - 1

    def add_acc(valores, tipo, comp, minmax=False, target=34962):
        flat = [c for v in valores for c in (v if isinstance(v, tuple) else (v,))]
        if comp == 5126:
            data = struct.pack('<%df' % len(flat), *flat)
        else:
            data = struct.pack('<%dH' % len(flat), *flat)
        a = {'bufferView': add_view(data, target), 'componentType': comp, 'count': len(valores), 'type': tipo}
        if minmax:
            dims = len(valores[0])
            a['min'] = [min(v[d] for v in valores) for d in range(dims)]
            a['max'] = [max(v[d] for v in valores) for d in range(dims)]
        accessors.append(a)
        return len(accessors) - 1

    def prim(p, nrm, uv, idx, mat):
        at = {'POSITION': add_acc(p, 'VEC3', 5126, True), 'NORMAL': add_acc(nrm, 'VEC3', 5126)}
        if uv:
            at['TEXCOORD_0'] = add_acc(uv, 'VEC2', 5126)
        return {'attributes': at, 'indices': add_acc(idx, 'SCALAR', 5123, target=34963), 'material': mat}

    prims = [
        prim(topo_p, [(0.0, 1.0, 0.0)] * len(topo_p), topo_uv, topo_i, 0),
        prim(base_p, [(0.0, -1.0, 0.0)] * len(base_p), base_uv, base_i, 1),
        prim(lado_p, lado_n, None, lado_i, 2),
    ]
    vf = add_view(img_f)
    vv = add_view(img_v)
    pad()

    gltf = {
        'asset': {'version': '2.0', 'generator': 'VTX Tap placa-glb'},
        'scene': 0, 'scenes': [{'nodes': [0]}],
        'nodes': [{'mesh': 0, 'name': 'Plaquinha VTX Tap'}],
        'meshes': [{'name': 'plaquinha', 'primitives': prims}],
        'materials': [
            {'name': 'frente', 'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}, 'metallicFactor': 0, 'roughnessFactor': 0.45}},
            {'name': 'verso', 'pbrMetallicRoughness': {'baseColorTexture': {'index': 1}, 'metallicFactor': 0, 'roughnessFactor': 0.45}},
            {'name': 'borda', 'pbrMetallicRoughness': {'baseColorFactor': list(BORDA), 'metallicFactor': 0, 'roughnessFactor': 0.6}},
        ],
        'samplers': [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 33071, 'wrapT': 33071}],
        'images': [{'bufferView': vf, 'mimeType': 'image/jpeg'}, {'bufferView': vv, 'mimeType': 'image/jpeg'}],
        'textures': [{'sampler': 0, 'source': 0}, {'sampler': 0, 'source': 1}],
        'accessors': accessors, 'bufferViews': views,
        'buffers': [{'byteLength': len(buf)}],
    }
    js = json.dumps(gltf, separators=(',', ':')).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(buf))
    out += struct.pack('<II', len(js), 0x4E4F534A) + js
    out += struct.pack('<II', len(buf), 0x004E4942) + bytes(buf)
    with open(saida, 'wb') as f:
        f.write(out)
    print(saida, len(out), 'bytes')


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
