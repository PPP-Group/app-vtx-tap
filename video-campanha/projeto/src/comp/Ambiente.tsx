import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from 'remotion';
import { C } from '../marca';

// Fundo noite com uma poça de luz (quente ou roxa).
export const Fundo: React.FC<{ luz?: { x: number; y: number; r: number; cor: string; forca: number }[]; base?: string }> = ({ luz = [], base = C.noite }) => (
  <AbsoluteFill
    style={{
      background: [
        ...luz.map((l) => `radial-gradient(${l.r}px ${l.r * 0.82}px at ${l.x}% ${l.y}%, ${hexA(l.cor, l.forca)}, ${hexA(l.cor, 0)} 100%)`),
        `radial-gradient(120% 90% at 50% 40%, ${base} 0%, ${C.preto} 100%)`,
      ].join(','),
    }}
  />
);

// Grão de filme: oito ladrilhos de ruído, um por quadro.
export const Grao: React.FC<{ forca?: number }> = ({ forca = 0.075 }) => {
  const f = useCurrentFrame();
  const i = f % 8;
  const dx = (f * 137) % 512;
  const dy = (f * 251) % 512;
  return (
    <AbsoluteFill
      style={{
        backgroundImage: `url(${staticFile(`grao/${i}.png`)})`,
        backgroundSize: '512px 512px',
        backgroundPosition: `${dx}px ${dy}px`,
        mixBlendMode: 'overlay',
        opacity: forca,
        pointerEvents: 'none',
      }}
    />
  );
};

export const Vinheta: React.FC<{ forca?: number }> = ({ forca = 0.55 }) => (
  <AbsoluteFill style={{ background: `radial-gradient(75% 75% at 50% 50%, rgba(8,4,24,0) 55%, rgba(8,4,24,${forca}) 100%)`, pointerEvents: 'none' }} />
);

export function hexA(hex: string, a: number) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Imagem de uma sequência de quadros capturada da interface.
export const Quadro: React.FC<{ pasta: string; i: number; total: number; ext?: string; style?: React.CSSProperties }> = ({ pasta, i, total, ext = 'jpg', style }) => {
  const k = Math.max(0, Math.min(total - 1, Math.round(i)));
  return <Img src={staticFile(`${pasta}/${String(k).padStart(3, '0')}.${ext}`)} style={{ position: 'absolute', left: 0, top: 0, width: '100%', ...style }} />;
};
