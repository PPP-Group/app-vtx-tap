import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, E, F, anima, chaves, deriva } from '../marca';
import { Fundo, hexA } from '../comp/Ambiente';
import { Planta, PW, PH, MESA12, Mao } from '../comp/Planta';
import { Rotulo } from '../comp/Objetos';
import { projetar } from '../comp/Projecao';

// Caminhos da equipe pelo salão (passam pela mesa 12 sem parar).
const ROTA_A = [[300, 260], [420, 460], [700, 460], [900, 460], [900, 660], [700, 660], [420, 660], [250, 660], [250, 460]];
const ROTA_B = [[1280, 300], [1100, 460], [1100, 640], [880, 860], [600, 860], [420, 860]];
function naRota(rota: number[][], t: number) {
  const seg: number[] = [];
  let tot = 0;
  for (let i = 1; i < rota.length; i++) {
    const d = Math.hypot(rota[i][0] - rota[i - 1][0], rota[i][1] - rota[i - 1][1]);
    seg.push(d);
    tot += d;
  }
  let alvo = Math.max(0, Math.min(1, t)) * tot;
  for (let i = 0; i < seg.length; i++) {
    if (alvo <= seg[i]) {
      const k = alvo / seg[i];
      return [rota[i][0] + (rota[i + 1][0] - rota[i][0]) * k, rota[i][1] + (rota[i + 1][1] - rota[i][1]) * k];
    }
    alvo -= seg[i];
  }
  return rota[rota.length - 1];
}

export const CenaSalao: React.FC = () => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  // câmera
  const rx = chaves(f, [0, 186, 216], [56, 47, 0], E.entraSai);
  const rz = chaves(f, [0, 186, 216], [-16, -7, 0], E.entraSai);
  const s = chaves(f, [0, 186, 216], [vertical ? 1.02 : 0.86, vertical ? 1.36 : 1.16, vertical ? 4.4 : 4.4], E.entraSai);
  const foco = chaves(f, [0, 186, 216], [0, 0.6, 1], E.entraSai);
  const fx = PW / 2 + (MESA12.x - PW / 2) * foco + deriva(f, 1, 12);
  const fy = PH / 2 + (MESA12.y - PH / 2) * foco + deriva(f, 2, 8);
  const cx = width / 2;
  const cy = height * (vertical ? 0.5 : 0.52);
  const D = 2000;
  const cam = { d: D, rx, rz, s };

  // marcador da mesa 12: tempo de espera
  const seg = Math.max(0, Math.floor((f - 40) / 30));
  const tempo = 296 + seg; // 04:56 em segundos
  const alerta = tempo >= 300;
  const relogio = `${String(Math.floor(tempo / 60)).padStart(2, '0')}:${String(tempo % 60).padStart(2, '0')}`;
  const corMarca = alerta ? C.pimenta : C.ouro;
  const marcaOp = anima(f, 36, 50, 0, 1, E.linear) * anima(f, 196, 210, 1, 0, E.linear);
  const p12 = projetar(MESA12.x - fx, MESA12.y - fy, 0, cam);
  const pulso = ((f - 36) % 45) / 45;

  // equipe
  const a = naRota(ROTA_A, (f - 20) / 190);
  const b = naRota(ROTA_B, (f - 50) / 170);

  const sai = anima(f, 192, 216, 0, 1, E.entra);
  return (
    <AbsoluteFill style={{ background: C.preto }}>
      <Fundo luz={[{ x: 50, y: 55, r: 900, cor: C.roxoLo, forca: 0.22 }]} />
      <AbsoluteFill style={{ opacity: anima(f, 0, 18, 0, 1, E.linear) }}>
        <div
          style={{
            position: 'absolute',
            left: cx - fx,
            top: cy - fy,
            width: PW,
            height: PH,
            transformOrigin: `${fx}px ${fy}px`,
            transform: `perspective(${D}px) rotateX(${rx}deg) rotateZ(${rz}deg) scale(${s})`,
          }}
        >
          <Planta f={f} destaque12={anima(f, 36, 48, 0, 1)} esmaecer={sai * 0.9} />
          <svg width={PW} height={PH} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
            {/* onda de espera na mesa 12, no chão */}
            {f > 36 && (
              <circle cx={MESA12.x} cy={MESA12.y} r={60 + pulso * 90} fill="none" stroke={corMarca} strokeWidth={3} opacity={(1 - pulso) * 0.7 * marcaOp} />
            )}
            {/* equipe circulando */}
            {[a, b].map(([x, y], i) => (
              <g key={i} opacity={anima(f, 20 + i * 30, 36 + i * 30, 0, 0.95, E.linear) * (1 - sai)}>
                <circle cx={x} cy={y} r={22} fill={hexA(C.lavanda, 0.12)} />
                <circle cx={x} cy={y} r={10} fill={C.lavanda} />
              </g>
            ))}
          </svg>
        </div>
      </AbsoluteFill>
      {/* mão levantada e cronômetro (sempre de frente para a câmera) */}
      <svg width={width} height={height} style={{ position: 'absolute', left: 0, top: 0, opacity: marcaOp }}>
        <Mao x={cx + p12.x} y={cy + p12.y - 64 * Math.min(1.6, p12.escala)} tamanho={44 * Math.min(1.6, Math.max(0.9, p12.escala))} cor={corMarca} giro={Math.sin(f / 5) * 9} />
      </svg>
      <div
        style={{
          position: 'absolute',
          left: cx + p12.x + 46,
          top: cy + p12.y - 96,
          opacity: marcaOp,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '9px 16px',
          borderRadius: 999,
          background: hexA(C.preto, 0.78),
          boxShadow: `inset 0 0 0 1.5px ${hexA(corMarca, 0.8)}`,
          fontFamily: F.mono,
          fontWeight: 500,
          fontSize: 24,
          letterSpacing: '0.1em',
          color: C.branco,
        }}
      >
        <span style={{ color: hexA(C.lavanda, 0.7) }}>MESA 12</span>
        <span style={{ color: corMarca }}>{relogio}</span>
      </div>
      {/* rótulos */}
      <AbsoluteFill style={{ opacity: anima(f, 6, 26, 0, 1, E.linear) * anima(f, 176, 196, 1, 0, E.linear) }}>
        <Rotulo x={vertical ? 64 : 96} y={vertical ? 120 : 84} cor={C.lavanda} tamanho={vertical ? 26 : 22} ponto={C.ouro}>
          Quintal Bistrô · sexta, 20:41
        </Rotulo>
        <Rotulo x={vertical ? 64 : 96} y={vertical ? 164 : 120} cor={hexA(C.lilas, 0.85)} tamanho={vertical ? 22 : 18}>
          11 mesas ocupadas · 2 garçons
        </Rotulo>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: C.preto, opacity: interpolate(f, [200, 216], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) * 0 }} />
    </AbsoluteFill>
  );
};
