import React from 'react';
import { interpolate } from 'remotion';
import { C, E, F } from '../marca';
import { hexA } from './Ambiente';

// Planta do Quintal Bistrô: salão (mesas 1–14) e varanda (15–24).
export const PW = 1600;
export const PH = 1000;

type Mesa = { n: number; x: number; y: number; tipo: '4' | '2' | 'r' };
export const MESAS: Mesa[] = [
  { n: 1, x: 190, y: 360, tipo: '2' }, { n: 2, x: 340, y: 360, tipo: '4' }, { n: 3, x: 500, y: 360, tipo: '4' },
  { n: 4, x: 660, y: 360, tipo: '4' }, { n: 5, x: 820, y: 360, tipo: '4' }, { n: 6, x: 965, y: 360, tipo: '2' },
  { n: 7, x: 190, y: 560, tipo: '2' }, { n: 8, x: 340, y: 560, tipo: '4' }, { n: 9, x: 500, y: 560, tipo: '4' },
  { n: 10, x: 660, y: 560, tipo: '4' }, { n: 11, x: 820, y: 560, tipo: '4' },
  { n: 12, x: 560, y: 760, tipo: '4' }, { n: 13, x: 760, y: 760, tipo: '4' }, { n: 14, x: 950, y: 760, tipo: '2' },
  ...[15, 16, 17, 18, 19, 20, 21, 22, 23, 24].map((n, i) => ({ n, x: i % 2 ? 1390 : 1180, y: 230 + Math.floor(i / 2) * 160, tipo: 'r' as const })),
];
export const MESA12 = MESAS.find((m) => m.n === 12)!;
const OCUPADAS = [2, 3, 5, 7, 9, 10, 12, 15, 17, 18, 21];

const dist = (x: number, y: number) => Math.hypot(x - MESA12.x, y - MESA12.y);

// atraso de desenho: começa perto da mesa 12 e se espalha
const atraso = (x: number, y: number) => dist(x, y) / 34;

const Traco: React.FC<{ d: string; f: number; x: number; y: number; cor?: string; largura?: number; tracejado?: boolean }> = ({ d, f, x, y, cor = hexA(C.lilas, 0.55), largura = 2, tracejado }) => {
  const p = interpolate(f, [2 + atraso(x, y), 30 + atraso(x, y)], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: E.saida });
  return (
    <path
      d={d}
      fill="none"
      stroke={cor}
      strokeWidth={largura}
      strokeLinecap="round"
      strokeLinejoin="round"
      pathLength={1}
      strokeDasharray={tracejado ? undefined : 1}
      strokeDashoffset={tracejado ? undefined : p}
      style={tracejado ? { opacity: 1 - p } : undefined}
      {...(tracejado ? { strokeDasharray: '10 12' } : {})}
    />
  );
};

const rr = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`;
const circ = (x: number, y: number, r: number) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`;

