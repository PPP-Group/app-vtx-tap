import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import './fontes';
import { C } from './marca';
import CORTES from './cortes.json';
import { Grao, Vinheta, Fundo } from './comp/Ambiente';
import { Aneis } from './comp/Objetos';
import { AssinaturaCurta } from './comp/Logos';
import { Cenas } from './Filme';
import estado from './audio.json';

export const duracaoCorte = (nome: keyof typeof CORTES) => CORTES[nome].trechos.reduce((t, [a, b]) => t + b - a, 0) + CORTES[nome].final;

const FinalCurto: React.FC = () => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  return (
    <AbsoluteFill style={{ background: C.preto }}>
      <Fundo luz={[{ x: 50, y: 50, r: 1200, cor: C.roxoLo, forca: 0.26 }]} />
      <Aneis x={width / 2} y={height / 2 - 60} r={vertical ? 420 : 470} forca={Math.min(1, f / 20) * 0.9} />
      <AssinaturaCurta f={f} largura={width} altura={height} vertical={vertical} />
    </AbsoluteFill>
  );
};

export const Corte: React.FC<{ nome: 'Corte30' | 'Corte15' }> = ({ nome }) => {
  const c = CORTES[nome];
  let pos = 0;
  const trechos = c.trechos.map(([a, b], i) => {
    const el = (
      <Sequence key={i} from={pos} durationInFrames={b - a} name={`trecho ${a}-${b}`}>
        <Sequence from={-a}>
          <Cenas />
        </Sequence>
      </Sequence>
    );
    pos += b - a;
    return el;
  });
  return (
    <AbsoluteFill style={{ background: C.preto }}>
      {trechos}
      <Sequence from={pos} durationInFrames={c.final} name="assinatura">
        <FinalCurto />
      </Sequence>
      <Vinheta forca={0.42} />
      <Grao forca={0.085} />
      {estado.mix && <Audio src={staticFile(`audio/${nome.toLowerCase()}.wav`)} />}
    </AbsoluteFill>
  );
};
