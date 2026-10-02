// Captura as telas reais da plataforma (modo demonstração) para o vídeo.
// Encena os estados direto no banco local do navegador (localStorage + BroadcastChannel),
// com o relógio da página adiantado para uma sexta às 20:41, e grava:
//   public/capturas/cliente/*  celular do cliente (390x844 @3x)
//   public/capturas/garcom/*   celular do garçom (390x844 @3x)
//   public/capturas/painel/*   painel no computador (1440x900 @2x)
// Sequências de animação: as animações CSS da página são pausadas e avançadas
// quadro a quadro (Web Animations API), a 30 qps.
// Uso: node scripts/capturar.mjs [etapa...]   (sem etapa = todas)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://localhost:5500';
const OUT = path.resolve('public/capturas');
const PROF = path.resolve('../chrome-captura');
const KEY = 'nfc-demo-db-v1';
const so = process.argv.slice(2);
const etapa = (n) => !so.length || so.includes(n);

fs.rmSync(PROF, { recursive: true, force: true });

// Sexta-feira, 2 de outubro de 2026, 20:41 (horário local).
const ALVO = new Date(2026, 9, 2, 20, 41, 0).getTime();
const OFF = ALVO - Date.now();
const agora = () => Date.now() + OFF;
const iso = (atras = 0) => new Date(agora() - atras).toISOString();
const MIN = 60e3;
const SEG = 1e3;

const LOGO = 'data:image/png;base64,' + fs.readFileSync('public/quintal/logo.png').toString('base64');
const CAPA = 'data:image/jpeg;base64,' + fs.readFileSync('public/quintal/capa.jpg').toString('base64');

const relogio = `(() => {
  const OFF = ${OFF}, _D = Date;
  function D(...a) { if (!new.target) return new _D(_D.now() + OFF).toString(); return a.length ? new _D(...a) : new _D(_D.now() + OFF); }
  D.prototype = _D.prototype; D.now = () => _D.now() + OFF; D.parse = _D.parse; D.UTC = _D.UTC;
  window.Date = D;
})();`;

