import React from 'react';
import { interpolate } from 'remotion';
import VTX from '../marca/vtxtap.json';
import VORTEX from '../marca/vortex.json';
import { C, E, F } from '../marca';

const COR = { tinta: C.branco, roxo: C.roxo };
type Parte = { id: string; cor: 'tinta' | 'roxo'; d: string; caixa: number[] };
const PARTES = VTX.partes as Parte[];
export const parte = (id: string) => PARTES.find((p) => p.id === id)!;

const cl = (f: number, a: number, b: number, v0: number, v1: number, curva = E.saida) =>
  interpolate(f, [a, b], [v0, v1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: curva });

// Peças do E + X do letreiro VORTEX (EX ligado), em unidades do letreiro.
const EX_BARRA = 'M0 0L265.5 0L269.8 4L340 94L252.5 179L198 179L283 95L241.6 43L0 43Z';
const E_HASTE = 'M0 0H41V179H0Z';
const E_MEIO = 'M0 69.5H126L156 109.5H0Z';
const E_BAIXO = 'M0 139H146L176 179H0Z';
const X_ROXO = 'M181.5 0L241.9 0L154.5 85.3L130.2 59L127 53L172.5 7.8ZM154.5 100.5L156.5 100.6L234.8 182L234.5 183.5L173.5 183.5L124.2 133L124.1 130Z';
const EX_X = 898;
const LARG = 1338;
// O VTX Tap entra no mesmo sistema de coordenadas: o X dele cai em cima do X do letreiro.
const VTX_DX = EX_X - 108.9;

// f = quadro local da cena final (0 = 1:04.8)
export const AssinaturaFinal: React.FC<{ f: number; largura: number; altura: number; vertical?: boolean }> = ({ f, largura, altura, vertical }) => {
  // câmera: foco e escala, do VTX Tap para o VORTEX
  const m = cl(f, 144, 176, 0, 1, E.entraSai);
  const s1 = (vertical ? 0.92 : 1.38) * (largura / 1920) * (vertical ? 1920 / 1080 : 1);
  const s2 = (vertical ? 0.62 : 0.98) * (largura / 1920) * (vertical ? 1920 / 1080 : 1);
  const s = s1 + (s2 - s1) * m;
  const uc = VTX_DX + 320 + (LARG / 2 - (VTX_DX + 320)) * m;
  const vc = 148 + (90 - 148) * m;
  const cx = largura / 2;
  const cy = altura / 2 - (vertical ? 40 : 30) * (1 - m);

  // montagem do VTX Tap
  const v = { x: cl(f, 0, 18, -90, 0), o: cl(f, 0, 12, 0, 1, E.linear) };
  const tx = { y: cl(f, 4, 22, -70, 0), o: cl(f, 4, 14, 0, 1, E.linear) };
  const th = { y: cl(f, 8, 26, 80, 0), o: cl(f, 8, 18, 0, 1, E.linear) };
  const xc = { x: cl(f, 12, 30, 80, 0), y: cl(f, 12, 30, -60, 0), o: cl(f, 12, 20, 0, 1, E.linear) };
  const xb = { x: cl(f, 12, 30, 80, 0), y: cl(f, 12, 30, 60, 0), o: cl(f, 12, 20, 0, 1, E.linear) };
  const onda = (i: number) => {
    const a = 36 + i * 6;
    return { s: cl(f, a, a + 12, 0.55, 1), o: cl(f, a, a + 6, 0, 1, E.linear) };
  };
  const letra = (i: number) => ({ y: cl(f, 46 + i * 3, 62 + i * 3, 40, 0), o: cl(f, 46 + i * 3, 56 + i * 3, 0, 1, E.linear) });
  // saída do que não fica
  const some = cl(f, 144, 156, 1, 0, E.entra);
  const someV = cl(f, 148, 162, 1, 0, E.entra);
  const someHaste = cl(f, 150, 164, 1, 0, E.entra);
  const trocaX = cl(f, 172, 184, 0, 1, E.entraSai);
  // letreiro
  const sobe = (i: number) => cl(f, 164 + i * 4, 182 + i * 4, 200, 0);
  const surge = (i: number) => cl(f, 164 + i * 4, 172 + i * 4, 0, 1, E.linear);
  const eHaste = cl(f, 174, 188, 0, 1, E.saida);
  const eMeio = cl(f, 178, 190, 0, 1, E.saida);
  const eBaixo = cl(f, 182, 194, 0, 1, E.saida);
  const pulso = 1 + 0.025 * Math.sin(Math.min(1, Math.max(0, (f - 204) / 14)) * Math.PI);

  const tr = `translate(${cx} ${cy}) scale(${s}) translate(${-uc} ${-vc})`;
  const p = (id: string) => parte(id).d;
  const vtxOp = 1 - trocaX;

  return (
    <svg width={largura} height={altura} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
      <defs>
        <clipPath id="faixa-letreiro">
          <rect x={-50} y={-6} width={LARG + 100} height={192} />
        </clipPath>
      </defs>
      <g transform={tr}>
        {/* VTX Tap */}
        <g transform={`translate(${VTX_DX} 0)`}>
          <path d={p('v')} fill={COR.tinta} transform={`translate(${v.x} 0)`} opacity={v.o * someV} />
          <path d={p('t-haste')} fill={COR.tinta} transform={`translate(0 ${th.y})`} opacity={th.o * someHaste} />
          <g opacity={vtxOp}>
            <path d={p('tx')} fill={COR.tinta} transform={`translate(0 ${tx.y})`} opacity={tx.o} />
            <g transform={`translate(${490} ${92}) scale(${f > 200 ? pulso : 1}) translate(${-490} ${-92})`}>
              <path d={p('x-cima')} fill={COR.roxo} transform={`translate(${xc.x} ${xc.y})`} opacity={xc.o} />
              <path d={p('x-baixo')} fill={COR.roxo} transform={`translate(${xb.x} ${xb.y})`} opacity={xb.o} />
            </g>
          </g>
          {[1, 2, 3].map((i) => {
            const o = onda(i - 1);
            const c = parte(`onda-${i}`).caixa;
            const ox = c[0];
            const oy = (c[1] + c[3]) / 2;
            const pul = f > 60 && f < 150 ? 0.5 + 0.5 * Math.cos(((f - 60 - i * 5) / 36) * Math.PI * 2) : 1;
            return (
              <path
                key={i}
                d={p(`onda-${i}`)}
                fill={COR.roxo}
                transform={`translate(${ox} ${oy}) scale(${o.s}) translate(${-ox} ${-oy})`}
                opacity={o.o * some * (0.75 + 0.25 * pul)}
              />
            );
          })}
          {['tap-t', 'tap-a', 'tap-p'].map((id, i) => {
            const l = letra(i);
            return <path key={id} d={p(id)} fill={COR.tinta} transform={`translate(0 ${l.y})`} opacity={l.o * some} />;
          })}
        </g>
        {/* VORTEX */}
        <g clipPath="url(#faixa-letreiro)">
          {(['V', 'O', 'R', 'T'] as const).map((id, i) => {
            const pt = VORTEX.partes.find((x) => x.id === id)!;
            return <g key={id} transform={`translate(${pt.x} ${sobe(i)})`} opacity={surge(i)} dangerouslySetInnerHTML={{ __html: pt.svg }} />;
          })}
        </g>
        <g transform={`translate(${EX_X} 0)`}>
          <path d={EX_BARRA} fill={COR.tinta} opacity={trocaX} />
          <path d={E_HASTE} fill={COR.tinta} transform={`scale(1 ${eHaste})`} opacity={trocaX > 0 ? 1 : 0} />
          <path d={E_MEIO} fill={COR.tinta} transform={`translate(0 0) scale(${eMeio} 1)`} opacity={trocaX > 0 ? 1 : 0} />
          <path d={E_BAIXO} fill={COR.tinta} transform={`scale(${eBaixo} 1)`} opacity={trocaX > 0 ? 1 : 0} />
          <g transform={`translate(${198 + 182} 92) scale(${f > 200 ? pulso : 1}) translate(${-198 - 182} -92)`}>
            <path d={X_ROXO} fill={COR.roxo} transform="translate(198 0)" opacity={trocaX} />
          </g>
        </g>
      </g>
    </svg>
  );
};

