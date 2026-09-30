/*
 * PDF das plaquinhas para a gráfica: uma plaquinha por página, no tamanho exato de um
 * cartão de crédito (ISO/IEC 7810 ID-1: 85,60 × 53,98 mm, cantos com raio de 3,18 mm).
 *
 * Layout: fundo branco, divisória em roxo claro no meio exato do cartão. À esquerda, o QR
 * centralizado, com uma logo no meio e o miolo dos três quadrados de canto em roxo claro.
 * À direita, centralizados na mesma linha: o ícone de NFC grande, "Aproxime o celular" e o @.
 * O código da plaquinha sai pequeno, em pé na lateral direita (lido de cima para baixo).
 *
 * Dois modelos:
 *   'padrao'        → logo da VTX Tap no meio do QR.
 *   'personalizado' → "personalizado básico": logo do restaurante no meio do QR.
 *   Nos dois, a logo da VTX Tap pequenininha fica em cima do @. Sem logo do restaurante,
 *                     sai igual ao padrão.
 *
 * Qualidade de impressão: QR, ícone de NFC e textos em vetor (nítidos em qualquer tamanho),
 * textos na fonte Sora embutida no PDF, logos na resolução original. O QR tem correção de
 * erro alta (H) para continuar lendo com a logo no meio.
 */
