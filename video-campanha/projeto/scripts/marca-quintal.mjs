// Gera a logo e a capa fictícias do Quintal Bistrô (só para o vídeo).
// Saída: public/quintal/logo.png (512), public/quintal/capa.jpg (1600x700)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('public/quintal');
fs.mkdirSync(OUT, { recursive: true });

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Jost:wght@500;600&display=block" rel="stylesheet">
<style>html,body{margin:0;background:transparent} #logo{width:512px;height:512px} canvas{display:block}</style></head><body>
<svg id="logo" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="g" cx="30%" cy="22%" r="90%"><stop offset="0" stop-color="#2C4B3A"/><stop offset="1" stop-color="#172C20"/></radialGradient>
  </defs>
  <rect width="512" height="512" fill="url(#g)"/>
  <circle cx="256" cy="256" r="214" fill="none" stroke="#EADFC8" stroke-opacity=".55" stroke-width="3"/>
  <!-- ramo: dois pares de folhas e uma brasa -->
  <g transform="translate(256 150)">
    <path d="M0 34 C0 14 0 -4 0 -22" stroke="#EADFC8" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path d="M0 8 C-14 -2 -30 -4 -42 4 C-30 14 -14 16 0 8Z" fill="#EADFC8"/>
    <path d="M0 8 C14 -2 30 -4 42 4 C30 14 14 16 0 8Z" fill="#EADFC8"/>
    <path d="M0 -10 C-10 -20 -22 -24 -32 -20 C-24 -10 -12 -6 0 -10Z" fill="#EADFC8"/>
    <path d="M0 -10 C10 -20 22 -24 32 -20 C24 -10 12 -6 0 -10Z" fill="#EADFC8"/>
    <circle cx="0" cy="-30" r="8" fill="#E8773E"/>
  </g>
  <text x="256" y="300" text-anchor="middle" font-family="DM Serif Display" font-style="italic" font-size="118" fill="#F3EAD8" letter-spacing="-1">Quintal</text>
  <line x1="118" y1="336" x2="162" y2="336" stroke="#E8773E" stroke-width="3"/>
  <line x1="350" y1="336" x2="394" y2="336" stroke="#E8773E" stroke-width="3"/>
  <text x="256" y="347" text-anchor="middle" font-family="Jost" font-weight="600" font-size="30" fill="#E8773E" letter-spacing="9">BISTRÔ</text>
  <text x="256" y="402" text-anchor="middle" font-family="Jost" font-weight="500" font-size="17" fill="#EADFC8" fill-opacity=".7" letter-spacing="5">BRASA · HORTA</text>
