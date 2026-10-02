import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, E, anima } from '../marca';
import { Fundo } from '../comp/Ambiente';
import { Aneis, Placa, Rotulo } from '../comp/Objetos';
import { Titulo } from '../comp/Titulo';

const PLACAS = [
  { img: 'marca/placa-padrao.webp', nome: 'Padrão', borda: '#E7E3EE' },
  { img: 'marca/placa-personalizada-basica.webp', nome: 'Com a sua logo', borda: '#EDE7E2' },
  { img: 'marca/placa-sob-demanda.webp', nome: 'Sob demanda', borda: '#123B2C' },
];

export const CenaPlacas: React.FC = () => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  const sai = anima(f, 128, 144, 0, 1, E.entra);
  return (
    <AbsoluteFill style={{ background: C.preto, overflow: 'hidden' }}>
      <Fundo luz={[{ x: 50, y: 55, r: 1300, cor: C.roxoLo, forca: 0.24 }]} />
      <Aneis x={width / 2} y={height * 0.55} r={vertical ? 460 : 520} forca={0.7} />
      <div style={{ position: 'absolute', inset: 0, perspective: 2000 }}>
        {PLACAS.map((p, i) => {
          const entra = anima(f, i * 6, i * 6 + 26, 0, 1, E.saida);
          const x = vertical ? width / 2 : width * (0.2 + i * 0.3);
          const y = vertical ? height * (0.37 + i * 0.215) : height * 0.56;
          const larg = vertical ? 500 : 500;
          const ry = Math.sin(f / 34 + i * 1.3) * 16 + (vertical ? 0 : (i - 1) * -10);
          const rx = 12 + Math.sin(f / 41 + i) * 5;
          const z = -sai * 600 + (1 - entra) * -400;
          return (
            <React.Fragment key={i}>
              <Placa img={p.img} largura={larg} x={x} y={y + (1 - entra) * 260} z={z} rx={rx} ry={ry} rz={Math.sin(f / 52 + i) * 2} brilho={anima(f, 20 + i * 8, 90 + i * 8, -0.4, 1.4, E.entraSai)} borda={p.borda} sombra={0.5} opacidade={entra * (1 - sai)} />
              <Rotulo x={x} y={y + larg * 0.36 + 34 + (1 - entra) * 260} alinhar="center" cor={C.lavanda} tamanho={20} opacidade={anima(f, 18 + i * 6, 30 + i * 6, 0, 1, E.linear) * (1 - sai)}>
                {p.nome}
              </Rotulo>
            </React.Fragment>
          );
        })}
      </div>
      <Titulo f={f} de={16} ate={126} linhas={vertical ? ['Na mesa,', 'no balcão,', 'na parede.'] : ['Na mesa, no balcão, na parede.']} x={vertical ? 64 : width / 2} y={vertical ? 430 : height * 0.24} tamanho={vertical ? 110 : 108} alinhar={vertical ? 'left' : 'center'} />
    </AbsoluteFill>
  );
};
