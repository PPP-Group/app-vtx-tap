import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, E, anima, cena, deriva, toque } from '../marca';
import { Fundo } from '../comp/Ambiente';
import { Celular, Toque } from '../comp/Celular';
import { Aneis, Janela, Rotulo } from '../comp/Objetos';
import { Titulo } from '../comp/Titulo';
import { Captura } from '../comp/Tela';

const ini = cena('extras');
const L = (abs: number) => abs - ini;

// Cartão com o simulador de serviços do site (captura real da página de orçamento).
const CartaoServicos: React.FC<{ f: number; tFid: number; tDel: number; largura: number }> = ({ f, tFid, tDel, largura }) => {
  const k = largura / 651;
  const src = f < tFid + 1 ? 'servicos-0.png' : f < tDel + 1 ? 'servicos-fid.png' : 'servicos-fid-del.png';
  return (
    <div style={{ position: 'relative', width: 651, height: 583, transform: `scale(${k})`, transformOrigin: '0 0' }}>
      <Img src={staticFile(`capturas/orcamento/${src}`)} style={{ width: 651, height: 583, borderRadius: 28, boxShadow: '0 40px 100px rgba(4,2,14,.7)' }} />
      <Toque f={f - tFid} x={68} y={327} cor="rgba(255,255,255,.5)" />
      <Toque f={f - tDel} x={68} y={436} cor="rgba(255,255,255,.5)" />
    </div>
  );
};

export const CenaExtras: React.FC = () => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  const tFid = L(toque('extras-fid'));
  const tDel = L(toque('extras-del'));
  const cartaoSai = anima(f, 150, 174, 0, 1, E.entraSai);
  const janela = anima(f, 154, 182, 0, 1, E.saida);
  const sai = anima(f, 204, 216, 0, 1, E.entra);
  const cel = vertical ? { x: width * 0.68, y: height * 0.66, l: 440 } : { x: width * 0.76, y: height * 0.54, l: 430 };
  const cartaoL = vertical ? 760 : 800;
  // tela do celular
  const sobeFid = anima(f, tFid + 4, tFid + 18, 0, 1, E.saida);
  const entraDel = anima(f, tDel + 4, tDel + 18, 0, 1, E.saida);
  const acompanhar = anima(f, 176, 184, 0, 1, E.linear);
  return (
    <AbsoluteFill style={{ background: C.preto, overflow: 'hidden' }}>
      <Fundo luz={[{ x: 70, y: 50, r: 1100, cor: C.roxo, forca: 0.2 }, { x: 25, y: 55, r: 900, cor: C.ouro, forca: 0.05 * sobeFid }]} />
      <Aneis x={cel.x} y={cel.y} r={vertical ? 460 : 430} forca={0.8} />
      <div style={{ position: 'absolute', inset: 0, perspective: 2400, opacity: 1 - sai }}>
        {janela > 0 && (
          <Janela largura={vertical ? 900 : 1040} x={vertical ? width * 0.42 : width * 0.37 + (1 - janela) * -300} y={vertical ? height * 0.36 : height * 0.62} ry={vertical ? 0 : 14} rx={3} z={-80} opacidade={janela}>
            <Img src={staticFile('capturas/painel/delivery.png')} style={{ width: 1440 }} />
          </Janela>
        )}
        <div
          style={{
            position: 'absolute',
            left: vertical ? (width - cartaoL) / 2 : width * 0.08,
            top: vertical ? height * 0.17 : height * 0.27,
            transform: `perspective(2400px) rotateY(${vertical ? 0 : 12}deg) translateX(${-cartaoSai * 900}px)`,
            opacity: anima(f, 0, 14, 0, 1, E.linear) * (1 - cartaoSai),
          }}
        >
          <CartaoServicos f={f} tFid={tFid} tDel={tDel} largura={cartaoL} />
        </div>
        <Celular x={cel.x + deriva(f, 61, 5)} y={cel.y + deriva(f, 62, 4)} largura={cel.l} ry={vertical ? 0 : -12} rx={2} barra={sobeFid > 0.5 && entraDel < 0.5 ? 'escura' : 'clara'}>
          <Captura src="cliente/inicio.png" />
          {sobeFid > 0 && (
            <>
              <div style={{ position: 'absolute', inset: 0, background: 'rgba(12,8,32,.45)', opacity: sobeFid * (1 - entraDel) }} />
              <div style={{ position: 'absolute', left: 0, top: 0, width: 390, height: 844, transform: `translateY(${(1 - sobeFid) * 844}px)`, opacity: 1 - entraDel }}>
                <div style={{ position: 'absolute', left: 0, top: 0, width: 390, height: 47, background: '#F4F2F9' }} />
                <Img src={staticFile('lp/fid-conta.webp')} style={{ position: 'absolute', left: 0, top: 47, width: 390 }} />
              </div>
            </>
          )}
          {entraDel > 0 && (
            <div style={{ position: 'absolute', left: 0, top: 0, width: 390, height: 844, transform: `translateX(${(1 - entraDel) * 390}px)` }}>
              <Captura src="cliente/delivery.png" />
              <Captura src="cliente/delivery-acompanhar.png" opacidade={acompanhar} />
            </div>
          )}
        </Celular>
      </div>
      <div style={{ opacity: 1 - sai }}>
        <Titulo f={f} de={6} ate={200} linhas={['Módulos extras.']} x={vertical ? 64 : 120} y={vertical ? 230 : height * 0.21} tamanho={vertical ? 110 : 120} />
        <Rotulo x={vertical ? 64 : 124} y={vertical ? 250 : height * 0.21 + 22} opacidade={anima(f, 18, 30, 0, 1, E.linear)}>
          Fidelidade · delivery sem comissão
        </Rotulo>
      </div>
    </AbsoluteFill>
  );
};
