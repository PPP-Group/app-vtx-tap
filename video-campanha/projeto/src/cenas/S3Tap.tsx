import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, E, F, anima, chaves, deriva } from '../marca';
import { Mesa, TAMPO_L, TAMPO_A } from '../comp/Mesa';
import { Celular } from '../comp/Celular';
import { Aneis, Rotulo } from '../comp/Objetos';
import { Titulo } from '../comp/Titulo';
import { Fundo } from '../comp/Ambiente';
import { camMesa } from './S2Placa';

export const TAP = 72; // quadro local do toque (0:14.4)

// Posição final do celular (início da cena 4).
export function celularFinal(width: number, height: number) {
  const vertical = height > width;
  return vertical
    ? { x: width * 0.5, y: height * 0.56, largura: 600, ry: 0 }
    : { x: width * 0.69, y: height * 0.5, largura: 470, ry: -12 };
}

export const TelaBloqueio: React.FC<{ f: number }> = ({ f }) => (
  <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(120% 80% at 30% 10%, #3a2a6e 0%, #140b33 45%, #07040f 100%)' }}>
    <div style={{ position: 'absolute', top: 120, width: '100%', textAlign: 'center', color: '#f4f0ff', fontFamily: '"Schibsted Grotesk"', fontSize: 19, fontWeight: 500, opacity: 0.85 }}>
      sexta-feira, 2 de outubro
    </div>
    <div style={{ position: 'absolute', top: 140, width: '100%', textAlign: 'center', color: '#f4f0ff', fontFamily: 'Sora', fontWeight: 300, fontSize: 92, letterSpacing: '-0.02em' }}>
      20:41
    </div>
  </div>
);

export const CenaTap: React.FC = () => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  const cam = camMesa(f + 144, vertical);
  const cx = width / 2;
  const cy = height * (vertical ? 0.44 : 0.47);
  const fim = celularFinal(width, height);

  // descida até a placa, toque, depois sobe e vira para a câmera
  const u = anima(f, TAP + 22, TAP + 82, 0, 1, E.entraSai);
  const desce = anima(f, 2, TAP - 2, 0, 1, E.saida);
  const quique = f >= TAP - 2 && f < TAP + 10 ? Math.sin(((f - TAP + 2) / 12) * Math.PI) * -10 : 0;
  const pz = (1 - u) * (1150 - desce * 1110 + quique);
  const dx = (1 - u) * (640 - desce * 470);
  const dy = (1 - u) * (-260 + desce * 210);
  const yaw = (1 - u) * (-24 + desce * 12);
  const inclina = (1 - u) * (1 - desce) * 22;
  const A = cam.rx * (1 - u);
  const B = cam.rz * (1 - u);
  const S = cam.s + (1 - cam.s) * u;
  const tx = (cam.tx ?? 0) * (1 - u) + (fim.x - cx) * u;
  const ty = (cam.ty ?? 0) * (1 - u) + (fim.y - cy) * u;
  const larg = 640 + (fim.largura - 640) * u;

  // ondas no tampo, a partir do ponto de contato
  const ondas = [0, 7, 14].map((d, i) => {
    const t = (f - TAP - d) / 58;
    return t > 0 && t < 1 ? (
      <circle key={i} cx={TAMPO_L / 2 + 170} cy={TAMPO_A / 2 - 50} r={70 + t * 1500} fill="none" stroke={C.roxo} strokeWidth={22 - t * 14} opacity={(1 - t) * 0.75} />
    ) : null;
  });

  const mesaOp = anima(f, TAP + 30, TAP + 80, 1, 0, E.entraSai);
  const fundoOp = anima(f, TAP + 24, TAP + 80, 0, 1, E.linear);
  const acende = anima(f, TAP + 3, TAP + 8, 0, 1, E.linear);
  const pagina = anima(f, TAP + 8, TAP + 20, 0, 1, E.saida);

  return (
    <AbsoluteFill style={{ background: C.preto, overflow: 'hidden' }}>
      <AbsoluteFill style={{ opacity: fundoOp }}>
        <Fundo luz={[{ x: (fim.x / width) * 100, y: 50, r: 1100, cor: C.roxo, forca: 0.22 }]} />
        <Aneis x={fim.x} y={fim.y} r={(vertical ? 520 : 470) * (0.7 + 0.3 * fundoOp)} forca={0.9 * fundoOp} />
      </AbsoluteFill>
      <AbsoluteFill style={{ opacity: mesaOp }}>
        <Mesa
          cam={cam}
          cx={cx}
          cy={cy}
          brilho={1.4}
          luz={1}
          extra={
            <svg width={TAMPO_L} height={TAMPO_A} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', transform: 'translateZ(3px)' }}>
              {ondas}
            </svg>
          }
        />
      </AbsoluteFill>
      {/* celular: mesmo espaço 3D do tampo, até subir e encarar a câmera */}
      <div
        style={{
          position: 'absolute',
          left: cx - TAMPO_L / 2,
          top: cy - TAMPO_A / 2,
          width: TAMPO_L,
          height: TAMPO_A,
          transformOrigin: '50% 50%',
          transformStyle: 'preserve-3d',
          transform: `perspective(2200px) translate3d(${tx}px, ${ty}px, 0) rotateX(${A}deg) rotateZ(${B}deg) scale(${S})`,
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: TAMPO_L / 2 + dx,
            top: TAMPO_A / 2 + dy,
            width: 0,
            height: 0,
            transformStyle: 'preserve-3d',
            transform: `translateZ(${pz}px) rotateZ(${yaw}deg) rotateX(${inclina}deg)`,
          }}
        >
          <Celular x={0} y={0} largura={larg} ry={fim.ry * u + deriva(f, 7, 1.2) * u} barra="clara" sombra={u > 0.5}>
            <TelaBloqueio f={f} />
            <div style={{ position: 'absolute', inset: 0, background: '#fff', opacity: acende * (1 - pagina) }} />
            <Img src={staticFile('capturas/cliente/inicio.png')} style={{ position: 'absolute', left: 0, top: 0, width: 390, opacity: pagina, transform: `translateY(${(1 - pagina) * 24}px)` }} />
          </Celular>
        </div>
      </div>
      <Titulo
        f={f}
        de={TAP + 46}
        ate={206}
        linhas={vertical ? ['Sem aplicativo.', { t: 'Só aproximar.', cor: C.lilas }] : ['Sem aplicativo.', { t: 'Só aproximar.', cor: C.lilas }]}
        x={vertical ? 64 : 120}
        y={vertical ? 330 : height / 2 + 120}
        tamanho={vertical ? 120 : 132}
      />
      <Rotulo x={vertical ? 64 : 124} y={vertical ? 120 : height / 2 + 150} opacidade={anima(f, TAP + 60, TAP + 76, 0, 1, E.linear) * anima(f, 196, 210, 1, 0, E.linear)}>
        NFC ou QR Code · abre no navegador
      </Rotulo>
    </AbsoluteFill>
  );
};
