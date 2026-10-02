import React from 'react';
import { interpolate } from 'remotion';
import { C, E, F } from '../marca';

type Linha = string | { t: string; cor?: string };

// Super em Big Shoulders: cada linha sobe de trás de uma máscara.
export const Titulo: React.FC<{
  f: number; // quadro local
  de: number;
  ate?: number;
  linhas: Linha[];
  x: number;
  y: number; // base do bloco
  tamanho?: number;
  cor?: string;
  alinhar?: 'left' | 'right' | 'center';
  intervalo?: number;
  sombra?: boolean;
}> = ({ f, de, ate = 99999, linhas, x, y, tamanho = 128, cor = C.branco, alinhar = 'left', intervalo = 4, sombra = true }) => {
  if (f < de - 1 || f > ate + 18) return null;
  const n = linhas.length;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        transform: `translate(${alinhar === 'right' ? '-100%' : alinhar === 'center' ? '-50%' : '0'}, -100%)`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: alinhar === 'right' ? 'flex-end' : alinhar === 'center' ? 'center' : 'flex-start',
      }}
    >
      {linhas.map((l, i) => {
        const txt = typeof l === 'string' ? l : l.t;
        const c = typeof l === 'string' ? cor : l.cor || cor;
        const ent = interpolate(f, [de + i * intervalo, de + i * intervalo + 16], [128, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: E.saida });
        const sai = interpolate(f, [ate + (n - 1 - i) * 2, ate + (n - 1 - i) * 2 + 11], [0, -128], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: E.entra });
        return (
          <div key={i} style={{ overflow: 'hidden', paddingTop: tamanho * 0.16, marginTop: -tamanho * 0.16, paddingBottom: tamanho * 0.04, marginBottom: -tamanho * 0.04 }}>
            <div
              style={{
                fontFamily: F.display,
                fontWeight: 900,
                fontSize: tamanho,
                lineHeight: 0.9,
                letterSpacing: '0.004em',
                textTransform: 'uppercase',
                color: c,
                whiteSpace: 'nowrap',
                transform: `translateY(${ent + sai}%)`,
                textShadow: sombra ? '0 6px 30px rgba(6,3,20,.45)' : undefined,
              }}
            >
              {txt}
            </div>
          </div>
        );
      })}
    </div>
  );
};

// Troca de rótulo grande em "fenda": o antigo sobe, o novo entra por baixo.
export const Fenda: React.FC<{ f: number; itens: { de: number; t: string; sub?: string }[]; x: number; y: number; tamanho?: number; ate?: number }> = ({ f, itens, x, y, tamanho = 150, ate = 99999 }) => {
  return (
    <div style={{ position: 'absolute', left: x, top: y }}>
      {itens.map((it, i) => {
        const prox = itens[i + 1] ? itens[i + 1].de : ate;
        if (f < it.de - 2 || f > prox + 14) return null;
        const ent = interpolate(f, [it.de, it.de + 12], [128, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: i === 0 ? E.saida : E.entraSai });
        const sai = interpolate(f, [prox, prox + 12], [0, -128], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: i === itens.length - 1 ? E.entra : E.entraSai });
        const subOp = interpolate(f, [it.de + 6, it.de + 16, prox - 2, prox + 4], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        return (
          <div key={i} style={{ position: 'absolute', left: 0, top: 0 }}>
            <div style={{ overflow: 'hidden', height: tamanho * 1.14, paddingTop: tamanho * 0.16, marginTop: -tamanho * 0.16 }}>
              <div
                style={{
                  fontFamily: F.display,
                  fontWeight: 900,
                  fontSize: tamanho,
                  lineHeight: 1,
                  textTransform: 'uppercase',
                  color: C.branco,
                  whiteSpace: 'nowrap',
                  transform: `translateY(${ent + sai}%)`,
                }}
              >
                {it.t}
              </div>
            </div>
            {it.sub && (
              <div style={{ marginTop: 18, fontFamily: F.mono, fontWeight: 500, fontSize: 22, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.lilas, opacity: subOp, whiteSpace: 'nowrap' }}>
                {it.sub}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
