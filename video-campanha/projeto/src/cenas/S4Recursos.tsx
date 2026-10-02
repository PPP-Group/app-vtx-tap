import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, E, anima, cena, deriva, toque, marca } from '../marca';
import { Fundo } from '../comp/Ambiente';
import { Celular, Toque } from '../comp/Celular';
import { Aneis } from '../comp/Objetos';
import { Fenda } from '../comp/Titulo';
import { Captura, Sequencia, RolagemCardapio, rolar } from '../comp/Tela';
import { celularFinal } from './S3Tap';
import META from '../../public/capturas/meta.json';

const ini = cena('recursos');
const L = (abs: number) => abs - ini; // quadro local de uma marca absoluta

const ROL_CARD = META['atalho-cardapio'].rolagem;
const ROL_LINHA = META['atalho-wifi'].rolagem;
const MAX_INICIO = 1836 - 844;

// O que aparece na tela do celular a cada quadro.
const TelaRecursos: React.FC<{ f: number }> = ({ f }) => {
  const tCard = L(toque('rec-cardapio'));
  const tCroq = L(toque('rec-croquete'));
  const tWifi = L(toque('rec-wifi'));
  const tCopiar = L(toque('rec-copiar'));
  const tDiv = L(toque('rec-dividir'));
  const teclas = (marca('dividir-teclas') as number[]).map(L);
  const tMais1 = L(toque('rec-mais1'));
  const tMais2 = L(toque('rec-mais2'));
  const tSemana = L(toque('rec-semana'));

  let tela: React.ReactNode;
  if (f < tCard + 2) {
    // rola até o atalho do cardápio
    tela = <Captura src="cliente/inicio-pagina.png" rolagem={rolar(f, 0, tCard - 1, 0, ROL_CARD)} />;
  } else if (f < tCard + 16) {
    tela = <Sequencia pasta="cliente/cardapio-abrir" i={f - tCard - 2} total={14} />;
  } else if (f < tCroq + 1) {
    tela = <Captura src="cliente/cardapio.png" />;
  } else if (f < tCroq + 13) {
    tela = <Sequencia pasta="cliente/cardapio-mais" i={f - tCroq - 1} total={12} />;
  } else if (f < 72) {
    tela = <RolagemCardapio rolagem={rolar(f, tCroq + 15, 68, 0, 430)} />;
  } else if (f < 79) {
    // fecha o cardápio (abertura ao contrário)
    tela = <Sequencia pasta="cliente/cardapio-abrir" i={13 - (f - 72) * 2} total={14} />;
  } else if (f < tWifi + 2) {
    tela = <Captura src="cliente/inicio-pagina.png" rolagem={rolar(f, 79, tWifi - 1, ROL_CARD, ROL_LINHA)} />;
  } else if (f < tWifi + 16) {
    tela = <Sequencia pasta="cliente/wifi-abrir" i={f - tWifi - 2} total={14} />;
  } else if (f < tCopiar + 1) {
    tela = <Captura src="cliente/wifi.png" />;
  } else if (f < tCopiar + 17) {
    tela = <Sequencia pasta="cliente/wifi-copiar" i={f - tCopiar - 1} total={16} />;
  } else if (f < 144) {
    tela = <Captura src="cliente/wifi-copiado.png" />;
  } else if (f < 151) {
    tela = <Sequencia pasta="cliente/wifi-abrir" i={13 - (f - 144) * 2} total={14} />;
  } else if (f < tDiv + 2) {
    tela = <Captura src="cliente/inicio-pagina.png" rolagem={ROL_LINHA} />;
  } else if (f < tDiv + 16) {
    tela = <Sequencia pasta="cliente/dividir-abrir" i={f - tDiv - 2} total={14} />;
  } else if (f < teclas[0]) {
    tela = <Captura src="cliente/dividir-0.png" />;
  } else if (f < tMais1 + 1) {
    const k = teclas.filter((t) => f >= t).length; // 1..6
    tela = <Sequencia pasta="cliente/dividir-digitar" i={k} total={7} />;
  } else if (f < tMais2 + 1) {
    tela = <Captura src="cliente/dividir-pessoas-3.png" />;
  } else if (f < 216) {
    tela = <Captura src="cliente/dividir-pessoas-4.png" />;
  } else if (f < 223) {
    tela = <Sequencia pasta="cliente/dividir-abrir" i={13 - (f - 216) * 2} total={14} />;
  } else if (f < tSemana + 2) {
    tela = <Captura src="cliente/inicio-pagina.png" rolagem={rolar(f, 223, tSemana - 2, ROL_LINHA, MAX_INICIO)} />;
  } else {
    tela = <Captura src="cliente/pagina-info.png" rolagem={rolar(f, tSemana + 4, 268, MAX_INICIO, 2004 - 844)} />;
  }
  // a sequência de digitação começa no quadro 001 (o 000 não existe)
  return (
    <>
      {tela}
      <Toque f={f - tCard} x={195} y={META['atalho-cardapio'].y + 88} />
      <Toque f={f - tCroq} x={351} y={621} />
      <Toque f={f - tWifi} x={102} y={META['atalho-wifi'].y + 78} />
      <Toque f={f - tCopiar} x={195} y={475} />
      <Toque f={f - tDiv} x={287} y={META['atalho-dividir'].y + 78} />
      <Toque f={f - tMais1} x={338} y={440} />
      <Toque f={f - tMais2} x={338} y={440} />
      <Toque f={f - tSemana} x={170} y={1726 - MAX_INICIO} />
    </>
  );
};

