import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, E, anima, chaves, deriva } from '../marca';
import { Mesa, CamMesa } from '../comp/Mesa';
import { Titulo } from '../comp/Titulo';

// Câmera da mesa compartilhada pelas cenas 2 e 3 (quadro local da cena 2).
export function camMesa(f: number, vertical: boolean): CamMesa {
  const rx = chaves(f, [0, 120, 360], [0, 54, 58], E.saida);
  const rz = chaves(f, [0, 120, 360], [-26, -9, -4], E.saida);
  const s = chaves(f, [0, 120, 360], [vertical ? 1.2 : 1.42, vertical ? 0.8 : 0.92, vertical ? 0.76 : 0.86], E.saida);
  return { rx: rx + deriva(f, 3, 0.6), rz: rz + deriva(f, 4, 0.5), s, tx: deriva(f, 5, 10), ty: deriva(f, 6, 6) };
}

export const CenaPlaca: React.FC = () => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  const cam = camMesa(f, vertical);
  const brilho = anima(f, 18, 84, -0.35, 1.35, E.entraSai);
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <AbsoluteFill style={{ opacity: anima(f, 0, 14, 0, 1, E.linear) }}>
        <Mesa cam={cam} cx={width / 2} cy={height * (vertical ? 0.44 : 0.47)} brilho={brilho} luz={anima(f, 0, 40, 0.6, 1)} />
      </AbsoluteFill>
      <Titulo
        f={f}
        de={24}
        ate={132}
        linhas={vertical ? ['Agora', 'a mesa', 'chama.'] : ['Agora a mesa chama.']}
        x={vertical ? 64 : 120}
        y={vertical ? height - 230 : height - 110}
        tamanho={vertical ? 150 : 132}
      />
    </AbsoluteFill>
  );
};