/* ---------------- Banco inicial ---------------- */
let n = 0;
const id = (p) => `${p}-${(++n).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const pessoas = { 2: 'Helena', 3: 'Carla', 5: 'Pedro', 7: 'Bruno', 9: 'Lucas', 10: 'Sofia', 12: 'Marina', 15: 'Rafael', 17: 'Davi', 18: 'Lívia', 21: 'João' };

function bancoInicial() {
  const sessoes = [];
  const mesasAbertas = {};
  for (const [m, nome] of Object.entries(pessoas)) {
    const s = { id: id('s'), token: `tok-${m}`, mesa: +m, nome, status: 'liberada', via: 'equipe', liberada_por: 'Ana', criado_em: iso(40 * MIN - m * MIN), liberada_em: iso(38 * MIN - m * MIN), encerrada_em: null };
    sessoes.push(s);
    mesasAbertas[m] = { codigo: m === '12' ? '4821' : String(1000 + m * 137).slice(-4), aberta_em: s.liberada_em };
  }
  const sess = (m) => sessoes.find((s) => s.mesa === m).id;
  // Histórico do turno: chamados já resolvidos (contam na resposta média).
  const feitos = [[2, 'agua', 61], [7, 'pedido', 48], [10, 'atendimento', 39], [18, 'conta', 57], [21, 'pedido', 44], [15, 'agua', 52], [3, 'atendimento', 41]]
    .map(([m, tipo, resp], i) => {
      const criado = 70 * MIN - i * 8 * MIN;
      return { id: id('c'), mesa: m, tipo, status: 'resolvido', sessao_id: sess(m), criado_em: iso(criado), visto_em: iso(criado - resp * SEG), resolvido_em: iso(criado - resp * SEG - 3 * MIN), atualizado_em: iso(criado - resp * SEG - 3 * MIN), atendente: ['Ana', 'Caio', 'Bia'][i % 3], ...(tipo === 'conta' ? { pagamento: 'Cartão' } : {}) };
    });
  const comentarios = [
    { id: id('f'), estrelas: 5, tags: ['Comida', 'Atendimento'], texto: 'O ancho veio no ponto certo e o atendimento foi rápido. Voltamos semana que vem.', mesa: 7, lido: true, criado_em: iso(26 * 60 * MIN) },
    { id: id('f'), estrelas: 4, tags: ['Ambiente'], texto: 'A varanda à noite é linda. Só a música estava um pouco alta.', mesa: null, lido: true, criado_em: iso(30 * 60 * MIN) },
    { id: id('f'), estrelas: 5, tags: ['Comida'], texto: 'Pudim de doce de leite inesquecível.', mesa: 18, lido: true, criado_em: iso(50 * 60 * MIN) },
  ];
  const ped = (numero, status, nome, tel, itens, forma, rua, minutos, extra = {}) => {
    const subtotal = itens.reduce((t, i) => t + i.preco * i.qtd, 0);
    return { id: id('p'), token: `ped-${numero}`, numero, status, cliente: { nome, telefone: tel },
      endereco: { cep: '05422000', rua, numero: String(100 + numero * 37), complemento: '', bairro: 'Pinheiros', cidade: 'São Paulo', referencia: '', lat: -23.566 + numero * 0.001, lng: -46.684 },
      itens, subtotal, taxa: 5, total: subtotal + 5, pagamento: { forma, troco: null }, obs: null, distancia_km: 0.8 + numero * 0.3, entregador: status === 'saiu' ? 'Beto' : null, motivo: null,
      historico: [{ status: 'recebido', em: iso(minutos * MIN) }], criado_em: iso(minutos * MIN), atualizado_em: iso((minutos - 2) * MIN), cpf: null, ...extra };
  };
  const pedidos = [
    ped(1, 'saiu', 'Fernanda Lima', '11991234567', [{ id: 'pao', nome: 'Pão de fermentação natural', preco: 22, qtd: 1, obs: null, opcoes: [] }, { id: 'croquete', nome: 'Croquete de costela', preco: 42, qtd: 1, obs: null, opcoes: [] }], 'pix', 'Rua Fradique Coutinho', 34),
    ped(2, 'preparo', 'Rafael Rocha', '11998765432', [{ id: 'ancho', nome: 'Ancho 350 g', preco: 118, qtd: 1, obs: null, opcoes: [] }, { id: 'peixe', nome: 'Peixe do dia na folha', preco: 96, qtd: 2, obs: null, opcoes: [] }], 'cartao', 'Rua Mourato Coelho', 21),
    ped(3, 'preparo', 'Júlia Alves', '11987651234', [{ id: 'mandioca', nome: 'Mandioca na brasa', preco: 34, qtd: 1, obs: null, opcoes: [] }, { id: 'salada', nome: 'Folhas, figo e canastra', preco: 46, qtd: 1, obs: null, opcoes: [] }], 'dinheiro', 'Rua Cardeal Arcoverde', 14),
    ped(4, 'recebido', 'Bruno Dias', '11976543210', [{ id: 'porco', nome: 'Barriga de porco laqueada', preco: 84, qtd: 2, obs: null, opcoes: [] }], 'pix', 'Rua Teodoro Sampaio', 1),
  ];
  return {
    chamados: feitos, comentarios, sessoes, mesasAbertas, etiquetas: [], fid: null, pedidos,
    configuracao: { restaurante: { logo: LOGO, capa: CAPA } },
    equipe: { senhaHash: 'video', membros: [
      { id: 'm-caio', nome: 'Caio', pinHash: 'v1', admin: true, criado_em: iso(90 * 24 * 60 * MIN) },
      { id: 'm-ana', nome: 'Ana', pinHash: 'v2', admin: false, criado_em: iso(80 * 24 * 60 * MIN) },
      { id: 'm-bia', nome: 'Bia', pinHash: 'v3', admin: false, criado_em: iso(60 * 24 * 60 * MIN) },
    ] },
  };
}

/* ---------------- Utilidades ---------------- */
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  userDataDir: PROF,
  args: ['--no-sandbox', '--force-color-profile=srgb', '--font-render-hinting=none', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
  protocolTimeout: 60000,
});
await browser.defaultBrowserContext().overridePermissions(BASE, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);

let frente = null;
async function pagina({ w, h, dpr, mobile }) {
  const p = await browser.newPage();
  frente = p;
  await p.setViewport({ width: w, height: h, deviceScaleFactor: dpr, isMobile: !!mobile, hasTouch: !!mobile });
  if (mobile) await p.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36');
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'no-preference' }]);
  await p.evaluateOnNewDocument(relogio);
  // Celular com recorte: área segura de um aparelho real (barra de status em cima, indicador embaixo).
  if (mobile) await p.evaluateOnNewDocument(() => {
    const css = ':root:root{--safe-t:47px;--safe-b:34px}';
    const pôr = () => { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); };
    if (document.head) pôr(); else document.addEventListener('DOMContentLoaded', pôr);
  });
  p.on('pageerror', (e) => console.log('  [erro na página]', e.message));
  return p;
}
async function ir(p, url) {
  await frentePara(p);
  await p.goto(BASE + url, { waitUntil: 'networkidle0' });
  await p.evaluate(() => document.fonts.ready);
  await pausa(700);
}
async function lerBanco(p) {
  return JSON.parse(await p.evaluate((k) => localStorage.getItem(k), KEY));
}
async function gravarBanco(p, db) {
  await p.evaluate((k, v) => {
    localStorage.setItem(k, v);
    new BroadcastChannel('nfc-demo').postMessage('changed');
  }, KEY, JSON.stringify(db));
}
async function mudarBanco(p, fn) {
  const db = await lerBanco(p);
  fn(db);
  await gravarBanco(p, db);
}
async function frentePara(p) {
  if (frente === p) return;
  await p.bringToFront();
  frente = p;
  await pausa(120);
}
async function foto(p, nome, opts = {}) {
  await frentePara(p);
  const f = path.join(OUT, nome);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const jpg = f.endsWith('.jpg');
  await p.screenshot({ path: f, type: jpg ? 'jpeg' : 'png', ...(jpg ? { quality: 93 } : {}), ...(opts.fullPage ? {} : { captureBeyondViewport: false }), ...opts });
}
const quadros = () => new Promise((r) => setTimeout(r, 70));
// Grava as animações em curso quadro a quadro.
async function sequencia(p, nome, ms, { fps = 30, clip, antes } = {}) {
  await frentePara(p);
  await p.evaluate(quadros);
  await p.evaluate(() => document.getAnimations().forEach((a) => a.pause()));
  if (antes) await antes();
  const total = Math.round((ms / 1000) * fps);
  for (let i = 0; i <= total; i++) {
    const t = (i * 1000) / fps;
    await p.evaluate((t) => document.getAnimations().forEach((a) => { try { a.pause(); a.currentTime = t; } catch {} }), t);
    await foto(p, `${nome}/${String(i).padStart(3, '0')}.jpg`, clip ? { clip } : {});
  }
  await p.evaluate(() => document.getAnimations().forEach((a) => { try { a.finish(); } catch { try { a.play(); } catch {} } }));
  await pausa(150);
  return total + 1;
}
async function clicar(p, sel) {
  await p.waitForSelector(sel, { visible: true, timeout: 5000 });
  await p.click(sel);
}
async function clicarTexto(p, sel, texto) {
  const ok = await p.evaluate((sel, texto) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(texto));
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  }, sel, texto);
  if (!ok) throw new Error(`não achei ${sel} "${texto}"`);
}
async function caixa(p, sel) {
  return p.evaluate((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, sel);
}
async function tocarAtalho(p, sel, nome) {
  const info = await p.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { rolagem: scrollY, x: r.x, y: r.y, w: r.width, h: r.height };
  }, sel);
  await pausa(250);
  registrar('atalho-' + nome, info);
  await p.evaluate((sel) => document.querySelector(sel).click(), sel);
}
const meta = {};
const registrar = (k, v) => { meta[k] = v; };

/* ---------------- Preparação ---------------- */
const cli = await pagina({ w: 390, h: 844, dpr: 3, mobile: true });
await cli.goto(BASE + '/assets/img/icon-64.png');
await cli.evaluate((k, db) => {
  localStorage.clear();
  localStorage.setItem(k, db);
  localStorage.setItem('nfc-tema', 'light');
  localStorage.setItem('nfc-sessao-12', 'tok-12');
  localStorage.setItem('nfc-nome', 'Marina');
  localStorage.setItem('nfc-equipe-sessao', JSON.stringify({ id: 'm-caio' }));
  localStorage.setItem('nfc-som', '0');
  localStorage.setItem('nfc-app-aviso', String(Date.now()));
}, KEY, JSON.stringify(bancoInicial()));

const passo = async (nome, fn) => {
  if (!etapa(nome)) return;
  const t = Date.now();
  try {
    await fn();
    console.log(`ok  ${nome} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  } catch (e) {
    console.log(`ERRO ${nome}: ${e.message}`);
  }
};

