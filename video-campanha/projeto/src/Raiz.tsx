import React from 'react';
import { Composition } from 'remotion';
import { Filme } from './Filme';
import { R } from './marca';
import { Corte, duracaoCorte } from './Cortes';

export const Raiz: React.FC = () => (
  <>
    <Composition id="Filme" component={Filme} durationInFrames={R.total} fps={R.fps} width={1920} height={1080} defaultProps={{ audio: true, grao: true }} />
    <Composition id="FilmeVertical" component={Filme} durationInFrames={R.total} fps={R.fps} width={1080} height={1920} defaultProps={{ audio: true, grao: true }} />
    <Composition id="Corte30" component={Corte} durationInFrames={duracaoCorte('Corte30')} fps={R.fps} width={1920} height={1080} defaultProps={{ nome: 'Corte30' as const }} />
    <Composition id="Corte15" component={Corte} durationInFrames={duracaoCorte('Corte15')} fps={R.fps} width={1920} height={1080} defaultProps={{ nome: 'Corte15' as const }} />
    <Composition id="Corte30Vertical" component={Corte} durationInFrames={duracaoCorte('Corte30')} fps={R.fps} width={1080} height={1920} defaultProps={{ nome: 'Corte30' as const }} />
    <Composition id="Corte15Vertical" component={Corte} durationInFrames={duracaoCorte('Corte15')} fps={R.fps} width={1080} height={1920} defaultProps={{ nome: 'Corte15' as const }} />
  </>
);