// Tela com fundo escuro atrás da barra de status: capa no topo ou folha aberta sobre a página escurecida.
const escuroAtras = (f: number) => {
  const tWifi = L(toque('rec-wifi'));
  const tDiv = L(toque('rec-dividir'));
  return f < 4 || (f >= tWifi + 2 && f < 151) || (f >= tDiv + 2 && f < 223);
};

export const CenaRecursos: React.FC = () => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  const fim = celularFinal(width, height);
  const sai = anima(f, 276, 288, 0, 1, E.entra);
  return (
    <AbsoluteFill style={{ background: C.preto, overflow: 'hidden' }}>
      <Fundo luz={[{ x: (fim.x / width) * 100, y: 50, r: 1100, cor: C.roxo, forca: 0.22 }]} />
      <Aneis x={fim.x} y={fim.y} r={vertical ? 520 : 470} forca={0.9} />
      <div style={{ position: 'absolute', inset: 0, perspective: 2200 }}>
        <Celular
          x={fim.x + deriva(f, 11, 6)}
          y={fim.y + deriva(f, 12, 5)}
          largura={fim.largura}
          ry={fim.ry + deriva(f, 13, 1.5)}
          rx={deriva(f, 14, 1)}
          barra={escuroAtras(f) ? 'clara' : 'escura'}
          fundoBarra={escuroAtras(f) ? undefined : 'rgba(244,242,249,.94)'}
        >
          <TelaRecursos f={f} />
        </Celular>
      </div>
      <Fenda
        f={f}
        x={vertical ? 64 : 120}
        y={vertical ? 150 : height * 0.36}
        tamanho={vertical ? 120 : 150}
        ate={300}
        itens={[
          { de: 0, t: 'Cardápio', sub: '18 itens · monte sua lista' },
          { de: 72, t: 'Wi-Fi', sub: 'senha copiada num toque' },
          { de: 144, t: 'Dividir a conta', sub: 'com os 10% de serviço' },
          { de: 216, t: 'Endereço', sub: 'horários, telefone e Instagram' },
        ]}
      />
      <AbsoluteFill style={{ background: C.preto, opacity: sai * 0 }} />
    </AbsoluteFill>
  );
};
