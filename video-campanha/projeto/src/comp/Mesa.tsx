import React from 'react';
import { Img, staticFile } from 'remotion';
import { Placa } from './Objetos';

// Tampo da mesa 12 com a plaquinha, em 3D. Câmera = rotações do tampo.
export const TAMPO_L = 3400;
export const TAMPO_A = 2300;
export const PLACA_L = 760;

export type CamMesa = { rx: number; rz: number; s: number; tx?: number; ty?: number; d?: number };

export const transformMesa = (c: CamMesa) =>
  `perspective(${c.d ?? 2200}px) translate3d(${c.tx ?? 0}px, ${c.ty ?? 0}px, 0) rotateX(${c.rx}deg) rotateZ(${c.rz}deg) scale(${c.s})`;

export const Mesa: React.FC<{
  cam: CamMesa;
  cx: number;
  cy: number;
  brilho: number;
  luz?: number;
  opacidade?: number;
  desfoque?: number;
  placaZ?: number;
  extra?: React.ReactNode; // objetos sobre o tampo (coordenadas do tampo, centro = placa)
}> = ({ cam, cx, cy, brilho, luz = 1, opacidade = 1, desfoque = 0, placaZ = 1, extra }) => (
  <div
    style={{
      position: 'absolute',
      left: cx - TAMPO_L / 2,
      top: cy - TAMPO_A / 2,
      width: TAMPO_L,
      height: TAMPO_A,
      transformOrigin: '50% 50%',
      transform: transformMesa(cam),
      transformStyle: 'preserve-3d',
      opacity: opacidade,
      filter: desfoque ? `blur(${desfoque}px)` : undefined,
    }}
  >
    <Img src={staticFile('marca/madeira.jpg')} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
    {/* fundo do tampo desfocado (profundidade de campo) */}
    <Img
      src={staticFile('marca/madeira.jpg')}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        filter: 'blur(7px)',
        WebkitMaskImage: 'linear-gradient(to bottom, #000 0%, rgba(0,0,0,.6) 28%, transparent 46%)',
      }}
    />
    {/* luz quente sobre a mesa e escuridão nas bordas */}
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: `radial-gradient(30% 36% at 52% 47%, rgba(255,184,110,${0.34 * luz}) 0%, rgba(255,150,70,${0.12 * luz}) 45%, rgba(0,0,0,0) 70%), radial-gradient(52% 54% at 50% 50%, rgba(0,0,0,0) 34%, rgba(6,3,12,.9) 82%, rgba(6,3,12,1) 100%)`,
        mixBlendMode: 'normal',
      }}
    />
    <Placa img="marca/placa-padrao.webp" largura={PLACA_L} x={TAMPO_L / 2} y={TAMPO_A / 2} z={placaZ} brilho={brilho} sombra={0.85} />
    {extra}
  </div>
);
