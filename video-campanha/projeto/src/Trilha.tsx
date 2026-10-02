import React from 'react';
import { Audio, staticFile } from 'remotion';
import estado from './audio.json';

// Mixagem final (trilha + efeitos + locução), gerada pelos scripts de áudio.
export const Trilha: React.FC = () => (estado.mix ? <Audio src={staticFile('audio/mix.wav')} /> : null);