/* ---------------- Cliente: página da mesa ---------------- */
await ir(cli, '/?mesa=12');

await passo('inicio', async () => {
  await foto(cli, 'cliente/inicio.png');
  await foto(cli, 'cliente/inicio-pagina.png', { fullPage: true });
  registrar('inicioAltura', await cli.evaluate(() => document.documentElement.scrollHeight));
  registrar('caixas', await cli.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y + scrollY, w: b.width, h: b.height }; };
    const tiles = {};
    document.querySelectorAll('#tiles > *').forEach((t) => { const b = t.getBoundingClientRect(); tiles[(t.querySelector('h3,b') || t).textContent.trim()] = { x: b.x, y: b.y + scrollY, w: b.width, h: b.height }; });
    return { sino: r('#bell'), chamar: r('#call'), tiles, info: r('#info'), placa: r('#plate'), logo: r('#heroLogo') };
  }));
});

await passo('cardapio', async () => {
  await tocarAtalho(cli, '.tile--menu', 'cardapio');
  await sequencia(cli, 'cliente/cardapio-abrir', 420);
  await pausa(300);
  await foto(cli, 'cliente/cardapio.png');
  // + no croquete
  await cli.evaluate(() => document.querySelector('[data-qty="croquete"] .q-add').click());
  await sequencia(cli, 'cliente/cardapio-mais', 360);
  await foto(cli, 'cliente/cardapio-1.png');
  registrar('cardapioMais', await caixa(cli, '[data-qty="croquete"]'));
  // versão longa para a rolagem
  await cli.setViewport({ width: 390, height: 2600, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await pausa(500);
  await foto(cli, 'cliente/cardapio-longo.jpg');
  registrar('cardapioCorpo', await caixa(cli, '#menuBody'));
  await cli.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await pausa(400);
  // ancho
  await cli.evaluate(() => { const b = document.querySelector('[data-qty="ancho"]'); b.scrollIntoView({ block: 'center' }); });
  await pausa(400);
  await foto(cli, 'cliente/cardapio-brasa.png');
  await cli.evaluate(() => document.querySelector('[data-qty="ancho"] .q-add').click());
  await pausa(400);
  await foto(cli, 'cliente/cardapio-2.png');
  await clicar(cli, '#sh-menu .menu-bar [data-close]');
  await pausa(500);
});

await passo('wifi', async () => {
  await tocarAtalho(cli, '[data-open="sh-wifi"]', 'wifi');
  await sequencia(cli, 'cliente/wifi-abrir', 420);
  await pausa(200);
  await foto(cli, 'cliente/wifi.png');
  registrar('wifiCopiar', await caixa(cli, '#copyPass2'));
  await clicar(cli, '#copyPass2');
  await sequencia(cli, 'cliente/wifi-copiar', 500);
  await foto(cli, 'cliente/wifi-copiado.png');
  await pausa(3200);
  await clicar(cli, '#sh-wifi [data-close].icon-btn');
  await pausa(500);
});

await passo('dividir', async () => {
  await tocarAtalho(cli, '[data-open="sh-split"]', 'dividir');
  await sequencia(cli, 'cliente/dividir-abrir', 420);
  await pausa(200);
  await foto(cli, 'cliente/dividir-0.png');
  registrar('dividirCampo', await caixa(cli, '#splitTotal'));
  registrar('dividirMais', await caixa(cli, '#pPlus'));
  await cli.focus('#splitTotal');
  const valor = '386,40';
  for (let i = 1; i <= valor.length; i++) {
    await cli.type('#splitTotal', valor[i - 1]);
    await pausa(60);
    await foto(cli, `cliente/dividir-digitar/${String(i).padStart(3, '0')}.jpg`);
  }
  await cli.evaluate(() => document.activeElement.blur());
  for (let i = 0; i < 2; i++) {
    await clicar(cli, '#pPlus');
    await pausa(120);
    await foto(cli, `cliente/dividir-pessoas-${3 + i}.png`);
  }
  await clicar(cli, '#sh-split [data-close].icon-btn');
  await pausa(500);
});

await passo('info', async () => {
  await cli.evaluate(() => { const d = document.querySelector('.info-row-wrap'); if (d) d.open = true; scrollTo(0, document.documentElement.scrollHeight); });
  await pausa(400);
  await foto(cli, 'cliente/info.png');
  await foto(cli, 'cliente/pagina-info.png', { fullPage: true });
  await cli.evaluate(() => { const d = document.querySelector('.info-row-wrap'); if (d) d.open = false; scrollTo(0, 0); });
  await pausa(300);
});

/* ---------------- Sino + garçom no celular ---------------- */
const gar = await pagina({ w: 390, h: 844, dpr: 3, mobile: true });

await passo('sino', async () => {
  // A) cliente escolhe o motivo, a forma de pagamento e segura o sino
  await frentePara(cli);
  await cli.evaluate(() => scrollTo(0, document.querySelector('#call').getBoundingClientRect().top + scrollY - 58));
  await pausa(300);
  await foto(cli, 'cliente/sino-0.png');
  registrar('motivoConta', await caixa(cli, '[data-motivo="conta"]'));
  await cli.evaluate(() => document.querySelector('[data-motivo="conta"]').click());
  await pausa(150);
  await foto(cli, 'cliente/sino-motivo.png');
  registrar('pagPix', await caixa(cli, '[data-pay="Pix"]'));
  await cli.evaluate(() => document.querySelector('[data-pay="Pix"]').click());
  await pausa(200);
  await cli.evaluate(() => scrollTo(0, document.querySelector('#call').getBoundingClientRect().top + scrollY - 58));
  await pausa(200);
  await foto(cli, 'cliente/sino-conta.png');
  registrar('motivoConta2', await caixa(cli, '[data-motivo="conta"]'));
  registrar('pagPix2', await caixa(cli, '[data-pay="Pix"]'));
  const sino = await caixa(cli, '#bell');
  registrar('sino', sino);
  const pad = 30;
  const rolagem = await cli.evaluate(() => scrollY);
  registrar('sinoRolagem', rolagem);
  // recorte em coordenadas do documento; a sobreposição no vídeo usa as da tela
  const clip = { x: sino.x - pad, y: sino.y + rolagem - pad, width: sino.width + pad * 2, height: sino.height + pad * 2 };
  registrar('sinoClip', { ...clip, y: sino.y - pad });
  await cli.evaluate(() => document.querySelector('#bell').classList.add('is-holding'));
  await pausa(350);
  await foto(cli, 'cliente/sino-segurando.png');
  for (let i = 0; i <= 27; i++) {
    await cli.evaluate((p) => { const el = document.querySelector('#bellProg'); el.style.transition = 'none'; el.style.strokeDashoffset = String(100 - p * 100); }, i / 27);
    await foto(cli, `cliente/sino-anel/${String(i).padStart(3, '0')}.png`, { clip });
  }
  await cli.evaluate(() => { const b = document.querySelector('#bell'); b.classList.remove('is-holding'); const p = document.querySelector('#bellProg'); p.style.strokeDashoffset = '100'; p.style.transition = ''; });
  await pausa(400);
  await cli.mouse.move(sino.x + sino.width / 2, sino.y + sino.height / 2);
  await cli.mouse.down();
  await pausa(1100);
  await cli.mouse.up();
  await sequencia(cli, 'cliente/sino-enviado', 600);
  await foto(cli, 'cliente/sino-enviado.png');
  await pausa(1300);
  await foto(cli, 'cliente/sino-enviado-2.png');
  const db0 = await lerBanco(cli);
  const real = db0.chamados.find((c) => c.mesa === 12 && c.status === 'aberto');
  console.log('  sino: chamado', real && real.id);

  // B) celular do garçom: o chamado chega ao vivo
  await mudarBanco(cli, (db) => { db.chamados = db.chamados.filter((c) => c.id !== real.id); });
  await ir(gar, '/admin/#chamados');
  await pausa(600);
  await foto(gar, 'garcom/vazio.png');
  const novo = { ...real, id: id('c'), criado_em: iso(0), atualizado_em: iso(0) };
  await mudarBanco(gar, (db) => { db.chamados.push(novo); });
  await pausa(120);
  await sequencia(gar, 'garcom/chegou', 1500);
  await foto(gar, 'garcom/chamado.png');
  registrar('garcomIr', await caixa(gar, '[data-act="ir"]'));
  await gar.click('[data-act="ir"]');
  await sequencia(gar, 'garcom/estou-indo', 600);
  await foto(gar, 'garcom/a-caminho.png');

  // C) cliente vê o garçom a caminho
  await mudarBanco(gar, (db) => { const c = db.chamados.find((x) => x.id === novo.id); Object.assign(c, { status: 'aberto', atendente: null, visto_em: null }); });
  await frentePara(cli);
  await cli.evaluate((idc) => localStorage.setItem('nfc-ativo-12', idc), novo.id);
  await ir(cli, '/?mesa=12');
  await cli.evaluate(() => scrollTo(0, document.querySelector('#call').getBoundingClientRect().top + scrollY - 58));
  await pausa(1500);
  await foto(cli, 'cliente/sino-enviado-3.png');
  await mudarBanco(cli, (db) => { const c = db.chamados.find((x) => x.id === novo.id); Object.assign(c, { status: 'a_caminho', atendente: 'Caio', visto_em: iso(0), atualizado_em: iso(0) }); });
  await pausa(60);
  await sequencia(cli, 'cliente/sino-caminho', 600);
  await foto(cli, 'cliente/sino-caminho.png');
  await cli.evaluate(() => scrollTo(0, 0));
});

/* ---------------- Comentário anônimo ---------------- */
await passo('comentario', async () => {
  await tocarAtalho(cli, '[data-open="sh-feedback"]', 'comentario');
  await sequencia(cli, 'cliente/comentario-abrir', 420);
  await pausa(200);
  await foto(cli, 'cliente/comentario-0.png');
  registrar('estrelas', await cli.evaluate(() => [...document.querySelectorAll('[data-star]')].map((b) => { const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })));
  for (const s of [1, 2, 3]) {
    await cli.evaluate((s) => document.querySelector(`[data-star="${s}"]`).click(), s);
    await pausa(90);
    await foto(cli, `cliente/comentario-estrela-${s}.png`);
  }
  await clicarTexto(cli, '[data-tag]', 'Tempo de espera');
  await pausa(120);
  await foto(cli, 'cliente/comentario-tag.png');
  registrar('tagEspera', await cli.evaluate(() => { const r = [...document.querySelectorAll('[data-tag]')].find((b) => b.textContent.includes('Tempo de espera')).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
  const texto = 'A sobremesa demorou um pouco. O ancho estava perfeito.';
  await cli.focus('#fbText');
  let k = 0;
  for (let i = 4; i <= texto.length; i += 4) {
    await cli.type('#fbText', texto.slice(i - 4, i));
    await foto(cli, `cliente/comentario-digitar/${String(++k).padStart(3, '0')}.jpg`);
  }
  const resto = texto.slice(k * 4);
  if (resto) { await cli.type('#fbText', resto); await foto(cli, `cliente/comentario-digitar/${String(++k).padStart(3, '0')}.jpg`); }
  await cli.evaluate(() => document.activeElement.blur());
  await pausa(150);
  await cli.evaluate(() => document.querySelector('#fbSend').scrollIntoView({ block: 'center' }));
  await pausa(250);
  await foto(cli, 'cliente/comentario-pronto.png');
  registrar('fbEnviar', await caixa(cli, '#fbSend'));
  await clicar(cli, '#fbSend');
  await pausa(300);
  await sequencia(cli, 'cliente/comentario-enviado', 400);
  await foto(cli, 'cliente/comentario-enviado.png');
  await clicar(cli, '#sh-feedback [data-close].icon-btn');
  await pausa(500);
});

/* ---------------- Painel no computador ---------------- */
const pc = await pagina({ w: 1440, h: 900, dpr: 2 });

await passo('painel', async () => {
  // Turno cheio: outras mesas chamando; a mesa 12 volta a "aberto" para chegar ao vivo.
  await mudarBanco(cli, (db) => {
    const sess = (m) => db.sessoes.find((s) => s.mesa === m).id;
    db.chamados = db.chamados.filter((c) => c.mesa !== 12 || c.status === 'resolvido');
    db.chamados.push(
      { id: id('c'), mesa: 3, tipo: 'pedido', status: 'aberto', sessao_id: sess(3), criado_em: iso(2 * MIN + 24 * SEG), atualizado_em: iso(2 * MIN + 24 * SEG), itens: [{ id: 'croquete', nome: 'Croquete de costela', qtd: 2, preco: 42 }, { id: 'caipi', nome: 'Caipirinha de caju', qtd: 2, preco: 32 }] },
      { id: id('c'), mesa: 5, tipo: 'agua', status: 'aberto', sessao_id: sess(5), criado_em: iso(53 * SEG), atualizado_em: iso(53 * SEG) },
      { id: id('c'), mesa: 9, tipo: 'atendimento', status: 'aberto', sessao_id: sess(9), criado_em: iso(20 * SEG), atualizado_em: iso(20 * SEG) },
      { id: id('c'), mesa: 17, tipo: 'atendimento', status: 'a_caminho', atendente: 'Ana', visto_em: iso(25 * SEG), sessao_id: sess(17), criado_em: iso(70 * SEG), atualizado_em: iso(25 * SEG) },
    );
  });
  await ir(pc, '/admin/#chamados');
  await foto(pc, 'painel/chamados-antes.png');
  // A mesa 12 chama
  const c12 = id('c');
  await mudarBanco(cli, (db) => {
    db.chamados.push({ id: c12, mesa: 12, tipo: 'conta', pagamento: 'Pix', status: 'aberto', sessao_id: db.sessoes.find((s) => s.mesa === 12).id, criado_em: iso(0), atualizado_em: iso(0) });
  });
  await pausa(150);
  await sequencia(pc, 'painel/chegou', 1500);
  await foto(pc, 'painel/chamados.png');
  await pausa(2000);
  await foto(pc, 'painel/chamados-2.png');
  // Caio vai até a mesa 12
  await mudarBanco(cli, (db) => {
    const c = db.chamados.find((x) => x.id === c12);
    Object.assign(c, { status: 'a_caminho', atendente: 'Caio', visto_em: iso(0), atualizado_em: iso(0) });
  });
  await pausa(150);
  await sequencia(pc, 'painel/caminho', 600);
  await foto(pc, 'painel/chamados-caminho.png');
  await ir(pc, '/admin/#salao');
  await foto(pc, 'painel/salao.png');
  await ir(pc, '/admin/#comentarios');
  await foto(pc, 'painel/comentarios.png');
  await ir(pc, '/admin/#delivery');
  await foto(pc, 'painel/delivery.png');
  await ir(pc, '/admin/#fidelidade');
  await foto(pc, 'painel/fidelidade.png');
  await ir(pc, '/admin/#chamados');
  await foto(pc, 'painel/chamados-final.png');
  // garçom no celular com o turno cheio
  await ir(gar, '/admin/#chamados');
  await foto(gar, 'garcom/turno.png');
  await foto(gar, 'garcom/turno-pagina.png', { fullPage: true });
  await ir(gar, '/admin/#salao');
  await foto(gar, 'garcom/salao.png');
});

/* ---------------- Delivery (cliente) ---------------- */
await passo('delivery', async () => {
  await ir(cli, '/delivery/');
  await foto(cli, 'cliente/delivery.png');
  await foto(cli, 'cliente/delivery-pagina.png', { fullPage: true });
  await browser.defaultBrowserContext().overridePermissions(BASE, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write', 'notifications']);
  await cli.evaluate(() => localStorage.setItem('dl-push-ped-2', '1'));
  await ir(cli, '/delivery/?pedido=ped-2');
  await foto(cli, 'cliente/delivery-acompanhar.png');
});

const arqMeta = path.join(OUT, 'meta.json');
const antigo = fs.existsSync(arqMeta) ? JSON.parse(fs.readFileSync(arqMeta, 'utf8')) : {};
fs.writeFileSync(arqMeta, JSON.stringify({ ...antigo, ...meta, OFF, ALVO }, null, 2));
await browser.close();
console.log('fim');
