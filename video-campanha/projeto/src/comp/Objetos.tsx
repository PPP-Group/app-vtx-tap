import React from 'react';
import { Img, staticFile } from 'remotion';
import { C, F } from '../marca';
import { hexA } from './Ambiente';

// Plaquinha NFC (85,6 x 54 mm) com a arte real do projeto, em 3D.
export const Placa: React.FC<{
  img: string;
  largura: number;
  x?: number;
  y?: number;
  z?: number;
  rx?: number;
  ry?: number;
  rz?: number;
  brilho?: number; // posição do reflexo, -0.5 a 1.5
  borda?: string;
  sombra?: number;
  opacidade?: number;
}> = ({ img, largura, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, brilho = -1, borda = '#E7E3EE', sombra = 0.6, opacidade = 1 }) => {
  const altura = largura / 1.585;
  const raio = largura * 0.04;
  const esp = Math.max(4, largura * 0.012);
  const camadas = 6;
  return (
    <div
      style={{
        position: 'absolute',
        left: x - largura / 2,
        top: y - altura / 2,
        width: largura,
        height: altura,
        transformStyle: 'preserve-3d',
        transform: `translateZ(${z}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg)`,
        opacity: opacidade,
      }}
    >
      {sombra > 0 && (
        <div
          style={{
            position: 'absolute',
            inset: '6% 4% 2% 4%',
            borderRadius: raio,
            background: `rgba(6,3,18,${0.85 * sombra})`,
            filter: `blur(${largura * 0.03}px)`,
            transform: `translateZ(${-esp - 1}px) translateY(${largura * 0.02}px)`,
          }}
        />
      )}
      {Array.from({ length: camadas }).map((_, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: raio,
            background: i === camadas - 1 ? '#9a96a6' : borda,
            filter: `brightness(${0.78 - i * 0.04})`,
            transform: `translateZ(${-((i + 1) / camadas) * esp}px)`,
          }}
        />
      ))}
      <div style={{ position: 'absolute', inset: 0, borderRadius: raio, overflow: 'hidden', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.35)' }}>
        <Img src={staticFile(img)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        <div
          style={{
            position: 'absolute',
            inset: '-20%',
            background: 'linear-gradient(105deg, rgba(255,255,255,0) 38%, rgba(255,255,255,.42) 48%, rgba(255,255,255,.12) 53%, rgba(255,255,255,0) 62%)',
            transform: `translateX(${(brilho - 0.5) * 140}%)`,
            mixBlendMode: 'screen',
          }}
        />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(160deg, rgba(255,255,255,.08), rgba(0,0,0,.10))' }} />
      </div>
    </div>
  );
};

// Janela do navegador para o painel no computador.
export const Janela: React.FC<{
  largura: number;
  x: number;
  y: number;
  z?: number;
  rx?: number;
  ry?: number;
  rz?: number;
  url?: string;
  children?: React.ReactNode;
  opacidade?: number;
}> = ({ largura, x, y, z = 0, rx = 0, ry = 0, rz = 0, url = 'quintalbistro.com.br/admin', children, opacidade = 1 }) => {
  const W = 1440;
  const H = 900;
  const BARRA = 44;
  const k = largura / W;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: W,
        height: H + BARRA,
        marginLeft: -W / 2,
        marginTop: -(H + BARRA) / 2,
        transformStyle: 'preserve-3d',
        transform: `translateZ(${z}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) scale(${k})`,
        opacity: opacidade,
      }}
    >
      <div style={{ position: 'absolute', inset: 0, borderRadius: 16, boxShadow: '0 50px 120px rgba(4,2,14,.7), 0 0 0 1px rgba(255,255,255,.08)' }} />
      <div style={{ position: 'absolute', inset: 0, borderRadius: 16, overflow: 'hidden', background: '#F4F2F9' }}>
        <div style={{ position: 'relative', height: BARRA, background: '#1A1333', display: 'flex', alignItems: 'center', padding: '0 18px', gap: 8 }}>
          {[0, 1, 2].map((i) => (
            <span key={i} style={{ width: 12, height: 12, borderRadius: 6, background: 'rgba(255,255,255,.22)' }} />
          ))}
          <div
            style={{
              position: 'absolute',
              left: '50%',
              transform: 'translateX(-50%)',
              height: 28,
              padding: '0 18px',
              borderRadius: 14,
              background: 'rgba(255,255,255,.08)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: 'rgba(241,236,255,.78)',
              fontFamily: F.texto,
              fontSize: 14,
            }}
          >
            <svg width="11" height="13" viewBox="0 0 11 13"><path d="M2 6V4a3.5 3.5 0 0 1 7 0v2" stroke="currentColor" strokeWidth="1.5" fill="none" /><rect x=".5" y="6" width="10" height="6.5" rx="1.6" fill="currentColor" /></svg>
            {url}
          </div>
        </div>
        <div style={{ position: 'relative', width: W, height: H, overflow: 'hidden' }}>{children}</div>
      </div>
    </div>
  );
};

// Anéis concêntricos da marca (28%, 12%, 6%).
export const Aneis: React.FC<{ x: number; y: number; r: number; cor?: string; forca?: number; espessura?: number }> = ({ x, y, r, cor = C.roxo, forca = 1, espessura = 1 }) => {
  const e = r * 0.09 * espessura;
  return (
    <svg style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }} width="1" height="1">
      <circle cx={x} cy={y} r={r} fill="none" stroke={hexA(cor, 0.28 * forca)} strokeWidth={e} />
      <circle cx={x} cy={y} r={r + e * 0.5 + e * 1.1} fill="none" stroke={hexA(cor, 0.12 * forca)} strokeWidth={e * 2.2} />
      <circle cx={x} cy={y} r={r + e * 0.5 + e * 2.2 + e * 1.6} fill="none" stroke={hexA(cor, 0.06 * forca)} strokeWidth={e * 3.2} />
    </svg>
  );
};

// Pequeno rótulo em mono, caixa alta.
export const Rotulo: React.FC<{ children: React.ReactNode; x: number; y: number; cor?: string; tamanho?: number; opacidade?: number; alinhar?: 'left' | 'center' | 'right'; ponto?: string }> = ({ children, x, y, cor = C.lilas, tamanho = 22, opacidade = 1, alinhar = 'left', ponto }) => (
  <div
    style={{
      position: 'absolute',
      left: x,
      top: y,
      transform: alinhar === 'center' ? 'translateX(-50%)' : alinhar === 'right' ? 'translateX(-100%)' : undefined,
      fontFamily: F.mono,
      fontWeight: 500,
      fontSize: tamanho,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: cor,
      opacity: opacidade,
      whiteSpace: 'nowrap',
      display: 'flex',
      alignItems: 'center',
      gap: tamanho * 0.6,
    }}
  >
    {ponto && <span style={{ width: tamanho * 0.42, height: tamanho * 0.42, borderRadius: '50%', background: ponto }} />}
    {children}
  </div>
);
