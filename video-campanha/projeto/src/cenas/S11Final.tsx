import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, E, anima } from '../marca';
import { Fundo } from '../comp/Ambiente';
import { Aneis } from '../comp/Objetos';
import { AssinaturaFinal, TextosFinais } from '../comp/Logos';

export const CenaFinal: React.FC = () => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  // anéis: pulsam com as ondas, depois recuam para o letreiro
  const pulso = (a: number) => anima(f, a, a + 30, 0, 1, E.saida);
  const aneisR = (vertical ? 420 : 470) + 60 * pulso(36);
  const aneisF = anima(f, 0, 20, 0, 0.9, E.linear) * anima(f, 144, 190, 1, 0.35, E.entraSai);
  const escuro = anima(f, 336, 360, 0, 1, E.entraSai);
  return (
    <AbsoluteFill style={{ background: C.preto, overflow: 'hidden' }}>
      <Fundo luz={[{ x: 50, y: 50, r: 1200, cor: C.roxoLo, forca: 0.26 }]} />
      <Aneis x={width / 2} y={height / 2} r={aneisR} forca={aneisF} />
      {[36, 42, 48].map((a, i) => {
        const t = (f - a) / 40;
        if (t < 0 || t > 1) return null;
        return (
          <svg key={i} width={width} height={height} style={{ position: 'absolute', left: 0, top: 0 }}>
            <circle cx={width / 2} cy={height / 2} r={300 + t * 700} fill="none" stroke={C.roxo} strokeWidth={10 * (1 - t)} opacity={(1 - t) * 0.5} />
          </svg>
        );
      })}
      <AssinaturaFinal f={f} largura={width} altura={height} vertical={vertical} />
      <TextosFinais f={f} largura={width} altura={height} vertical={vertical} />
      <AbsoluteFill style={{ background: C.preto, opacity: escuro }} />
    </AbsoluteFill>
  );
};