</svg>
<canvas id="capa" width="1600" height="700"></canvas>
<script>
// Capa: varanda do quintal à noite, varal de lâmpadas e luzes desfocadas ao fundo.
(function(){
  const c = document.getElementById('capa'), x = c.getContext('2d');
  let s = 7; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const W = 1600, H = 700;
  // fundo: noite quente, mais clara no centro (salão aceso lá dentro)
  let g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#120c09'); g.addColorStop(.55, '#2a1a10'); g.addColorStop(1, '#1a110b');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  g = x.createRadialGradient(W * .56, H * .62, 20, W * .56, H * .62, W * .62);
  g.addColorStop(0, 'rgba(255,170,90,.42)'); g.addColorStop(.45, 'rgba(190,100,40,.16)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  // janelas do salão ao fundo (retângulos quentes desfocados)
  x.filter = 'blur(18px)';
  for (let i = 0; i < 5; i++) {
    const wx = 380 + i * 190 + r() * 30, wy = 300 + r() * 20;
    x.fillStyle = 'rgba(255,190,120,' + (.18 + r() * .14) + ')';
    x.fillRect(wx, wy, 120, 170);
  }
  x.filter = 'none';
  // bokeh
  x.globalCompositeOperation = 'lighter';
  const cores = [[255,186,104],[255,214,150],[255,160,80],[255,228,190],[170,200,120]];
  for (let i = 0; i < 95; i++) {
    const rad = 10 + Math.pow(r(), 2.2) * 70, bx = r() * W, by = 140 + r() * 420;
    const k = cores[Math.floor(r() * (i % 9 === 0 ? 5 : 4))], a = .05 + r() * .2;
    const gg = x.createRadialGradient(bx, by, 0, bx, by, rad);
    gg.addColorStop(0, 'rgba(' + k + ',' + a * .7 + ')'); gg.addColorStop(.86, 'rgba(' + k + ',' + a + ')'); gg.addColorStop(1, 'rgba(' + k + ',0)');
    x.fillStyle = gg; x.beginPath(); x.arc(bx, by, rad, 0, 7); x.fill();
  }
  x.globalCompositeOperation = 'source-over';
  // folhagem em primeiro plano, desfocada (horta)
  x.filter = 'blur(7px)';
  const folha = (fx, fy, tam, ang, cor) => {
    x.save(); x.translate(fx, fy); x.rotate(ang); x.fillStyle = cor;
    x.beginPath(); x.moveTo(0, 0); x.quadraticCurveTo(tam * .5, -tam * .32, tam, 0); x.quadraticCurveTo(tam * .5, tam * .32, 0, 0); x.fill(); x.restore();
  };
  for (let i = 0; i < 26; i++) folha(-40 + r() * 260, H - r() * 260, 120 + r() * 140, -1.4 + r() * 1.6, 'rgba(' + (14 + r() * 16) + ',' + (30 + r() * 26) + ',' + (18 + r() * 12) + ',.95)');
  for (let i = 0; i < 22; i++) folha(W + 30 - r() * 240, H - r() * 220, 110 + r() * 130, Math.PI + 1.4 - r() * 1.6, 'rgba(' + (14 + r() * 16) + ',' + (30 + r() * 26) + ',' + (18 + r() * 12) + ',.95)');
  x.filter = 'none';
  // varal de lâmpadas
  const fio = (x0, y0, x1, y1, sag, n) => {
    const P = (t) => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + sag * 4 * t * (1 - t)];
    x.strokeStyle = 'rgba(20,12,8,.9)'; x.lineWidth = 3; x.beginPath();
    for (let i = 0; i <= 60; i++) { const [px, py] = P(i / 60); i ? x.lineTo(px, py) : x.moveTo(px, py); } x.stroke();
    for (let i = 1; i < n; i++) {
      const [px, py] = P(i / n), by = py + 22;
      x.globalCompositeOperation = 'lighter';
      let gg = x.createRadialGradient(px, by, 0, px, by, 120);
      gg.addColorStop(0, 'rgba(255,190,110,.42)'); gg.addColorStop(.3, 'rgba(255,150,70,.12)'); gg.addColorStop(1, 'rgba(255,120,40,0)');
      x.fillStyle = gg; x.beginPath(); x.arc(px, by, 120, 0, 7); x.fill();
      x.globalCompositeOperation = 'source-over';
      x.strokeStyle = 'rgba(20,12,8,.9)'; x.lineWidth = 2; x.beginPath(); x.moveTo(px, py); x.lineTo(px, by - 8); x.stroke();
      x.fillStyle = '#2a1c12'; x.fillRect(px - 5, by - 12, 10, 8);
      gg = x.createRadialGradient(px, by + 6, 1, px, by + 6, 13);
      gg.addColorStop(0, 'rgba(255,248,220,1)'); gg.addColorStop(.5, 'rgba(255,200,120,.95)'); gg.addColorStop(1, 'rgba(255,150,60,.55)');
      x.fillStyle = gg; x.beginPath(); x.ellipse(px, by + 6, 9, 13, 0, 0, 7); x.fill();
    }
  };
  fio(-60, 40, W + 60, 70, 150, 13);
  x.filter = 'blur(2.5px)';
  fio(-60, 210, W + 60, 180, 70, 17);
  x.filter = 'none';
  // grão
  const img = x.getImageData(0, 0, W, H), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (r() - .5) * 14; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  x.putImageData(img, 0, 0);
})();
</script></body></html>`;

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--force-color-profile=srgb'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1700, height: 1300, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);
const logo = await page.$('#logo');
await logo.screenshot({ path: path.join(OUT, 'logo.png'), omitBackground: true });
const capa = await page.evaluate(() => document.getElementById('capa').toDataURL('image/jpeg', 0.88));
fs.writeFileSync(path.join(OUT, 'capa.jpg'), Buffer.from(capa.split(',')[1], 'base64'));
await browser.close();
console.log('ok', fs.statSync(path.join(OUT, 'logo.png')).size, fs.statSync(path.join(OUT, 'capa.jpg')).size);
