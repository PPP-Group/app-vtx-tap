import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, E, F, anima, cena, chaves, deriva, toque, marca } from '../marca';
import { Fundo, hexA } from '../comp/Ambiente';
import { Celular, Toque, TELA_L } from '../comp/Celular';
import { Aneis, Rotulo } from '../comp/Objetos';
import { Titulo } from '../comp/Titulo';
import { Captura, Sequencia } from '../comp/Tela';
import META from '../../public/capturas/meta.json';

const ini = cena('sino');
const L = (abs: number) => abs - ini;
const CLIP = META.sinoClip; // recorte do anel (coordenadas da tela)

// Celular do cliente: motivo, Pix, segurar o sino, chamado enviado.
const TelaSino: React.FC<{ f: number }> = ({ f }) => {
  const tConta = L(toque('sino-conta'));
  const tPix = L(toque('sino-pix'));
  const tSeg = L(marca('sino-segurar'));
  const tCham = L(marca('sino-chamou'));
  let tela: React.ReactNode;
  if (f < tConta + 1) tela = <Captura src="cliente/sino-0.png" />;
  else if (f < tPix + 1) tela = <Captura src="cliente/sino-motivo.png" />;
  else if (f < tCham + 30) tela = <Captura src="cliente/sino-conta.png" />;
  else if (f < tCham + 49) tela = <Sequencia pasta="cliente/sino-enviado" i={f - tCham - 30} total={19} />;
  else tela = <Captura src="cliente/sino-enviado.png" />;
  // anel enchendo enquanto segura
  const anel = f >= tSeg && f < tCham + 30 ? (
    <Img
      src={staticFile(`capturas/cliente/sino-anel/${String(Math.max(0, Math.min(27, f - tSeg))).padStart(3, '0')}.png`)}
      style={{ position: 'absolute', left: CLIP.x, top: CLIP.y, width: CLIP.width, height: CLIP.height }}
    />
  ) : null;
  // ondas do sino quando chama (borda dourada, como na interface)
  const ondas = [0, 5, 10].map((d, i) => {
    const t = (f - tCham - d) / 26;
    if (t < 0 || t > 1) return null;
    const cx = META.sino.x + META.sino.width / 2;
    const cy = META.sino.y + META.sino.height / 2;
    const r = 70 + t * 120;
    return <div key={i} style={{ position: 'absolute', left: cx - r, top: cy - r, width: r * 2, height: r * 2, borderRadius: '50%', border: `${3 - t * 2}px solid ${C.ouro}`, opacity: (1 - t) * 0.9 }} />;
  });
  const sx = META.sino.x + META.sino.width / 2;
  const sy = META.sino.y + META.sino.height / 2;
  return (
    <>
      {tela}
      {anel}
      {ondas}
      <Toque f={f - tConta} x={META.motivoConta.x + META.motivoConta.width / 2} y={META.motivoConta.y + 20} />
      <Toque f={f - tPix} x={META.pagPix.x + META.pagPix.width / 2} y={META.pagPix.y + 20} />
      <Toque f={f - tSeg} x={sx} y={sy} segurar={tCham - tSeg} />
    </>
  );
};

// Celular do garçom: vazio, o chamado chega com vibração.
export const TelaGarcom: React.FC<{ f: number; chega: number; ir?: number }> = ({ f, chega, ir = 99999 }) => {
  let tela: React.ReactNode;
  if (f < chega) tela = <Captura src="garcom/vazio.png" />;
  else if (f < chega + 46) tela = <Sequencia pasta="garcom/chegou" i={f - chega} total={46} />;
  else if (f < ir + 1) tela = <Captura src="garcom/chamado.png" />;
  else if (f < ir + 20) tela = <Sequencia pasta="garcom/estou-indo" i={f - ir - 1} total={19} />;
  else tela = <Captura src="garcom/a-caminho.png" />;
  return (
    <>
      {tela}
      <Toque f={f - ir} x={META.garcomIr.x + META.garcomIr.width / 2} y={META.garcomIr.y + 22} />
    </>
  );
};

export const tremor = (f: number, inicio: number) => {
  const pulso = (a: number, b: number) => (f >= a && f < b ? Math.sin((f - a) * 2.6) * 7 * (1 - (f - a) / (b - a)) : 0);
  return pulso(inicio, inicio + 12) + pulso(inicio + 16, inicio + 26);
};