// Textos de apoio da assinatura (endereço e "uma solução"), em HTML por cima do SVG.
export const TextosFinais: React.FC<{ f: number; largura: number; altura: number; vertical?: boolean }> = ({ f, largura, altura, vertical }) => {
  const url = { o: cl(f, 64, 80, 0, 1, E.linear) * cl(f, 140, 150, 1, 0, E.linear), y: cl(f, 64, 84, 18, 0) };
  const sol = { o: cl(f, 196, 214, 0, 1, E.linear), y: cl(f, 196, 218, 14, 0) };
  const k = largura / (vertical ? 1080 : 1920);
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: 0,
          width: largura,
          top: altura / 2 + (vertical ? 250 : 268) * k,
          textAlign: 'center',
          fontFamily: F.mono,
          fontWeight: 500,
          fontSize: 30 * k,
          letterSpacing: '0.08em',
          color: C.lavanda,
          opacity: url.o,
          transform: `translateY(${url.y}px)`,
        }}
      >
        tap.vortexsystems.tech
      </div>
      <div
        style={{
          position: 'absolute',
          left: 0,
          width: largura,
          top: altura / 2 - (vertical ? 170 : 168) * k,
          textAlign: 'center',
          fontFamily: F.marca,
          fontWeight: 300,
          fontSize: 34 * k,
          letterSpacing: '0.04em',
          color: C.lavanda,
          opacity: sol.o,
          transform: `translateY(${sol.y}px)`,
        }}
      >
        uma solução
      </div>
    </>
  );
};

// Assinatura curta (cortes de 30 e 15 s): VTX Tap montando, endereço e o endosso "uma solução VORTEX".
export const AssinaturaCurta: React.FC<{ f: number; largura: number; altura: number; vertical?: boolean }> = ({ f, largura, altura, vertical }) => {
  const k = largura / (vertical ? 1080 : 1920);
  const endosso = { o: cl(f, 84, 100, 0, 1, E.linear), y: cl(f, 84, 104, 16, 0) };
  return (
    <>
      <div style={{ position: 'absolute', inset: 0, transform: `translateY(${-60 * k}px)` }}>
        <AssinaturaFinal f={Math.min(f, 140)} largura={largura} altura={altura} vertical={vertical} />
        <TextosFinais f={Math.min(f, 130)} largura={largura} altura={altura} vertical={vertical} />
      </div>
      <div
        style={{
          position: 'absolute',
          left: 0,
          width: largura,
          top: altura / 2 + (vertical ? 330 : 300) * k,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 18 * k,
          opacity: endosso.o,
          transform: `translateY(${endosso.y}px)`,
        }}
      >
        <span style={{ fontFamily: F.marca, fontWeight: 300, fontSize: 30 * k, color: C.lavanda, letterSpacing: '0.04em' }}>uma solução</span>
        <svg width={1338 * 0.2 * k} height={186 * 0.2 * k} viewBox="0 -2 1338 186">
          {VORTEX.partes.map((p) => (
            <g key={p.id} transform={`translate(${p.x} 0)`} dangerouslySetInnerHTML={{ __html: p.svg }} />
          ))}
        </svg>
      </div>
    </>
  );
};
