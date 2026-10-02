import React from 'react';
import { F } from '../marca';

// Celular em 3D. Tela em pontos (390 x 844), a mesma grade das capturas.
export const TELA_L = 390;
export const TELA_A = 844;
const BORDA = 11;
const CORPO_L = TELA_L + BORDA * 2;
const CORPO_A = TELA_A + BORDA * 2;
const R_CORPO = 60;
const R_TELA = 49;
const ESPESSURA = 34;
const CAMADAS = 10;

type Props = {
  x: number;
  y: number;
  z?: number;
  rx?: number;
  ry?: number;
  rz?: number;
  largura: number; // largura do corpo em px
  barra?: 'clara' | 'escura' | 'nenhuma';
  hora?: string;
  apagada?: number; // 0 = tela acesa, 1 = apagada
  tremor?: number;
  opacidade?: number;
  children?: React.ReactNode;
  sombra?: boolean;
  fundoBarra?: string; // cor atrás da barra de status quando a página está rolada
};

export const Celular: React.FC<Props> = ({ x, y, z = 0, rx = 0, ry = 0, rz = 0, largura, barra = 'escura', hora = '20:41', apagada = 0, tremor = 0, opacidade = 1, children, sombra = true, fundoBarra }) => {
  const k = largura / CORPO_L;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: CORPO_L,
        height: CORPO_A,
        marginLeft: -CORPO_L / 2,
        marginTop: -CORPO_A / 2,
        transformStyle: 'preserve-3d',
        transform: `translate3d(${tremor}px, 0, ${z}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) scale(${k})`,
        opacity: opacidade,
      }}
    >
      {/* espessura: camadas atrás do corpo */}
      {Array.from({ length: CAMADAS }).map((_, i) => {
        const t = (i + 1) / CAMADAS;
        const luz = 22 + Math.round(18 * Math.sin(t * Math.PI));
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: R_CORPO,
              transform: `translateZ(${-t * ESPESSURA}px)`,
              background: `rgb(${luz}, ${luz - 4}, ${luz + 10})`,
            }}
          />
        );
      })}
      {/* sombra projetada suave atrás */}
      {sombra && (
        <div style={{ position: 'absolute', inset: 30, borderRadius: R_CORPO, transform: `translateZ(${-ESPESSURA - 2}px)`, boxShadow: '0 40px 90px rgba(4,2,14,.75)' }} />
      )}
      {/* corpo: aro de metal */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: R_CORPO,
          background: 'linear-gradient(135deg, #5a5566 0%, #26222f 18%, #1a1722 50%, #2c2836 82%, #6a6578 100%)',
          boxShadow: 'inset 0 0 0 1.5px rgba(255,255,255,.18), inset 0 0 0 4px #0b0910',
        }}
      />
      {/* moldura preta + tela */}
      <div style={{ position: 'absolute', inset: 4, borderRadius: R_CORPO - 4, background: '#050408' }} />
      <div
        style={{
          position: 'absolute',
          left: BORDA,
          top: BORDA,
          width: TELA_L,
          height: TELA_A,
          borderRadius: R_TELA,
          overflow: 'hidden',
          background: '#000',
          transform: 'translateZ(0.5px)',
        }}
      >
        {children}
        {fundoBarra && <div style={{ position: 'absolute', left: 0, top: 0, width: TELA_L, height: 47, background: fundoBarra }} />}
        {barra !== 'nenhuma' && <BarraStatus cor={barra === 'clara' ? '#FFFFFF' : '#160E33'} hora={hora} />}
        {/* ilha */}
        <div style={{ position: 'absolute', left: (TELA_L - 122) / 2, top: 11, width: 122, height: 35, borderRadius: 18, background: '#000' }} />
        {/* indicador de início */}
        {barra !== 'nenhuma' && (
          <div style={{ position: 'absolute', left: (TELA_L - 134) / 2, bottom: 8, width: 134, height: 5, borderRadius: 3, background: barra === 'clara' ? 'rgba(255,255,255,.85)' : 'rgba(22,14,51,.85)' }} />
        )}
        {/* tela apagada */}
        {apagada > 0 && <div style={{ position: 'absolute', inset: 0, background: '#000', opacity: apagada }} />}
        {/* reflexo do vidro */}
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(118deg, rgba(255,255,255,.10) 0%, rgba(255,255,255,.03) 28%, rgba(255,255,255,0) 42%)', pointerEvents: 'none' }} />
      </div>
    </div>
  );
};

