import { Easing, interpolate } from 'remotion';
import R from './roteiro.json';

export { R };

// Cores do manual Vortex / VTX Tap
export const C = {
  roxo: '#7D27FC',
  roxoHi: '#9550FF',
  roxoLo: '#5512C4',
  lilas: '#A874FF',
  lavanda: '#EEE5FF',
  noite: '#140B33',
  preto: '#0C0820',
  nevoa: '#F4F2F9',
  branco: '#F7F4FF',
  ouro: '#FFC61A',
  ouroTexto: '#1D1400',
  pimenta: '#E5533D',
  ok: '#1B7F52',
  quente: '#FFB25C',
};

export const F = {
  display: '"Big Shoulders Display", "Arial Narrow", sans-serif',
  texto: '"Schibsted Grotesk", system-ui, sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, monospace',
  marca: 'Sora, sans-serif',
};

// Curvas: as mesmas da plataforma (--ease e --spring)
export const E = {
  saida: Easing.bezier(0.16, 1, 0.3, 1),
  suave: Easing.bezier(0.2, 0.8, 0.2, 1),
  entraSai: Easing.bezier(0.65, 0, 0.35, 1),
  entra: Easing.bezier(0.55, 0, 0.9, 0.4),
  linear: (t: number) => t,
};

// interpolate com clamp e curva
export const anima = (f: number, de: number, ate: number, v0: number, v1: number, curva: (t: number) => number = E.suave) =>
  interpolate(f, [de, ate], [v0, v1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: curva });

// vários pontos-chave: anima por trechos
export const chaves = (f: number, quadros: number[], valores: number[], curva: (t: number) => number = E.entraSai) =>
  interpolate(f, quadros, valores, { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: curva });

export const cena = (nome: keyof typeof R.cenas) => R.cenas[nome];
export const toque = (nome: keyof typeof R.toques) => R.toques[nome];
export const marca = (nome: keyof typeof R.marcas) => R.marcas[nome] as any;

// ruído determinístico para deriva de câmera
export const deriva = (f: number, semente: number, amp = 1, vel = 0.013) =>
  amp * (Math.sin(f * vel + semente * 1.7) * 0.6 + Math.sin(f * vel * 2.3 + semente * 3.1) * 0.4);
