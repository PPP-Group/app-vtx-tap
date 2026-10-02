/*
 * PDF das plaquinhas para a gráfica, no tamanho exato de um cartão de crédito
 * (ISO/IEC 7810 ID-1: 85,60 × 53,98 mm, cantos com raio de 3,18 mm), impresso dos dois lados:
 * para cada plaquinha, uma página com a FRENTE (deitada) e a seguinte com o VERSO (em pé).
 *
 * Os dois lados têm o mesmo conteúdo, na identidade visual da Vortex:
 *   - o QR com a logo no meio (miolo dos três quadrados de canto na cor de destaque);
 *   - no personalizado, o nome do restaurante escrito (a logo dele já está no meio do QR);
 *   - uma faixa no gradiente da cor de destaque com as ondas de NFC, "Aproxime o celular",
 *     a dica de ler o QR e "feito por" com a logo da VTX Tap em uma cor (branca ou noite,
 *     para contrastar com a faixa);
 *   - o código da plaquinha, pequeno.
 * Frente: QR à esquerda, faixa à direita (onde fica o chip). Verso: QR em cima, faixa embaixo.
 *
 * Dois modelos:
 *   'padrao'        → logo da VTX Tap no meio do QR e faixa no gradiente do bloco roxo da marca.
 *   'personalizado' → "personalizado simples": logo e nome do restaurante, faixa na cor dele.
 *                     Sem logo do restaurante, sai igual ao padrão.
 *
 * Qualidade de impressão: QR, faixa, anéis e ondas em vetor; textos pequenos em Sora embutida
 * no PDF; títulos em Big Shoulders Display rasterizados a 1.000 dpi (a fonte só existe como
 * webfont na página); logos na resolução original. O QR tem correção de erro alta (H) para
 * continuar lendo com a logo no meio.
 */
