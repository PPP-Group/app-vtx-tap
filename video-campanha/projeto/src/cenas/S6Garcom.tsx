import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, E, anima, cena, chaves, deriva, toque, marca } from '../marca';
import { Fundo, hexA } from '../comp/Ambiente';
import { Celular } from '../comp/Celular';
import { Aneis, Rotulo } from '../comp/Objetos';
import { Captura, Sequencia } from '../comp/Tela';
import { TelaGarcom } from './S5Sino';

const ini = cena('garcom');
const L = (abs: number) => abs - ini;

export const CenaGarcom: React.FC = () => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  const tIr = L(toque('garcom-ir'));
  const tCam = L(marca('cliente-caminho'));
  // dois celulares lado a lado depois do "Estou indo"
  const lado = anima(f, tIr + 14, tIr + 40, 0, 1, E.entraSai);
  const garX = vertical ? width / 2 + lado * 200 : width * (0.62 + 0.06 * lado);
  const garY = vertical ? height / 2 - lado * 120 : height / 2;
  const cliX = vertical ? width / 2 - 200 : width * 0.32;
  const cliY = vertical ? height / 2 + 160 : height / 2;
  const larg = vertical ? 600 - lado * 140 : 470 - lado * 40;
  const sai = anima(f, 128, 144, 0, 1, E.entra);
  // onda que sai do garçom e chega no cliente
  const viagem = anima(f, tIr + 26, tCam, 0, 1, E.entraSai);
  const ox = garX + (cliX - garX) * viagem;
  const oy = garY - 260 * Math.sin(viagem * Math.PI) * (vertical ? 0.4 : 1);
  return (
    <AbsoluteFill style={{ background: C.preto, overflow: 'hidden' }}>
      <Fundo luz={[{ x: 50, y: 50, r: 1200, cor: C.roxoLo, forca: 0.2 }]} />
      <Aneis x={garX} y={garY} r={vertical ? 520 : 450} forca={0.8 * (1 - lado * 0.6)} />
      <div style={{ position: 'absolute', inset: 0, perspective: 2200, opacity: 1 - sai }}>
        {/* cliente entra pela esquerda */}
        {lado > 0 && (
          <Celular
            x={cliX - (1 - lado) * (vertical ? 500 : 700)}
            y={cliY + deriva(f, 31, 4)}
            largura={larg}
            ry={vertical ? 0 : 8 * lado}
            barra="escura"
            fundoBarra="rgba(244,242,249,.94)"
            opacidade={lado}
          >
            {f < tCam ? <Captura src="cliente/sino-enviado-3.png" /> : f < tCam + 19 ? <Sequencia pasta="cliente/sino-caminho" i={f - tCam} total={19} /> : <Captura src="cliente/sino-caminho.png" />}
          </Celular>
        )}
        <Celular x={garX + deriva(f, 32, 4)} y={garY + deriva(f, 33, 4)} largura={larg} ry={vertical ? 0 : -8} rx={2} barra="escura">
          <TelaGarcom f={f} chega={-1000} ir={tIr} />
        </Celular>
      </div>
      {/* onda de sincronização */}
      {viagem > 0 && viagem < 1 && (
        <svg width={width} height={height} style={{ position: 'absolute', left: 0, top: 0 }}>
          {[0, 1, 2].map((i) => (
            <circle key={i} cx={ox} cy={oy} r={16 + i * 16} fill="none" stroke={C.lilas} strokeWidth={4 - i} opacity={(0.9 - i * 0.25) * Math.sin(viagem * Math.PI)} />
          ))}
          <circle cx={ox} cy={oy} r={7} fill={C.lavanda} />
        </svg>
      )}
      {/* chegada da onda no cliente */}
      {f >= tCam && f < tCam + 24 && (
        <div style={{ position: 'absolute', left: cliX - 300, top: cliY - 300, width: 600, height: 600, borderRadius: '50%', border: `3px solid ${hexA(C.lilas, 0.8)}`, transform: `scale(${0.4 + ((f - tCam) / 24) * 0.9})`, opacity: 1 - (f - tCam) / 24 }} />
      )}
      <div style={{ opacity: 1 - sai }}>
        <Rotulo x={vertical ? 64 : 120} y={vertical ? 120 : 84} cor={C.lavanda} ponto={C.ouro} tamanho={vertical ? 26 : 22} opacidade={anima(f, 0, 10, 1, 1) * (1 - lado)}>
          Celular do garçom
        </Rotulo>
        <Rotulo x={garX} y={garY + larg * 1.05 + 14} alinhar="center" cor={C.lavanda} tamanho={20} opacidade={lado}>
          Caio · garçom
        </Rotulo>
        <Rotulo x={cliX} y={cliY + larg * 1.05 + 14} alinhar="center" cor={C.lavanda} tamanho={20} opacidade={lado}>
          Marina · mesa 12
        </Rotulo>
      </div>
    </AbsoluteFill>
  );
};
