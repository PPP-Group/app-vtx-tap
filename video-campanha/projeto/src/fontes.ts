import { continueRender, delayRender, staticFile } from 'remotion';

// As mesmas fontes do site (Google Fonts) e a Sora local do projeto.
const CSS = 'https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@700;800;900&family=IBM+Plex+Mono:wght@400;500;600&family=Schibsted+Grotesk:wght@400;500;600;700&display=block';

if (typeof document !== 'undefined' && !document.getElementById('fontes-vtx')) {
  const espera = delayRender('Carregando fontes');
  const link = document.createElement('link');
  link.id = 'fontes-vtx';
  link.rel = 'stylesheet';
  link.href = CSS;
  const sora = [
    ['300', 'Sora-Light.ttf'],
    ['600', 'Sora-SemiBold.ttf'],
    ['800', 'Sora-ExtraBold.ttf'],
  ].map(([peso, arq]) => new FontFace('Sora', `url(${staticFile('fonts/' + arq)})`, { weight: peso }));
  const pronto = async () => {
    try {
      sora.forEach((f) => document.fonts.add(f));
      await Promise.all([
        ...sora.map((f) => f.load()),
        document.fonts.load('900 80px "Big Shoulders Display"'),
        document.fonts.load('800 80px "Big Shoulders Display"'),
        document.fonts.load('500 20px "IBM Plex Mono"'),
        document.fonts.load('600 20px "IBM Plex Mono"'),
        document.fonts.load('400 20px "Schibsted Grotesk"'),
        document.fonts.load('500 20px "Schibsted Grotesk"'),
        document.fonts.load('600 20px "Schibsted Grotesk"'),
        document.fonts.load('700 20px "Schibsted Grotesk"'),
      ]);
    } catch (e) {
      console.error(e);
    }
    continueRender(espera);
  };
  link.onload = pronto;
  link.onerror = () => continueRender(espera);
  document.head.appendChild(link);
}
