import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, E, F, anima, cena, deriva, toque, marca } from '../marca';
import { Fundo, hexA } from '../comp/Ambiente';
import { Celular, Toque } from '../comp/Celular';
import { Aneis, Janela } from '../comp/Objetos';
import { Titulo } from '../comp/Titulo';
import { Captura, Sequencia } from '../comp/Tela';
import { celularFinal } from './S3Tap';
import META from '../../public/capturas/meta.json';

const ini = cena('saida');
const L = (abs: number) => abs - ini;
const ROL = 1836 - 844; // fim da página: atalhos do Google e do comentário à vista

const Estrela: React.FC<{ cheia: number; tam: number }> = ({ cheia, tam }) => (
  <svg width={tam} height={tam} viewBox="0 0 24 24" style={{ transform: `scale(${0.85 + 0.15 * cheia})` }}>
    <path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8Z" fill={cheia > 0.5 ? C.ouro : 'none'} stroke={cheia > 0.5 ? C.ouro : 'rgba(255,255,255,.35)'} strokeWidth={1.4} strokeLinejoin="round" />
  </svg>
);

const TelaSaida: React.FC<{ f: number }> = ({ f }) => {
  const tG = L(toque('saida-google'));
  const tC = L(toque('saida-comentario'));
  const tE = [L(toque('saida-estrela1')), L(toque('saida-estrela2')), L(toque('saida-estrela3'))];
  const tTag = L(toque('saida-tag'));
  const teclas = (marca('comentario-teclas') as number[]).map(L);
  const tEnv = L(toque('saida-enviar'));
  let tela: React.ReactNode;
  if (f < tC + 2) tela = <Captura src="cliente/inicio-pagina.png" rolagem={ROL} />;
  else if (f < tC + 16) tela = <Sequencia pasta="cliente/comentario-abrir" i={f - tC - 2} total={14} />;
  else if (f < tE[0] + 1) tela = <Captura src="cliente/comentario-0.png" />;
  else if (f < tE[1] + 1) tela = <Captura src="cliente/comentario-estrela-1.png" />;
  else if (f < tE[2] + 1) tela = <Captura src="cliente/comentario-estrela-2.png" />;
  else if (f < tTag + 1) tela = <Captura src="cliente/comentario-estrela-3.png" />;
  else if (f < teclas[0]) tela = <Captura src="cliente/comentario-tag.png" />;
  else if (f < teclas[teclas.length - 1] + 3) {
    const k = teclas.filter((t) => f >= t).length;
    tela = <Sequencia pasta="cliente/comentario-digitar" i={k} total={15} />;
  } else if (f < tEnv + 1) tela = <Captura src="cliente/comentario-pronto.png" />;
  else if (f < tEnv + 14) tela = <Sequencia pasta="cliente/comentario-enviado" i={f - tEnv - 1} total={13} />;
  else tela = <Captura src="cliente/comentario-enviado.png" />;
  const est = META.estrelas;
  return (
    <>
      {tela}
      <Toque f={f - tG} x={102} y={1389.6 + 77 - ROL} />
      <Toque f={f - tC} x={287} y={META['atalho-comentario'].y + 78} />
      {tE.map((t, i) => <Toque key={i} f={f - t} x={est[i].x + est[i].w / 2} y={est[i].y + est[i].h / 2} />)}
      <Toque f={f - tTag} x={META.tagEspera.x + META.tagEspera.w / 2} y={META.tagEspera.y + 20} />
      <Toque f={f - tEnv} x={195} y={META.fbEnviar.y + 24} />
    </>
  );
};

export const CenaSaida: React.FC = () => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  const fim = celularFinal(width, height);
  const tG = L(toque('saida-google'));
  const estrelas = (marca('estrelas') as number[]).map(L);
  // cartão do Google ao lado do celular
  const gEntra = anima(f, tG + 4, tG + 18, 0, 1, E.saida) * anima(f, 62, 72, 1, 0, E.entra);
  // painel de comentários no fim
  const pEntra = anima(f, 170, 196, 0, 1, E.saida);
  const celX = fim.x - pEntra * (vertical ? 0 : width * 0.44);
  return (
    <AbsoluteFill style={{ background: C.preto, overflow: 'hidden' }}>
      <Fundo luz={[{ x: 60, y: 50, r: 1100, cor: C.roxo, forca: 0.2 }]} />
      <Aneis x={celX} y={fim.y} r={vertical ? 520 : 470} forca={0.85} />
      <div style={{ position: 'absolute', inset: 0, perspective: 2400 }}>
        {pEntra > 0 && (
          <Janela largura={vertical ? 980 : 1240} x={vertical ? width / 2 : width * 0.64 + (1 - pEntra) * 500} y={vertical ? height * 0.3 : height * 0.5} ry={vertical ? 0 : -12} rx={3} z={-60} opacidade={pEntra}>
            <Img src={staticFile('capturas/painel/comentarios.png')} style={{ width: 1440 }} />
            <div style={{ position: 'absolute', left: 288, top: 378, width: 364, height: 166, borderRadius: 16, boxShadow: `0 0 0 3px ${hexA(C.roxo, 0.85 * anima(f, 196, 206, 0, 1, E.linear))}` }} />
          </Janela>
        )}
        <Celular x={celX + deriva(f, 51, 5)} y={(vertical ? height * 0.66 : fim.y) + deriva(f, 52, 4)} largura={vertical ? 540 : fim.largura} ry={fim.ry + deriva(f, 53, 1.2)} barra={f < L(toque('saida-comentario')) + 4 ? 'escura' : 'clara'} fundoBarra={f < L(toque('saida-comentario')) + 4 ? 'rgba(244,242,249,.94)' : undefined}>
          <TelaSaida f={f} />
        </Celular>
      </div>
      {/* avaliação no Google */}
      {gEntra > 0 && (
        <div
          style={{
            position: 'absolute',
            left: vertical ? 64 : fim.x - 560,
            top: vertical ? height * 0.34 : height * 0.2,
            width: 600,
            padding: '30px 36px',
            borderRadius: 26,
            background: '#FFFFFF',
            boxShadow: '0 40px 90px rgba(4,2,14,.6)',
            opacity: gEntra,
            transform: `translateY(${(1 - gEntra) * 40}px) scale(${0.94 + 0.06 * gEntra})`,
            fontFamily: F.texto,
          }}
        >
          <div style={{ fontSize: 22, fontWeight: 600, color: '#5F6368', letterSpacing: '0.01em' }}>Avaliação no Google</div>
          <div style={{ marginTop: 6, fontSize: 34, fontWeight: 700, color: '#160E33' }}>Quintal Bistrô</div>
          <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            {estrelas.map((t, i) => (
              <Estrela key={i} cheia={anima(f, t, t + 4, 0, 1, E.saida)} tam={64} />
            ))}
          </div>
        </div>
      )}
      <Titulo f={f} de={tG + 4} ate={164} linhas={['Elogio no Google.']} x={vertical ? 64 : 120} y={vertical ? 300 : height * 0.86 - 212} tamanho={vertical ? 104 : 118} />
      <Titulo
        f={f}
        de={L(toque('saida-comentario')) + 16}
        ate={164}
        linhas={[{ t: 'Crítica direto', cor: C.lilas }, { t: 'com você.', cor: C.lilas }]}
        x={vertical ? 64 : 120}
        y={vertical ? 300 + 190 : height * 0.86}
        tamanho={vertical ? 104 : 118}
      />
    </AbsoluteFill>
  );
};
