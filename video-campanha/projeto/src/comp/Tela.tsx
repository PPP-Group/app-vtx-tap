import React from 'react';
import { Img, staticFile } from 'remotion';
import { E, anima } from '../marca';
import { TELA_A, TELA_L } from './Celular';

const cap = (n: string) => staticFile(`capturas/${n}`);

// Uma imagem de captura, inteira (390 de largura), rolada em y.
export const Captura: React.FC<{ src: string; rolagem?: number; opacidade?: number; altura?: number }> = ({ src, rolagem = 0, opacidade = 1 }) => (
  <Img src={cap(src)} style={{ position: 'absolute', left: 0, top: -rolagem, width: TELA_L, opacity: opacidade }} />
);

// Sequência de quadros da interface real (pasta com 000.jpg, 001.jpg…), um por quadro de vídeo.
export const Sequencia: React.FC<{ pasta: string; i: number; total: number; ext?: string; passo?: number }> = ({ pasta, i, total, ext = 'jpg', passo = 1 }) => {
  const k = Math.max(0, Math.min(total - 1, Math.floor(i * passo)));
  return <Img src={cap(`${pasta}/${String(k).padStart(3, '0')}.${ext}`)} style={{ position: 'absolute', left: 0, top: 0, width: TELA_L }} />;
};

// Rolagem do cardápio: corpo comprido rolando sob o cabeçalho, barra da lista fixa embaixo.
export const RolagemCardapio: React.FC<{ rolagem: number }> = ({ rolagem }) => {
  const TOPO = 219.2;
  return (
    <>
      <div style={{ position: 'absolute', left: 0, top: TOPO, width: TELA_L, height: TELA_A - TOPO, overflow: 'hidden' }}>
        <Img src={cap('cliente/cardapio-longo.jpg')} style={{ position: 'absolute', left: 0, top: -TOPO - rolagem, width: TELA_L }} />
      </div>
      <div style={{ position: 'absolute', left: 0, top: 0, width: TELA_L, height: TOPO, overflow: 'hidden' }}>
        <Img src={cap('cliente/cardapio-1.png')} style={{ position: 'absolute', left: 0, top: 0, width: TELA_L }} />
      </div>
      {/* barra "1 item na lista" */}
      <div style={{ position: 'absolute', left: 12, top: 733, width: 366, height: 65, overflow: 'hidden', borderRadius: 18 }}>
        <Img src={cap('cliente/cardapio-1.png')} style={{ position: 'absolute', left: -12, top: -733, width: TELA_L }} />
      </div>
    </>
  );
};

// Rolagem suave entre dois pontos.
export const rolar = (f: number, de: number, ate: number, y0: number, y1: number) => anima(f, de, ate, y0, y1, E.entraSai);