export const CenaSino: React.FC = () => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  const tSeg = L(marca('sino-segurar'));
  const tCham = L(marca('sino-chamou'));
  const tGar = L(marca('garcom-chega'));
  const corte = tGar - 10; // quadro do corte para o celular do garçom

  // câmera: aproxima no sino, volta depois do chamado
  const zoom = chaves(f, [22, 46, tCham + 8, tCham + 30], [1, vertical ? 2.0 : 2.5, vertical ? 2.0 : 2.5, 1.06], E.entraSai);
  const larg = vertical ? 640 : 500;
  const k = larg / 412;
  const px = width / 2;
  const py = height / 2;
  // ponto do sino em relação ao centro do celular
  const bx = (META.sino.x + META.sino.width / 2 - TELA_L / 2) * k;
  const by = (META.sino.y + META.sino.height / 2 - 422) * k;
  const foco = chaves(f, [22, 46, tCham + 8, tCham + 30], [0, 1, 1, 0], E.entraSai);
  const camX = -bx * foco * zoom;
  const camY = -by * foco * zoom;

  if (f >= corte) {
    // celular do garçom
    const g = f - corte;
    return (
      <AbsoluteFill style={{ background: C.preto, overflow: 'hidden' }}>
        <Fundo luz={[{ x: vertical ? 50 : 62, y: 50, r: 900, cor: C.roxoLo, forca: 0.18 }]} />
        <Aneis x={vertical ? width / 2 : width * 0.62} y={height / 2} r={vertical ? 520 : 450} forca={anima(g, 10, 30, 0, 0.8, E.linear)} />
        <div style={{ position: 'absolute', inset: 0, perspective: 2200 }}>
          <Celular
            x={(vertical ? width / 2 : width * 0.62) + deriva(f, 21, 4)}
            y={height / 2 + deriva(f, 22, 4)}
            largura={vertical ? 600 : 470}
            ry={vertical ? 0 : -8}
            rx={2}
            barra="escura"
            tremor={tremor(f, tGar)}
          >
            <TelaGarcom f={f} chega={tGar} />
          </Celular>
        </div>
        <Rotulo x={vertical ? 64 : 120} y={vertical ? 120 : height * 0.4} cor={C.lavanda} ponto={C.ouro} tamanho={vertical ? 26 : 24} opacidade={anima(g, 4, 16, 0, 1, E.linear)}>
          Celular do garçom
        </Rotulo>
        <Rotulo x={vertical ? 64 : 120} y={vertical ? 164 : height * 0.4 + 44} tamanho={vertical ? 22 : 20} opacidade={anima(g, 10, 22, 0, 1, E.linear)}>
          Caio · em serviço
        </Rotulo>
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ background: C.preto, overflow: 'hidden' }}>
      <Fundo luz={[{ x: 50, y: 50, r: 900, cor: C.roxoLo, forca: anima(f, 0, 30, 0.22, 0.1) }]} />
      <Aneis x={width / 2} y={height / 2} r={vertical ? 520 : 500} forca={anima(f, 0, 30, 0.8, 0.25)} />
      <div style={{ position: 'absolute', inset: 0, perspective: 2400 }}>
        <div style={{ position: 'absolute', inset: 0, transformStyle: 'preserve-3d', transform: `translate(${camX}px, ${camY}px) scale(${zoom})`, transformOrigin: `${px}px ${py}px` }}>
          <Celular x={px + deriva(f, 15, 3)} y={py + deriva(f, 16, 3)} largura={larg} barra="escura" fundoBarra="rgba(244,242,249,.94)" rx={deriva(f, 17, 0.8)} ry={deriva(f, 18, 0.8)}>
            <TelaSino f={f} />
          </Celular>
        </div>
      </div>
      {/* luz dourada no instante do chamado */}
      <AbsoluteFill style={{ background: `radial-gradient(40% 40% at 50% 50%, ${hexA(C.ouro, 0.22)}, transparent 70%)`, opacity: anima(f, tCham, tCham + 3, 0, 1, E.linear) * anima(f, tCham + 3, tCham + 24, 1, 0, E.linear) }} />
      <Titulo f={f} de={tSeg} ate={tCham + 34} linhas={['Segurou.']} x={vertical ? 64 : 110} y={vertical ? 330 : height * 0.42} tamanho={vertical ? 170 : 210} />
      <Titulo f={f} de={tCham} ate={tCham + 34} linhas={[{ t: 'Chamou.', cor: C.ouro }]} x={vertical ? width - 64 : width - 110} y={vertical ? height - 180 : height * 0.86} tamanho={vertical ? 170 : 210} alinhar="right" />
      <Rotulo x={vertical ? 64 : 120} y={vertical ? 120 : 84} cor={C.lavanda} ponto={C.ouro} opacidade={anima(f, 2, 14, 0, 1, E.linear) * anima(f, 40, 50, 1, 0, E.linear)}>
        Mesa 12 · Marina
      </Rotulo>
    </AbsoluteFill>
  );
};
