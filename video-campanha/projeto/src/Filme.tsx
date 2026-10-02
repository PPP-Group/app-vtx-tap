import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import './fontes';
import { C, R } from './marca';
import { Grao, Vinheta } from './comp/Ambiente';
import { CenaSalao } from './cenas/S1Salao';
import { CenaPlaca } from './cenas/S2Placa';
import { CenaTap } from './cenas/S3Tap';
import { CenaRecursos } from './cenas/S4Recursos';
import { CenaSino } from './cenas/S5Sino';
import { CenaGarcom } from './cenas/S6Garcom';
import { CenaPainel } from './cenas/S7Painel';
import { CenaSaida } from './cenas/S8Saida';
import { CenaExtras } from './cenas/S9Extras';
import { CenaPlacas } from './cenas/S10Placas';
import { CenaFinal } from './cenas/S11Final';
import { Trilha } from './Trilha';

const c = R.cenas;

// Cenas ainda não montadas aparecem como cartão de marcação.
export const cenasProntas: Record<string, React.FC> = {
  salao: CenaSalao,
  placa: CenaPlaca,
  tap: CenaTap,
  recursos: CenaRecursos,
  sino: CenaSino,
  garcom: CenaGarcom,
  painel: CenaPainel,
  saida: CenaSaida,
  extras: CenaExtras,
  placas: CenaPlacas,
  final: CenaFinal,
};

const ORDEM = ['salao', 'placa', 'tap', 'recursos', 'sino', 'garcom', 'painel', 'saida', 'extras', 'placas', 'final'] as const;
const fimDe = (i: number) => (i + 1 < ORDEM.length ? c[ORDEM[i + 1]] : c.fim);

const Marcacao: React.FC<{ nome: string }> = ({ nome }) => (
  <AbsoluteFill style={{ background: C.noite, alignItems: 'center', justifyContent: 'center', color: C.lilas, fontFamily: 'IBM Plex Mono', fontSize: 40, letterSpacing: '0.2em', textTransform: 'uppercase' }}>
    {nome}
  </AbsoluteFill>
);

// Só as cenas, sem vinheta, grão e som (usado também pelos cortes).
export const Cenas: React.FC = () => (
  <>
    {ORDEM.map((nome, i) => {
      const Cena = cenasProntas[nome];
      return (
        // o salão continua por baixo enquanto a mesa aparece (fusão de 14 quadros)
        <Sequence key={nome} from={c[nome]} durationInFrames={fimDe(i) - c[nome] + (nome === 'salao' ? 14 : 0)} name={nome}>
          {Cena ? <Cena /> : <Marcacao nome={nome} />}
        </Sequence>
      );
    })}
  </>
);

export const Filme: React.FC<{ audio?: boolean; grao?: boolean }> = ({ audio = true, grao = true }) => (
  <AbsoluteFill style={{ background: C.preto }}>
    <Cenas />
    <Vinheta forca={0.42} />
    {grao && <Grao forca={0.085} />}
    {audio && <Trilha />}
  </AbsoluteFill>
);