(function () {
  // Textos e medidas da plaquinha. Troque aqui para mudar em todas as próximas.
  const PLACA = {
    largura: 85.6,
    altura: 53.98,
    raio: 3.18,
    rodape: '@vortexsoftwareco',
    titulo: 'Aproxime o celular',
  };
  const TINTA = '#1C2733';
  const LILAS = '#C9B3FF';        // roxo bem claro: divisória e detalhes do ícone de NFC
  const LILAS_QR = '#A987FF';     // miolo dos quadrados do QR (um pouco mais forte para o leitor achar)
  const COR_CODIGO = '#B7BCC6';   // código da plaquinha, cinza clarinho, em pé na lateral direita
  const JSPDF = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js';
  const SVG2PDF = 'https://cdn.jsdelivr.net/npm/svg2pdf.js@2.2.4/dist/svg2pdf.umd.min.js';
  // Sora (SIL OFL, assets/fonts/OFL.txt), embutida no PDF.
  const FONTES = { extrabold: '/assets/fonts/Sora-ExtraBold.ttf', semibold: '/assets/fonts/Sora-SemiBold.ttf', light: '/assets/fonts/Sora-Light.ttf' };
  const LOGO_VTX = '/admin/icons/icon-512.png';          // marca quadrada (miolo do QR)
  const LOGO_VTX_TEXTO = '/assets/img/vtx-tap-escuro.png'; // logo com texto (ao lado do @)

  /* Ícone de NFC: círculo com as ondas e o celular chegando perto. */
  const NFC = {
    w: 64, h: 48,
    svg: `<g fill="none" stroke="${TINTA}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="17" cy="19" r="13" stroke="${LILAS}" fill="#F6F1FF"/>
      <path d="M13 13.5a8 8 0 0 1 0 11" stroke="#7D27FC"/><path d="M17.5 10.5a12.5 12.5 0 0 1 0 17" stroke="#7D27FC"/><path d="M9 16a4 4 0 0 1 0 6" stroke="#7D27FC"/>
      <g transform="rotate(14 42 22)"><rect x="32" y="3" width="19" height="36" rx="3.5" fill="#fff"/><path d="M39 6.5h5"/><circle cx="41.5" cy="34.5" r="1.2" fill="${TINTA}" stroke="none"/></g>
      <path d="M43 47c0-4-2-7-4.5-10.5-1.2-1.8.8-3.8 2.6-2.5L46 38V26.5c0-1.6 2.2-2 2.8-.5l6 13c1 2.4 1 5-.2 8" fill="#fff"/>
    </g>`,
  };

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

  // Ícone em vetor no PDF (svg2pdf.js), na posição e no tamanho pedidos.
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

  // QR em vetor: cada sequência de módulos escuros de uma linha vira um retângulo.
  // O miolo 3 × 3 dos três quadrados de canto sai em roxo claro; o meio fica livre para a logo.
  function desenharQr(doc, texto, x, y, lado, livre) {
    if (typeof window.qrcode !== 'function') throw new Error('Gerador de QR indisponível. Confira a internet.');
    const qr = window.qrcode(0, 'H');
    qr.addData(texto);
    qr.make();
    const n = qr.getModuleCount();
    const m = lado / n;
    const cantos = [[0, 0], [0, n - 7], [n - 7, 0]];
    const miolo = (r, c) => cantos.some(([r0, c0]) => r >= r0 + 2 && r <= r0 + 4 && c >= c0 + 2 && c <= c0 + 4);
    // Área do meio reservada para a logo (em módulos), centralizada.
    const k = Math.round(n * livre);
    const ini0 = Math.floor((n - k) / 2);
    const noMeio = (r, c) => r >= ini0 && r < ini0 + k && c >= ini0 && c < ini0 + k;
    const escuro = (r, c) => qr.isDark(r, c) && !miolo(r, c) && !noMeio(r, c);
    doc.setFillColor(TINTA);
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
    doc.setFillColor(LILAS_QR);
    cantos.forEach(([r0, c0]) => doc.rect(x + (c0 + 2) * m, y + (r0 + 2) * m, 3 * m, 3 * m, 'F'));
    return { x: x + ini0 * m, y: y + ini0 * m, lado: k * m };
  }

  function texto(doc, t, x, y, { tamanho, cor = TINTA, espaco = 0, alinhar = 'centro', angulo = 0, peso = 'extrabold' } = {}) {
    doc.setFont('Sora', peso);
    doc.setFontSize(tamanho);
    doc.setTextColor(cor);
    doc.setCharSpace(espaco);
    const w = doc.getTextWidth(t) + espaco * (t.length - 1);
    if (angulo) doc.text(t, x, y, { angle: angulo });
    else doc.text(t, alinhar === 'direita' ? x - w : x - w / 2, y);
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

  /**
   * Gera e baixa o PDF: uma página do tamanho de um cartão de crédito por plaquinha.
   * @param {{codigo: string, url: string, logo?: string}[]} itens  logo: do restaurante (modelo personalizado)
   * @param {string} nomeArquivo
   * @param {{modelo?: 'padrao'|'personalizado'}} opcoes
   */
  async function baixarPdf(itens, nomeArquivo, { modelo = 'padrao' } = {}) {
    if (!itens.length) throw new Error('Nenhuma plaquinha para gerar.');
    if (!window.jspdf) await carregarScript(JSPDF);
    if (!window.svg2pdf) await carregarScript(SVG2PDF);
    const { jsPDF } = window.jspdf;
    const L = PLACA.largura;
    const A = PLACA.altura;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [L, A], compress: true, putOnlyUsedFonts: true });
    doc.setProperties({ title: nomeArquivo.replace(/\.pdf$/, ''), creator: 'Central de plaquinhas', subject: `Cartão ${L} × ${A} mm, cantos com raio de ${PLACA.raio} mm` });

    for (const [peso, url] of Object.entries(FONTES)) {
      const nome = url.split('/').pop();
      doc.addFileToVFS(nome, await fonteBase64(url));
      doc.addFont(nome, 'Sora', peso);
    }
    const vtx = await logoPng(LOGO_VTX);
    const vtxTexto = await logoPng(LOGO_VTX_TEXTO);
    const logos = {};
    if (modelo === 'personalizado') {
      for (const u of new Set(itens.map((it) => it.logo).filter(Boolean))) logos[u] = await logoPng(u);
    }

    // Medidas (mm). A divisória fica no meio exato do cartão; cada metade é centralizada nela.
    const divX = L / 2;
    const qr = 32;                     // lado do QR, centralizado na metade esquerda
    const qrX = (divX - qr) / 2;
    const qrY = (A - qr) / 2;
    const codX = L - 5;                // código em pé na lateral direita (as letras ficam à direita desta linha)
    const dirCx = (divX + L) / 2;      // centro da metade direita: ícone, título e @ alinhados nele
    const nfcW = 25;                   // ícone de NFC, grande e no centro
    const nfcH = (nfcW * NFC.h) / NFC.w;
    const logoH = 3.4;                 // logo da VTX Tap em cima do @ (personalizado)
    // Bloco da direita: ícone, 2,5 de espaço, título (2 linhas), 3 de espaço, [logo + 1,2], @.
    const blocoH = nfcH + 2.5 + 8.4 + 3 + (vtxTexto ? logoH + 1.2 : 0) + 1.9;
    const nfcY = (A - blocoH) / 2;

    for (const [i, it] of itens.entries()) {
      if (i) doc.addPage([L, A], 'landscape');
      // Cartão branco com os cantos arredondados (a faca de corte segue o mesmo raio).
      doc.setFillColor('#FFFFFF');
      doc.roundedRect(0, 0, L, A, PLACA.raio, PLACA.raio, 'F');

      // Esquerda: QR com a logo no meio (padrão: VTX Tap; personalizado: a do restaurante).
      const logoMeio = (modelo === 'personalizado' && it.logo && logos[it.logo]) || vtx;
      const meio = desenharQr(doc, it.url, qrX, qrY, qr, 0.26);
      if (logoMeio) {
        const f = meio.lado * 0.08;
        doc.setFillColor('#FFFFFF');
        doc.roundedRect(meio.x, meio.y, meio.lado, meio.lado, 1, 1, 'F');
        imagemNaCaixa(doc, logoMeio, meio.x + f, meio.y + f, meio.lado - 2 * f, meio.lado - 2 * f, logoMeio === vtx ? 'logo-vtx' : 'logo-' + it.logo);
      }

      // Divisória em roxo claro
      doc.setDrawColor(LILAS);
      doc.setLineWidth(0.6);
      doc.setLineCap('round');
      doc.line(divX, 9, divX, A - 9);

      // Direita: ícone de NFC grande e centralizado, com o título logo embaixo.
      await svgNoPdf(doc, NFC, dirCx - nfcW / 2, nfcY, nfcW, nfcH);
      // Título em duas linhas ("Aproxime" / "o celular").
      const [l1, ...resto] = PLACA.titulo.split(' ');
      const tY = nfcY + nfcH + 2.5;
      texto(doc, l1, dirCx, tY + 3.6, { tamanho: 11.5 });
      texto(doc, resto.join(' '), dirCx, tY + 8.4, { tamanho: 11.5 });

      // Logo da VTX Tap pequena e o @ embaixo, alinhados com o título (nos dois modelos).
      let rodY = tY + 8.4 + 3 + 1.9;
      if (vtxTexto) {
        const w = (vtxTexto.w / vtxTexto.h) * logoH;
        doc.addImage(vtxTexto.url, 'PNG', dirCx - w / 2, tY + 8.4 + 3, w, logoH, 'logo-vtx-texto', 'FAST');
        rodY += logoH + 1.2;
      }
      texto(doc, PLACA.rodape, dirCx, rodY, { tamanho: 5, peso: 'light' });

      // Código em pé na lateral direita, pequeno, lido de cima para baixo.
      doc.setFont('Sora', 'semibold');
      doc.setFontSize(5.5);
      const wc = doc.getTextWidth(it.codigo) + 0.3 * (it.codigo.length - 1);
      texto(doc, it.codigo, codX, (A - wc) / 2, { tamanho: 5.5, cor: COR_CODIGO, espaco: 0.3, angulo: -90, peso: 'semibold' });
    }

    doc.save(nomeArquivo);
  }

  window.Placa = { baixarPdf, PLACA };
})();
