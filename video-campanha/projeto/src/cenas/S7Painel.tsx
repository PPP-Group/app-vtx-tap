import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, E, anima, cena, chaves, deriva, marca } from '../marca';
import { Fundo } from '../comp/Ambiente';
import { Celular } from '../comp/Celular';
import { Janela, Rotulo } from '../comp/Objetos';
import { Captura } from '../comp/Tela';

const ini = cena('painel');
const L = (abs: number) => abs - ini;
const cap = (n: string) => staticFile(`capturas/${n}`);

const TelaPainel: React.FC<{ f: number }> = ({ f }) => {
  const tChega = L(marca('painel-chega'));
  const tCam = L(marca('painel-caminho'));
  const img = (src: string) => <Img src={cap(src)} style={{ position: 'absolute', left: 0, top: 0, width: 1440 }} />;
  if (f < tChega) return img('painel/chamados-antes.png');
  if (f < tChega + 46) return img(`painel/chegou/${String(f - tChega).padStart(3, '0')}.jpg`);
  if (f < tCam) return img('painel/chamados.png');
  if (f < tCam + 19) return img(`painel/caminho/${String(f - tCam).padStart(3, '0')}.jpg`);
  return img('painel/chamados-caminho.png');
};

export const CenaPainel: React.FC = () => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  const entra = anima(f, 0, 26, 0, 1, E.saida);
  const sai = anima(f, 132, 144, 0, 1, E.entra);
  const larg = vertical ? 1000 : 1380;
  const jx = vertical ? width / 2 : width * 0.42 + (1 - entra) * 260;
  const jy = vertical ? height * 0.36 : height * 0.5;
  const ry = chaves(f, [0, 144], [-16, -6], E.entraSai) * (vertical ? 0.3 : 1);
  return (
    <AbsoluteFill style={{ background: C.preto, overflow: 'hidden' }}>
      <Fundo luz={[{ x: 45, y: 45, r: 1300, cor: C.roxoLo, forca: 0.22 }]} />
      <div style={{ position: 'absolute', inset: 0, perspective: 2600, opacity: entra * (1 - sai) }}>
        <Janela largura={larg} x={jx + deriva(f, 41, 6)} y={jy + deriva(f, 42, 4)} rx={4} ry={ry} z={-40}>
          <TelaPainel f={f} />
        </Janela>
        <Celular
          x={vertical ? width * 0.7 : width * 0.875}
          y={(vertical ? height * 0.74 : height * 0.6) + (1 - anima(f, 10, 40, 0, 1, E.saida)) * 500}
          largura={vertical ? 420 : 280}
          ry={vertical ? -6 : -14}
          rx={3}
          z={60}
          barra="escura"
        >
          <Captura src="garcom/turno.png" />
        </Celular>
      </div>
      <div style={{ opacity: anima(f, 8, 22, 0, 1, E.linear) * (1 - sai) }}>
        <Rotulo x={vertical ? 64 : 96} y={vertical ? 120 : 64} cor={C.lavanda} ponto={C.ouro} tamanho={vertical ? 26 : 22}>
          Painel · computador do caixa
        </Rotulo>
        <Rotulo x={vertical ? width * 0.7 : width * 0.875} y={vertical ? height * 0.74 + 470 : height * 0.6 + 310} alinhar="center" cor={C.lavanda} tamanho={20}>
          Celular da equipe
        </Rotulo>
      </div>
    </AbsoluteFill>
  );
};