(function () {
  // Textos e medidas da plaquinha. Troque aqui para mudar em todas as próximas.
  const PLACA = {
    largura: 85.6,
    altura: 53.98,
    raio: 3.18,
    titulo: ['Aproxime', 'o celular'],
    dica: 'ou aponte a câmera para o QR Code',
    feito: 'feito por',
  };
  const NOITE = '#140B33';
  const COR_CODIGO = '#B7BCC6';
  const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const rgbHex = (c) => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
  const misturar = (h, alvo, t) => rgbHex(hexRgb(h).map((v, i) => v + (hexRgb(alvo)[i] - v) * t));
  const luz = (h) => {
    const [r, g, b] = hexRgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  /* Cores de um lado da plaquinha.
     Padrão: o gradiente do bloco roxo da marca, texto branco e o ponto das ondas em noite.
     Personalizado: a cor do restaurante descendo para um tom mais escuro dela. Em cor clara demais
     (amarelo, por exemplo), texto, ondas e logo passam para noite. */
  const PALETA_VTX = { faixa: ['#7D27FC', '#5B14C9', '#3C0A8E'], tinta: '#FFFFFF', ponto: NOITE, olho: '#7D27FC', nome: NOITE, clara: false };
  function paleta(cor) {
    if (!/^#[0-9a-f]{6}$/i.test(cor || '')) return PALETA_VTX;
    const clara = luz(cor) > 0.4;
    // Cor clara escurece pouco no degradê (escurecer amarelo demais vira oliva).
    const escuro = misturar(cor, '#000000', clara ? 0.16 : 0.38);
    // Miolo dos cantos do QR: a cor escurecida até o leitor achar o canto com folga.
    let olho = cor;
    for (let i = 0; i < 20 && luz(olho) > 0.18; i++) olho = misturar(olho, '#000000', 0.1);
    return {
      faixa: [cor, misturar(cor, '#000000', clara ? 0.07 : 0.18), escuro],
      tinta: clara ? NOITE : '#FFFFFF',
      ponto: clara ? cor : escuro,
      olho,
      nome: misturar(cor, '#000000', 0.5),
      clara,
    };
  }
  const JSPDF = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js';
  const SVG2PDF = 'https://cdn.jsdelivr.net/npm/svg2pdf.js@2.2.4/dist/svg2pdf.umd.min.js';
  // Sora (SIL OFL, assets/fonts/OFL.txt), embutida no PDF.
  const FONTES = { semibold: '/assets/fonts/Sora-SemiBold.ttf', light: '/assets/fonts/Sora-Light.ttf' };
  const TITULO_FONTE = '"Big Shoulders Display"';
  const LOGO_VTX = '/admin/icons/icon-512.png';            // marca quadrada (miolo do QR)
  const LOGO_VTX_BRANCO = '/assets/img/vtx-tap-branco.png'; // "feito por" sobre faixa escura
  const LOGO_VTX_NOITE = '/assets/img/vtx-tap-noite.png';   // "feito por" sobre faixa clara

  /* Ondas de NFC: o ponto de origem e três arcos (caixa 48 × 48). */
  const ONDAS = (tinta, ponto) => ({
    w: 48, h: 48,
    svg: `<g fill="none" stroke="${tinta}" stroke-width="4.2" stroke-linecap="round"><circle cx="12" cy="24" r="4.2" fill="${ponto}" stroke="none"/>
      <path d="M20 15.5a12 12 0 0 1 0 17"/><path d="M27 10a19.5 19.5 0 0 1 0 28"/><path d="M34 4.5a27 27 0 0 1 0 39"/></g>`,
  });

  const carregarScript = (src) =>
    new Promise((ok, falha) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = ok;
      s.onerror = () => falha(new Error('Não foi possível carregar o gerador de PDF. Confira a internet.'));
      document.head.appendChild(s);
    });

  const carregarImg = (src) =>
    new Promise((ok, falha) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => ok(img);
      img.onerror = () => falha(new Error('Não foi possível carregar a logo.'));
      img.src = src;
    });

  // Fonte TTF → base64 para o jsPDF embutir.
  async function fonteBase64(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('Não foi possível carregar a fonte da plaquinha.');
    const b = new Uint8Array(await r.arrayBuffer());
    let bin = '';
    for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // SVG em vetor no PDF (svg2pdf.js), na posição e no tamanho pedidos.
  async function svgNoPdf(doc, { w, h, svg }, x, y, largura, altura) {
    const el = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${svg}</svg>`, 'image/svg+xml').documentElement;
    const f = (window.svg2pdf && (window.svg2pdf.svg2pdf || window.svg2pdf)) || null;
    if (typeof f !== 'function') throw new Error('Gerador de PDF incompleto. Confira a internet.');
    await f(el, doc, { x, y, width: largura, height: altura });
  }

  // Logo → PNG (com a proporção dela). Logo sem permissão de leitura (CORS) ou quebrada: null.
  async function logoPng(src, px = 2400) {
    try {
      const img = await carregarImg(src);
      // Resolução original (até 2400 px no lado maior: ~5000 dpi no miolo do QR).
      const k = Math.min(1, px / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return { url: c.toDataURL('image/png'), w: c.width, h: c.height };
    } catch {
      return null;
    }
  }

  /* Título em Big Shoulders Display 900, caixa alta, como imagem a 40 px/mm (~1.000 dpi).
     tamanho: corpo da fonte em mm. Devolve a largura em mm. alinhar: 'esquerda' | 'centro'. */
  const PX_MM = 40;
  function titulo(doc, linhas, x, y, { tamanho, cor, alinhar = 'esquerda', entrelinha = 0.9 }) {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const fonte = `900 ${tamanho * PX_MM}px ${TITULO_FONTE}, 'Arial Narrow', Impact, sans-serif`;
    ctx.font = fonte;
    const ls = linhas.map((l) => l.toLocaleUpperCase('pt-BR'));
    const w = Math.ceil(Math.max(...ls.map((l) => ctx.measureText(l).width))) + 4;
    const passo = tamanho * entrelinha * PX_MM;
    const folga = tamanho * 0.3 * PX_MM; // espaço em cima para acento de maiúscula (Ô, É)
    c.width = w;
    c.height = Math.ceil(folga + passo * (ls.length - 1) + tamanho * 1.05 * PX_MM);
    ctx.font = fonte;
    ctx.fillStyle = cor;
    ctx.textBaseline = 'alphabetic';
    ls.forEach((l, i) => {
      const lw = ctx.measureText(l).width;
      ctx.fillText(l, alinhar === 'centro' ? (w - lw) / 2 : 0, folga + tamanho * 0.82 * PX_MM + i * passo);
    });
    const wmm = c.width / PX_MM;
    doc.addImage(c.toDataURL('image/png'), 'PNG', alinhar === 'centro' ? x - wmm / 2 : x, y - folga / PX_MM, wmm, c.height / PX_MM, undefined, 'FAST');
    return wmm;
  }

  function texto(doc, t, x, y, { tamanho, cor, espaco = 0, alinhar = 'esquerda', angulo = 0, peso = 'light' } = {}) {
    doc.setFont('Sora', peso);
    doc.setFontSize(tamanho);
    doc.setTextColor(cor);
    doc.setCharSpace(espaco);
    const w = doc.getTextWidth(t) + espaco * (t.length - 1);
    if (angulo) doc.text(t, x, y, { angle: angulo });
    else doc.text(t, alinhar === 'centro' ? x - w / 2 : x, y);
    doc.setCharSpace(0);
    return w;
  }

  // Imagem centralizada numa caixa, mantendo a proporção.
  function imagemNaCaixa(doc, img, x, y, w, h, alias) {
    const k = Math.min(w / img.w, h / img.h);
    const iw = img.w * k;
    const ih = img.h * k;
    doc.addImage(img.url, 'PNG', x + (w - iw) / 2, y + (h - ih) / 2, iw, ih, alias, 'FAST');
  }

  /* QR em vetor. Cada sequência de módulos escuros de uma linha vira um retângulo; os três
     quadrados de canto saem com contorno arredondado em noite e o miolo na cor de destaque.
     O meio (26% do lado) fica livre para a logo. Devolve a caixa do meio. */
  function desenharQr(doc, url, x, y, lado, corOlho) {
    if (typeof window.qrcode !== 'function') throw new Error('Gerador de QR indisponível. Confira a internet.');
    const qr = window.qrcode(0, 'H');
    qr.addData(url);
    qr.make();
    const n = qr.getModuleCount();
    const m = lado / n;
    const cantos = [[0, 0], [0, n - 7], [n - 7, 0]];
    const noCanto = (r, c) => cantos.some(([r0, c0]) => r >= r0 && r < r0 + 7 && c >= c0 && c < c0 + 7);
    const k = Math.round(n * 0.26);
    const ini0 = Math.floor((n - k) / 2);
    const noMeio = (r, c) => r >= ini0 && r < ini0 + k && c >= ini0 && c < ini0 + k;
    const escuro = (r, c) => qr.isDark(r, c) && !noCanto(r, c) && !noMeio(r, c);
    doc.setFillColor(NOITE);
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (!escuro(r, c)) { c++; continue; }
        const ini = c;
        while (c < n && escuro(r, c)) c++;
        // Leve sobreposição para não aparecer fresta entre as linhas.
        doc.rect(x + ini * m, y + r * m, (c - ini) * m + 0.01, m + 0.02, 'F');
      }
    }
    cantos.forEach(([r0, c0]) => {
      doc.setDrawColor(NOITE);
      doc.setLineWidth(m);
      doc.roundedRect(x + (c0 + 0.5) * m, y + (r0 + 0.5) * m, 6 * m, 6 * m, 1.6 * m, 1.6 * m, 'S');
      doc.setFillColor(corOlho);
      doc.roundedRect(x + (c0 + 2) * m, y + (r0 + 2) * m, 3 * m, 3 * m, 0.8 * m, 0.8 * m, 'F');
    });
    return { x: x + ini0 * m, y: y + ini0 * m, lado: k * m };
  }

  /* Faixa: retângulo com os cantos do lado de fora arredondados, gradiente a 150° e os anéis da
     marca sangrando de um canto. lado: 'direita' (frente) ou 'baixo' (verso). */
  function faixaSvg(w, h, pal, lado, R) {
    const r = PLACA.raio;
    const forma = lado === 'direita'
      ? `M0 0H${w - r}A${r} ${r} 0 0 1 ${w} ${r}V${h - r}A${r} ${r} 0 0 1 ${w - r} ${h}H0Z`
      : `M0 0H${w}V${h - r}A${r} ${r} 0 0 1 ${w - r} ${h}H${r}A${r} ${r} 0 0 1 0 ${h - r}Z`;
    const [cx, cy] = lado === 'direita' ? [w, h] : [0, h];
    const anel = pal.clara ? NOITE : '#FFFFFF';
    // Raios e opacidades dos três anéis (proporções do grafismo do manual).
    const aneis = [[0.34, 0.06, 0.16], [0.555, 0.06, 0.08], [0.775, 0.06, 0.045]]
      .map(([k, e, o]) => `<circle cx="${cx}" cy="${cy}" r="${R * k}" fill="none" stroke="${anel}" stroke-opacity="${o}" stroke-width="${R * e}"/>`).join('');
    return {
      w, h,
      svg: `<defs><linearGradient id="g" x1="0" y1="0" x2="0.5" y2="0.87"><stop offset="0" stop-color="${pal.faixa[0]}"/><stop offset=".55" stop-color="${pal.faixa[1]}"/><stop offset="1" stop-color="${pal.faixa[2]}"/></linearGradient>
        <clipPath id="c"><path d="${forma}"/></clipPath></defs>
        <path d="${forma}" fill="url(#g)"/><g clip-path="url(#c)">${aneis}</g>`,
    };
  }

  /* "feito por" + logo da VTX Tap em uma cor. x é a borda esquerda, ou o centro quando centro = true. */
  function feitoPor(doc, logo, x, yMeio, cor, { centro = false } = {}) {
    const lh = 3.6;
    const lw = logo ? (logo.w / logo.h) * lh : 0;
    doc.setFont('Sora', 'light');
    doc.setFontSize(4.2);
    const tw = doc.getTextWidth(PLACA.feito);
    const total = tw + 1.2 + lw;
    const x0 = centro ? x - total / 2 : x;
    texto(doc, PLACA.feito, x0, yMeio + 0.55, { tamanho: 4.2, cor });
    if (logo) doc.addImage(logo.url, 'PNG', x0 + tw + 1.2, yMeio - lh / 2, lw, lh, cor === NOITE ? 'vtx-noite' : 'vtx-branco', 'FAST');
  }

  // Logo no meio do QR: a da VTX Tap ocupa a caixa; a do restaurante vai sobre um fundo branco arredondado.
  function logoNoQr(doc, meio, logo, ehVtx, alias) {
    if (!logo) return;
    const f = meio.lado * 0.06;
    if (!ehVtx) {
      doc.setFillColor('#FFFFFF');
      doc.roundedRect(meio.x, meio.y, meio.lado, meio.lado, 1, 1, 'F');
    }
    imagemNaCaixa(doc, logo, meio.x + f, meio.y + f, meio.lado - 2 * f, meio.lado - 2 * f, alias);
  }

  /* Frente, deitada: QR à esquerda, faixa à direita sobre o chip. */
  async function frente(doc, it, ctx) {
    const { L, A, pal, logoMeio, ehVtx, aliasLogo, logoFeito, nome } = ctx;
    doc.setFillColor('#FFFFFF');
    doc.roundedRect(0, 0, L, A, PLACA.raio, PLACA.raio, 'F');

    const fw = 34.4;
    const fx = L - fw;
    await svgNoPdf(doc, faixaSvg(fw, A, pal, 'direita', 31.1), fx, 0, fw, A);

    // QR (menor quando o nome do restaurante vai em cima dele), centralizado na parte branca.
    const qr = nome ? 37.2 : 40.4;
    const qx = (fx - qr) / 2 + 0.6;
    const qy = nome ? 9.6 : (A - qr) / 2;
    if (nome) titulo(doc, [nome], fx / 2 + 0.6, 3.6, { tamanho: 3.4, cor: pal.nome, alinhar: 'centro' });
    logoNoQr(doc, desenharQr(doc, it.url, qx, qy, qr, pal.olho), logoMeio, ehVtx, aliasLogo);

    // Código em pé na borda esquerda, lido de baixo para cima.
    doc.setFont('Sora', 'semibold');
    doc.setFontSize(4.6);
    const wc = doc.getTextWidth(it.codigo) + 0.45 * (it.codigo.length - 1);
    texto(doc, it.codigo, 2.9, (A + wc) / 2, { tamanho: 4.6, cor: COR_CODIGO, espaco: 0.45, angulo: 90, peso: 'semibold' });

    // Faixa: ondas, título em duas linhas, dica do QR e "feito por" no pé.
    const px = fx + 3.8;
    await svgNoPdf(doc, ONDAS(pal.tinta, pal.ponto), px, 4.6, 6.2, 6.2);
    titulo(doc, PLACA.titulo, px, 12.2, { tamanho: 6.2, cor: pal.tinta });
    const dica = PLACA.dica.split(' para ');
    texto(doc, dica[0], px, 27.6, { tamanho: 5.1, cor: pal.tinta });
    texto(doc, 'para ' + dica[1], px, 29.9, { tamanho: 5.1, cor: pal.tinta });
    feitoPor(doc, logoFeito, px, A - 5.7, pal.tinta);
  }

  /* Verso, em pé: QR em cima, faixa embaixo. Mesmo conteúdo da frente. */
  async function verso(doc, it, ctx) {
    const { L, A, pal, logoMeio, ehVtx, aliasLogo, logoFeito, nome } = ctx;
    // No verso a página é em pé: largura A, altura L.
    const W = A;
    const H = L;
    doc.setFillColor('#FFFFFF');
    doc.roundedRect(0, 0, W, H, PLACA.raio, PLACA.raio, 'F');

    const fh = 27;
    const fy = H - fh;
    await svgNoPdf(doc, faixaSvg(W, fh, pal, 'baixo', 28.3), 0, fy, W, fh);

    const qr = nome ? 39.2 : 42;
    const qx = (W - qr) / 2;
    const qy = nome ? 10 : 7.4;
    if (nome) titulo(doc, [nome], W / 2, 3.8, { tamanho: 3.8, cor: pal.nome, alinhar: 'centro' });
    logoNoQr(doc, desenharQr(doc, it.url, qx, qy, qr, pal.olho), logoMeio, ehVtx, aliasLogo);

    doc.setFont('Sora', 'semibold');
    doc.setFontSize(4.6);
    const wc = doc.getTextWidth(it.codigo) + 0.45 * (it.codigo.length - 1);
    texto(doc, it.codigo, W / 2 - wc / 2, qy + qr + 3.2, { tamanho: 4.6, cor: COR_CODIGO, espaco: 0.45, peso: 'semibold' });

    await svgNoPdf(doc, ONDAS(pal.tinta, pal.ponto), W / 2 - 2.7, fy + 3, 5.4, 5.4);
    titulo(doc, [PLACA.titulo.join(' ')], W / 2, fy + 9.2, { tamanho: 6, cor: pal.tinta, alinhar: 'centro' });
    texto(doc, PLACA.dica, W / 2, fy + 18.6, { tamanho: 4.8, cor: pal.tinta, alinhar: 'centro' });
    feitoPor(doc, logoFeito, W / 2, H - 4.4, pal.tinta, { centro: true });
  }

  /**
   * Gera e baixa o PDF: para cada plaquinha, a frente (página deitada) e o verso (página em pé),
   * no tamanho de um cartão de crédito.
   * @param {{codigo: string, url: string, logo?: string, cor?: string, nome?: string}[]} itens  logo, cor (#rrggbb) e nome do restaurante (modelo personalizado)
   * @param {string} nomeArquivo
   * @param {{modelo?: 'padrao'|'personalizado'}} opcoes
   */
  async function baixarPdf(itens, nomeArquivo, { modelo = 'padrao' } = {}) {
    if (!itens.length) throw new Error('Nenhuma plaquinha para gerar.');
    if (!window.jspdf) await carregarScript(JSPDF);
    if (!window.svg2pdf) await carregarScript(SVG2PDF);
    try { await document.fonts.load(`900 100px ${TITULO_FONTE}`); } catch { /* sem a webfont, o título sai na fonte de reserva */ }
    const { jsPDF } = window.jspdf;
    const L = PLACA.largura;
    const A = PLACA.altura;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [L, A], compress: true, putOnlyUsedFonts: true });
    doc.setProperties({ title: nomeArquivo.replace(/\.pdf$/, ''), creator: 'Central de plaquinhas', subject: `Cartão ${L} × ${A} mm, frente e verso, cantos com raio de ${PLACA.raio} mm` });

    for (const [peso, url] of Object.entries(FONTES)) {
      const nome = url.split('/').pop();
      doc.addFileToVFS(nome, await fonteBase64(url));
      doc.addFont(nome, 'Sora', peso);
    }
    const vtx = await logoPng(LOGO_VTX);
    const vtxBranco = await logoPng(LOGO_VTX_BRANCO);
    const vtxNoite = await logoPng(LOGO_VTX_NOITE);
    const logos = {};
    if (modelo === 'personalizado') {
      for (const u of new Set(itens.map((it) => it.logo).filter(Boolean))) logos[u] = await logoPng(u);
    }

    for (const [i, it] of itens.entries()) {
      const logoRest = modelo === 'personalizado' && it.logo && logos[it.logo];
      const pal = logoRest ? paleta(it.cor) : PALETA_VTX;
      const ctx = {
        L, A, pal,
        logoMeio: logoRest || vtx,
        ehVtx: !logoRest,
        aliasLogo: logoRest ? 'logo-' + it.logo : 'logo-vtx',
        logoFeito: pal.tinta === NOITE ? vtxNoite : vtxBranco,
        nome: logoRest ? String(it.nome || '').trim() : '',
      };
      if (i) doc.addPage([L, A], 'landscape');
      await frente(doc, it, ctx);
      doc.addPage([A, L], 'portrait');
      await verso(doc, it, ctx);
    }

    doc.save(nomeArquivo);
  }

  window.Placa = { baixarPdf, PLACA };
})();
