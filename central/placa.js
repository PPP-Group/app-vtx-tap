/*
 * PDF das plaquinhas para a gráfica: uma plaquinha por página, 120 × 60 mm.
 * Layout do template: QR com o código único em cima e o @ embaixo, à
 * esquerda; divisória; "Aproxime o celular" com o ícone de NFC e os quatro
 * serviços (Cardápio, Wi-Fi, Avalie, Chamar atendente) à direita.
 * O QR sai em vetor (nítido em qualquer impressão); os ícones em PNG de alta
 * resolução, embutidos uma vez só no arquivo.
 */
(function () {
  // Textos da plaquinha. Troque aqui para mudar em todas as próximas.
  const PLACA = {
    largura: 120,
    altura: 60,
    rodape: '@vortexsoftwareco',
    titulo: 'Aproxime o celular',
    servicos: ['Cardápio', 'Wi-Fi', 'Avalie', 'Chamar atendente'],
  };
  const TINTA = '#1C2733';
  const CINZA = '#9AA3AF';
  const DIVISORIA = '#B8BFCA';
  const JSPDF = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js';

  /* Ícones (SVG próprio, traço no estilo do template). */
  const estrela = (cx, cy, r) => {
    const p = [];
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 ? r * 0.45 : r;
      p.push(`${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`);
    }
    return p.join(' ');
  };
  const arco = (r) => {
    const s = Math.sin((50 * Math.PI) / 180) * r;
    const c = Math.cos((50 * Math.PI) / 180) * r;
    return `M${(24 - s).toFixed(2)} ${(42 - c).toFixed(2)} A${r} ${r} 0 0 1 ${(24 + s).toFixed(2)} ${(42 - c).toFixed(2)}`;
  };
  const ICONES = {
    nfc: {
      w: 64, h: 48,
      svg: `<g fill="none" stroke="${TINTA}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="17" cy="19" r="13"/>
        <path d="M13 13.5a8 8 0 0 1 0 11" stroke="${CINZA}"/><path d="M17.5 10.5a12.5 12.5 0 0 1 0 17" stroke="${CINZA}"/><path d="M9 16a4 4 0 0 1 0 6" stroke="${CINZA}"/>
        <g transform="rotate(14 42 22)"><rect x="32" y="3" width="19" height="36" rx="3.5" fill="#fff"/><path d="M39 6.5h5"/><circle cx="41.5" cy="34.5" r="1.2" fill="${TINTA}" stroke="none"/></g>
        <path d="M43 47c0-4-2-7-4.5-10.5-1.2-1.8.8-3.8 2.6-2.5L46 38V26.5c0-1.6 2.2-2 2.8-.5l6 13c1 2.4 1 5-.2 8" fill="#fff"/>
      </g>`,
    },
    cardapio: {
      w: 48, h: 48,
      svg: `<g fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 11c7-2 14-1.5 20 2.5 6-4 13-4.5 20-2.5v26c-7-2-14-1.5-20 2.5-6-4-13-4.5-20-2.5z" stroke="${TINTA}" stroke-width="3"/>
        <path d="M24 13.5v26" stroke="${TINTA}" stroke-width="3"/>
        <path d="M29 20h9M29 26h9M29 32h7" stroke="${CINZA}" stroke-width="2.6"/>
      </g>`,
    },
    wifi: {
      w: 48, h: 48,
      svg: `<g fill="none" stroke="${TINTA}" stroke-width="4" stroke-linecap="round">
        <path d="${arco(26)}"/><path d="${arco(17)}"/><path d="${arco(8.5)}"/></g>
        <circle cx="24" cy="42" r="3" fill="${CINZA}"/>`,
    },
    avalie: {
      w: 48, h: 48,
      svg: `<path d="M10 7h28a6 6 0 0 1 6 6v17a6 6 0 0 1-6 6H19l-9 7.5V36a6 6 0 0 1-6-6V13a6 6 0 0 1 6-6z" fill="none" stroke="${TINTA}" stroke-width="3" stroke-linejoin="round"/>
        <polygon points="${estrela(24, 21.5, 8.5)}" fill="${CINZA}"/>`,
    },
    sino: {
      w: 48, h: 48,
      svg: `<g stroke="${CINZA}" stroke-width="2.6" stroke-linecap="round"><path d="M24 4v6M13 8l3.5 4.5M35 8l-3.5 4.5"/></g>
        <rect x="21" y="16" width="6" height="3" rx="1.2" fill="${TINTA}"/><rect x="23" y="18" width="2" height="4" fill="${TINTA}"/>
        <path d="M9.5 36a14.5 14.5 0 0 1 29 0z" fill="${TINTA}"/>
        <rect x="5" y="37.5" width="38" height="5.5" rx="1.6" fill="${TINTA}"/>`,
    },
  };

  const carregarScript = (src) =>
    new Promise((ok, falha) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = ok;
      s.onerror = () => falha(new Error('Não foi possível carregar o gerador de PDF. Confira a internet.'));
      document.head.appendChild(s);
    });

  // SVG → PNG em alta resolução (cerca de 1200 dpi no tamanho impresso).
  const png = ({ w, h, svg }, px = 640) =>
    new Promise((ok, falha) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = px;
        c.height = Math.round((px * h) / w);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        ok(c.toDataURL('image/png'));
      };
      img.onerror = () => falha(new Error('Falha ao preparar os ícones da plaquinha.'));
      const doc = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${svg}</svg>`;
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(doc);
    });

  // QR em vetor: cada sequência de módulos escuros de uma linha vira um retângulo.
  function desenharQr(doc, texto, x, y, lado) {
    if (typeof window.qrcode !== 'function') throw new Error('Gerador de QR indisponível. Confira a internet.');
    const qr = window.qrcode(0, 'M');
    qr.addData(texto);
    qr.make();
    const n = qr.getModuleCount();
    const m = lado / n;
    doc.setFillColor(TINTA);
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (!qr.isDark(r, c)) { c++; continue; }
        const ini = c;
        while (c < n && qr.isDark(r, c)) c++;
        // Leve sobreposição para não aparecer fresta entre as linhas.
        doc.rect(x + ini * m, y + r * m, (c - ini) * m + 0.01, m + 0.02, 'F');
      }
    }
  }

  function texto(doc, t, x, y, { tamanho, cor = TINTA, espaco = 0 } = {}) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(tamanho);
    doc.setTextColor(cor);
    doc.setCharSpace(espaco);
    const w = doc.getTextWidth(t) + espaco * (t.length - 1);
    doc.text(t, x - w / 2, y);
    doc.setCharSpace(0);
    return w;
  }

  /**
   * Gera e baixa o PDF: uma página de 120 × 60 mm por plaquinha.
   * @param {{codigo: string, url: string}[]} itens
   * @param {string} nomeArquivo
   */
  async function baixarPdf(itens, nomeArquivo) {
    if (!itens.length) throw new Error('Nenhuma plaquinha para gerar.');
    if (!window.jspdf) await carregarScript(JSPDF);
    const { jsPDF } = window.jspdf;
    const L = PLACA.largura;
    const A = PLACA.altura;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [L, A], compress: true });
    doc.setProperties({ title: nomeArquivo.replace(/\.pdf$/, ''), creator: 'Central de plaquinhas' });

    const icones = {};
    for (const [k, v] of Object.entries(ICONES)) icones[k] = await png(v);
    const servicos = ['cardapio', 'wifi', 'avalie', 'sino'];

    // Medidas (mm)
    const colQr = 22;            // centro da coluna do QR
    const qr = 30;               // lado do QR
    const qrY = 14;
    const divX = 43;
    const dirIni = divX + 3;
    const dirFim = L - 2;
    const dirCx = (divX + L) / 2;
    const colW = (dirFim - dirIni) / servicos.length;
    const ic = 9.5;              // lado dos ícones de serviço

    itens.forEach((it, i) => {
      if (i) doc.addPage([L, A], 'landscape');
      doc.setFillColor('#FFFFFF');
      doc.rect(0, 0, L, A, 'F');

      // Esquerda: código, QR e @
      texto(doc, it.codigo, colQr, qrY - 2.2, { tamanho: 10, espaco: 0.35 });
      desenharQr(doc, it.url, colQr - qr / 2, qrY, qr);
      texto(doc, PLACA.rodape, colQr, qrY + qr + 6.5, { tamanho: 8.5 });

      // Divisória
      doc.setDrawColor(DIVISORIA);
      doc.setLineWidth(0.7);
      doc.setLineCap('round');
      doc.line(divX, 12, divX, A - 12);

      // Direita: NFC, título e serviços
      const nfcW = 17;
      const nfcH = (nfcW * ICONES.nfc.h) / ICONES.nfc.w;
      doc.addImage(icones.nfc, 'PNG', dirCx - nfcW / 2, 6.5, nfcW, nfcH, 'ic-nfc', 'FAST');
      texto(doc, PLACA.titulo, dirCx, 28, { tamanho: 14 });

      servicos.forEach((k, j) => {
        const cx = dirIni + colW * (j + 0.5);
        doc.addImage(icones[k], 'PNG', cx - ic / 2, 33, ic, ic, 'ic-' + k, 'FAST');
        const rot = PLACA.servicos[j];
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.5);
        if (doc.getTextWidth(rot) <= colW - 1) {
          texto(doc, rot, cx, 48.5, { tamanho: 7.5 });
        } else {
          // Rótulo longo ("Chamar atendente") quebra em duas linhas.
          const partes = rot.split(' ');
          const meio = Math.ceil(partes.length / 2);
          texto(doc, partes.slice(0, meio).join(' '), cx, 47.3, { tamanho: 7.5 });
          texto(doc, partes.slice(meio).join(' '), cx, 50.3, { tamanho: 7.5 });
        }
      });
    });

    doc.save(nomeArquivo);
  }

  window.Placa = { baixarPdf, PLACA };
})();