const MesaDes: React.FC<{ m: Mesa; f: number; destaque: number }> = ({ m, f, destaque }) => {
  const cor = destaque > 0 ? `rgba(255, 198, 26, ${0.55 + destaque * 0.45})` : hexA(C.lilas, 0.6);
  const cad = hexA(C.lilas, 0.38);
  const pessoas = OCUPADAS.includes(m.n);
  const elems: React.ReactNode[] = [];
  const pOp = interpolate(f, [30 + atraso(m.x, m.y), 50 + atraso(m.x, m.y)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  if (m.tipo === 'r') {
    elems.push(<Traco key="t" d={circ(m.x, m.y, 36)} f={f} x={m.x} y={m.y} cor={cor} largura={2.4} />);
    [0, 1, 2, 3].forEach((i) => {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      elems.push(<Traco key={'c' + i} d={circ(m.x + Math.cos(a) * 56, m.y + Math.sin(a) * 56, 11)} f={f} x={m.x} y={m.y} cor={cad} largura={1.6} />);
    });
  } else {
    const w = m.tipo === '4' ? 86 : 62;
    const h = 86;
    elems.push(<Traco key="t" d={rr(m.x - w / 2, m.y - h / 2, w, h, 9)} f={f} x={m.x} y={m.y} cor={cor} largura={2.4} />);
    const cs = m.tipo === '4'
      ? [[0, -h / 2 - 20, 36, 14], [0, h / 2 + 20, 36, 14], [-w / 2 - 20, 0, 14, 36], [w / 2 + 20, 0, 14, 36]]
      : [[-w / 2 - 20, 0, 14, 36], [w / 2 + 20, 0, 14, 36]];
    cs.forEach(([dx, dy, cw, ch], i) => elems.push(<Traco key={'c' + i} d={rr(m.x + dx - cw / 2, m.y + dy - ch / 2, cw, ch, 6)} f={f} x={m.x} y={m.y} cor={cad} largura={1.6} />));
  }
  return (
    <g>
      {elems}
      {pessoas && (
        <g opacity={pOp * 0.85}>
          {(m.tipo === 'r' ? [[-40, -40], [40, 40]] : m.tipo === '4' ? [[0, -63], [0, 63]] : [[-51, 0], [51, 0]]).map(([dx, dy], i) => (
            <circle key={i} cx={m.x + dx} cy={m.y + dy} r={8} fill={hexA(C.lilas, 0.75)} />
          ))}
        </g>
      )}
      <text
        x={m.x}
        y={m.y + 8}
        textAnchor="middle"
        fontFamily={F.mono}
        fontWeight={500}
        fontSize={22}
        fill={destaque > 0 ? C.ouro : hexA(C.lavanda, 0.7)}
        opacity={interpolate(f, [24 + atraso(m.x, m.y), 40 + atraso(m.x, m.y)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}
      >
        {String(m.n).padStart(2, '0')}
      </text>
    </g>
  );
};

export const Planta: React.FC<{ f: number; destaque12?: number; esmaecer?: number }> = ({ f, destaque12 = 0, esmaecer = 0 }) => {
  const parede = hexA(C.lilas, 0.75);
  const rot = (t: string, x: number, y: number, de: number) => (
    <text x={x} y={y} fontFamily={F.mono} fontWeight={500} fontSize={20} letterSpacing="0.28em" fill={hexA(C.lilas, 0.75)} opacity={interpolate(f, [de, de + 20], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}>
      {t}
    </text>
  );
  return (
    <svg width={PW} height={PH} viewBox={`0 0 ${PW} ${PH}`} style={{ overflow: 'visible' }}>
      <g opacity={1 - esmaecer}>
        {/* paredes do salão, com a entrada embaixo */}
        <Traco d="M80 120H1040V900H330M250 900H80V120" f={f} x={560} y={500} cor={parede} largura={5} />
        {/* varanda: deck aberto */}
        <Traco d="M1040 120H1520V900H1040" f={f} x={1280} y={500} cor={hexA(C.lilas, 0.45)} largura={2} tracejado />
        {/* balcão e banquetas */}
        <Traco d={rr(140, 160, 440, 56, 10)} f={f} x={360} y={190} cor={parede} largura={2.6} />
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <Traco key={i} d={circ(175 + i * 62, 252, 13)} f={f} x={175 + i * 62} y={252} cor={hexA(C.lilas, 0.38)} largura={1.6} />
        ))}
        {/* horta da varanda */}
        {[[1500, 160], [1500, 330], [1500, 500], [1500, 670], [1500, 840], [1080, 880], [1300, 940]].map(([x, y], i) => (
          <g key={i} opacity={0.5 * (1 - interpolate(f, [20 + i * 4, 40 + i * 4], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }))}>
            <circle cx={x} cy={y} r={26} fill="none" stroke={hexA('#7FBF8A', 0.6)} strokeWidth={2} />
            <circle cx={x + 18} cy={y + 14} r={16} fill="none" stroke={hexA('#7FBF8A', 0.45)} strokeWidth={1.6} />
          </g>
        ))}
        {rot('SALÃO', 100, 100, 30)}
        {rot('VARANDA', 1060, 100, 40)}
        {rot('BALCÃO', 600, 196, 44)}
        {rot('ENTRADA', 248, 940, 50)}
        {MESAS.map((m) => (
          <MesaDes key={m.n} m={m} f={f} destaque={m.n === 12 ? destaque12 : 0} />
        ))}
      </g>
    </svg>
  );
};

// Ícone de mão levantada (lucide "hand").
export const Mao: React.FC<{ x: number; y: number; tamanho: number; cor: string; giro?: number; opacidade?: number }> = ({ x, y, tamanho, cor, giro = 0, opacidade = 1 }) => (
  <g transform={`translate(${x} ${y}) rotate(${giro}) scale(${tamanho / 24}) translate(-12 -12)`} opacity={opacidade}>
    <g fill="none" stroke={cor} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
      <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
      <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </g>
  </g>
);