const BarraStatus: React.FC<{ cor: string; hora: string }> = ({ cor, hora }) => (
  <div style={{ position: 'absolute', left: 0, top: 0, width: TELA_L, height: 47, color: cor, fontFamily: F.texto, pointerEvents: 'none' }}>
    <span style={{ position: 'absolute', left: 38, top: 15, fontSize: 16.5, fontWeight: 600, letterSpacing: '-.01em' }}>{hora}</span>
    <svg style={{ position: 'absolute', right: 30, top: 18 }} width="74" height="13" viewBox="0 0 74 13">
      <g fill={cor}>
        <rect x="0" y="8" width="3.2" height="4.5" rx="1" />
        <rect x="4.8" y="5.5" width="3.2" height="7" rx="1" />
        <rect x="9.6" y="3" width="3.2" height="9.5" rx="1" />
        <rect x="14.4" y="0.5" width="3.2" height="12" rx="1" />
        <path d="M29 3.2a10.5 10.5 0 0 1 14 0l-1.4 1.5a8.4 8.4 0 0 0-11.2 0Z M31.4 5.8a7 7 0 0 1 9.2 0l-1.5 1.5a4.9 4.9 0 0 0-6.2 0Z M33.9 8.4a3.4 3.4 0 0 1 4.2 0L36 10.6Z" />
        <rect x="49" y="1" width="21" height="11" rx="3.4" fill="none" stroke={cor} strokeOpacity=".45" strokeWidth="1" />
        <rect x="50.8" y="2.8" width="15.5" height="7.4" rx="2" />
        <path d="M71.5 4.6v3.8a1.9 1.9 0 0 0 0-3.8Z" fillOpacity=".5" />
      </g>
    </svg>
  </div>
);

// Indicador de toque: círculo que aparece, aperta e solta uma onda.
export const Toque: React.FC<{ f: number; x: number; y: number; segurar?: number; cor?: string }> = ({ f, x, y, segurar = 0, cor = 'rgba(20, 11, 51, .5)' }) => {
  // f = quadros desde o toque (negativo = antes)
  if (f < -7 || f > 16 + segurar) return null;
  const entra = Math.min(1, (f + 7) / 7);
  const apertado = f >= 0 && f <= 3 + segurar;
  const sai = f > 3 + segurar ? Math.max(0, 1 - (f - 3 - segurar) / 9) : 1;
  const escala = (0.7 + 0.3 * entra) * (apertado ? 0.86 : 1);
  const onda = f >= 0 ? Math.min(1, f / 12) : 0;
  return (
    <>
      {f >= 0 && (
        <div
          style={{
            position: 'absolute',
            left: x - 30,
            top: y - 30,
            width: 60,
            height: 60,
            borderRadius: '50%',
            border: '2px solid rgba(255,255,255,.9)',
            transform: `scale(${0.6 + onda * 1.1})`,
            opacity: (1 - onda) * 0.8,
            boxShadow: '0 0 0 1px rgba(20,11,51,.25)',
          }}
        />
      )}
      <div
        style={{
          position: 'absolute',
          left: x - 23,
          top: y - 23,
          width: 46,
          height: 46,
          borderRadius: '50%',
          background: 'rgba(255,255,255,.62)',
          border: `1.5px solid ${cor}`,
          boxShadow: '0 4px 14px rgba(20,11,51,.28)',
          transform: `scale(${escala})`,
          opacity: entra * sai,
        }}
      />
    </>
  );
};
