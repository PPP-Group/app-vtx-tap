// Captura o bloco "Serviços" do simulador da página de orçamento, ligando fidelidade e delivery.
// Saída: public/capturas/orcamento/*
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://localhost:5500';
const OUT = path.resolve('public/capturas/orcamento');
const PROF = path.resolve('../chrome-orcamento');
fs.rmSync(PROF, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', userDataDir: PROF,
  args: ['--no-sandbox', '--force-color-profile=srgb', '--font-render-hinting=none'],
});
const p = await browser.newPage();
await p.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 2 });
await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await p.goto(BASE + '/lp/orcamento.html', { waitUntil: 'networkidle0' });
await p.evaluate(() => document.fonts.ready);
const marcar = async (sel, v) => {
  await p.evaluate((sel, v) => { const c = document.querySelector(sel); if (c.checked !== v) c.click(); }, sel, v);
  await pausa(450);
};
await marcar('#svFid', false);
await marcar('#svDel', false);
const bloco = await p.evaluateHandle(() => document.querySelector('#svPagina').closest('.bloco'));
await p.evaluate((b) => b.scrollIntoView({ block: 'center' }), bloco);
await pausa(500);
const clip = async () => p.evaluate((b) => { const r = b.getBoundingClientRect(); return { x: r.x - 24, y: r.y + scrollY - 24, width: r.width + 48, height: r.height + 48 }; }, bloco);
const foto = async (n) => p.screenshot({ path: path.join(OUT, n), clip: await clip() });
await foto('servicos-0.png');
await marcar('#svFid', true);
await foto('servicos-fid.png');
await marcar('#svDel', true);
await foto('servicos-fid-del.png');
// resumo (total por mês) com os quatro
const resumo = await p.evaluate(() => { const r = document.querySelector('.resumo').getBoundingClientRect(); return { x: r.x - 24, y: r.y + scrollY - 24, width: r.width + 48, height: r.height + 48 }; });
await p.screenshot({ path: path.join(OUT, 'resumo.png'), clip: resumo });
const caixas = await p.evaluate(() => Object.fromEntries(['#svPagina', '#svGarcom', '#svFid', '#svDel'].map((s) => {
  const r = document.querySelector(s).closest('label').getBoundingClientRect();
  const b = document.querySelector(s).closest('.bloco').getBoundingClientRect();
  return [s.slice(1), { x: r.x - b.x + 24, y: r.y - b.y + 24, w: r.width, h: r.height }];
})));
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(caixas, null, 2));
await browser.close();
console.log('ok');
