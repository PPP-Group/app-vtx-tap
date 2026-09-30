/*
 * Valor total da NFC-e lido da própria nota impressa (OCR).
 * O QR da nota emitida online não traz o valor e a consulta da SEFAZ-MG é protegida,
 * então lemos o total impresso. Quem leu sempre confere antes de enviar.
 * O leitor de texto (tesseract.js) só é baixado na primeira vez que é usado.
 *
 * Como lê: acha o papel na foto (o maior bloco claro), recorta, amplia e passa para preto e branco
 * com limiar local (sombra e flash não atrapalham). Junta os valores das linhas de total
 * ("VALOR TOTAL", "VALOR A PAGAR"), do valor líquido e da forma de pagamento ("Cartão de Crédito 7,70")
 * e fica com o que aparece mais vezes.
 *
 *   OcrNota.valorDoTexto(texto)                → número ou null
 *   OcrNota.lerValor(fonte, largura, altura)   → Promise<número ou null>   (uma leitura, rápida)
 *   OcrNota.lerFoto(fonte, { progresso(n, de) }) → Promise<número ou null> (várias leituras, para foto)
 *   OcrNota.camera(video, { achou(valor), aviso(texto) }) → função que para a câmera, com
 *     .capturar() → Promise<número ou null> (lê o quadro atual com calma) e
 *     .lanterna(ligar) → Promise<boolean> (false quando o aparelho não tem)
 *   OcrNota.abrirFoto(arquivo)                  → Promise<img> (arquivo do <input type=file>)
 */
(function () {
  const BASE = 'https://cdn.jsdelivr.net/npm/';
  const TESS = BASE + 'tesseract.js@5.1.1/dist/tesseract.min.js';
  const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
  // Internet ruim não pode travar a tela: passou do prazo, segue sem o valor (a pessoa digita).
  const comPrazo = (p, ms) => Promise.race([p, espera(ms).then(() => { throw new Error('prazo'); })]);
  const PRAZO_CARGA = 30000;
  const PRAZO_LEITURA = 20000;

  let wk = null;
  function leitor() {
    if (!wk) {
      wk = new Promise((ok, fail) => {
        const iniciar = async () => {
          try {
            const w = await window.Tesseract.createWorker('por', 1, {
              workerPath: BASE + 'tesseract.js@5.1.1/dist/worker.min.js',
              corePath: BASE + 'tesseract.js-core@5.1.1',
              langPath: BASE + '@tesseract.js-data/por/4.0.0_best_int',
            });
            ok(w);
          } catch (e) {
            wk = null;
            fail(e);
          }
        };
        if (window.Tesseract) return iniciar();
        const s = document.createElement('script');
        s.src = TESS;
        s.onload = iniciar;
        s.onerror = () => {
          wk = null;
          fail(new Error('Não foi possível carregar o leitor de texto.'));
        };
        document.head.appendChild(s);
      });
    }
    return wk;
  }

  /* ---------- Texto → valor ---------- */
  // Dinheiro como aparece na nota: 87,50 · 1.234,56 · 87.50 (com os erros comuns do OCR: O no lugar de 0).
  // Três casas depois da vírgula ("7,710") é sujeira do OCR: vale as duas primeiras.
  const DINHEIRO = /(\d{1,3}(?:[.\s]\d{3})*|\d+)\s?[.,]\s?([\dOo]{2})([\dOo])?(?![\dOo])/g;
  function numeros(linha) {
    const out = [];
    let m;
    DINHEIRO.lastIndex = 0;
    while ((m = DINHEIRO.exec(linha))) {
      const v = +(m[1].replace(/[.\s]/g, '') + '.' + m[2].replace(/[Oo]/g, '0'));
      // suja: veio com uma casa a mais ("7,710"); conta menos na votação.
      if (v > 0 && v < 100000) out.push({ v, suja: !!m[3] });
    }
    return out;
  }
  const semAcento = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Linha do total, do mais confiável para o menos. O começo pode vir cortado pelo OCR ("ALOR TOTAL").
  const TOTAIS = [
    [/VAL[OU0]R\s*A\s*PAGAR|A\s*PAGAR\s*R/, 4],
    [/VAL[OU0]R\s*T[O0]TAL(?!\s*D[OE]S?\s*TRIB)|(^|\s)[A-Z]{0,4}\s*T[O0]TAL\s*R\s?\$/, 3],
    [/VAL[OU0]R\s*PAG[O0]|(^|\s)T[O0]TAL(\s*GERAL|\s*:|\s*$|\s+\d)/, 2],
  ];
  // Forma de pagamento com o valor na mesma linha e o valor líquido: confirmam o total.
  const PAGAMENTO = /CART[A-Z]{0,2}\s*(DE)?\s*(CRED|DEB)|CREDITO|DEBITO|DINHEIRO|(^|\s)PIX(\s|$)|VALE\s*(REF|ALIM)|VAL[OU0]R\s*L[I1T]Q/;
  const IGNORAR = /ITENS|TRIBUT|DESCONTO|TROCO|IMPOSTO|APROX|LEI\s*12|ACRESC|SUBT[O0]TAL|UNIT|QTDE|FONTE/;
  function candidatos(texto) {
    const linhas = semAcento(String(texto || '')).toUpperCase().split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const out = [];
    linhas.forEach((l, i) => {
      if (IGNORAR.test(l)) return;
      for (const [chave, peso] of TOTAIS) {
        const m = l.match(chave);
        if (!m) continue;
        let n = numeros(l.slice(m.index)).pop();
        // Número na linha de baixo (letra grande ou coluna da direita quebrada pelo OCR).
        for (let k = 1; !n && k <= 2 && linhas[i + k]; k++) {
          if (!IGNORAR.test(linhas[i + k])) n = numeros(linhas[i + k]).pop();
        }
        if (n) out.push({ v: n.v, peso: n.suja ? 1 : peso, n: n.suja ? 0.5 : 1 });
        return;
      }
      if (PAGAMENTO.test(l)) {
        const n = numeros(l).pop();
        if (n) out.push({ v: n.v, peso: 1, n: n.suja ? 0.5 : 1 });
      }
    });
    return out;
  }
  // Ganha o valor que aparece em mais linhas (o OCR raramente erra igual duas vezes); no empate, o da linha
  // mais confiável ("VALOR A PAGAR" > "VALOR TOTAL" > forma de pagamento). Nota paga com dois cartões: fica o total.
  function melhor(cands) {
    if (!cands.length) return null;
    const por = new Map();
    for (const c of cands) {
      const x = por.get(c.v) || { n: 0, peso: 0 };
      x.n += c.n;
      x.peso = Math.max(x.peso, c.peso);
      por.set(c.v, x);
    }
    const [v, x] = [...por.entries()].sort((a, b) => b[1].n - a[1].n || b[1].peso - a[1].peso || b[0] - a[0])[0];
    return { valor: v, confirmado: x.n >= 2 || x.peso >= 4 };
  }
  const valorDoTexto = (texto) => {
    const m = melhor(candidatos(texto));
    return m ? m.valor : null;
  };

  /* ---------- Imagem ---------- */
  // Acha o papel: o bloco claro da foto (a nota) sem a mão, a mesa e o fundo.
  const mini = document.createElement('canvas');
  function recortePapel(fonte, largura, altura) {
    const k = 300 / Math.max(largura, altura);
    const W = Math.max(1, Math.round(largura * k));
    const H = Math.max(1, Math.round(altura * k));
    mini.width = W;
    mini.height = H;
    const g = mini.getContext('2d', { willReadFrequently: true });
    g.drawImage(fonte, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const lum = new Float32Array(W * H);
    let soma = 0;
    for (let i = 0; i < W * H; i++) {
      lum[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
      soma += lum[i];
    }
    const lim = Math.max(150, soma / (W * H) + 25);
    const col = new Array(W).fill(0);
    const lin = new Array(H).fill(0);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (lum[y * W + x] > lim) { col[x]++; lin[y]++; }
    const faixa = (v, total, t) => {
      const a = v.findIndex((q) => q / total > t);
      if (a < 0) return null;
      let b = v.length - 1;
      while (b > a && v[b] / total <= t) b--;
      return [a, b];
    };
    const cx = faixa(col, H, 0.35);
    const cy = faixa(lin, W, 0.15);
    // Nota ocupando quase nada da imagem (ou a imagem toda): usa a imagem inteira.
    if (!cx || !cy || (cx[1] - cx[0]) < W * 0.15 || (cy[1] - cy[0]) < H * 0.15) return { x: 0, y: 0, w: largura, h: altura };
    const m = 2; // pequena folga para não cortar a borda do texto
    const x0 = Math.max(0, cx[0] - m), x1 = Math.min(W - 1, cx[1] + m);
    const y0 = Math.max(0, cy[0] - m), y1 = Math.min(H - 1, cy[1] + m);
    return { x: x0 / k, y: y0 / k, w: (x1 - x0 + 1) / k, h: (y1 - y0 + 1) / k };
  }

  // Recorte do papel, na largura pedida, em cinza com contraste ('cinza') ou preto e branco com limiar local ('pb').
  function preparar(fonte, largura, altura, { alvo = 1400, modo = 'pb', recorte = null } = {}) {
    const r = recorte || recortePapel(fonte, largura, altura);
    const k = Math.min(3, alvo / r.w);
    const W = Math.max(1, Math.round(r.w * k));
    const H = Math.max(1, Math.round(r.h * k));
    const tela = document.createElement('canvas'); // uma por leitura: a câmera e a captura podem ler juntas
    tela.width = W;
    tela.height = H;
    const g = tela.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(fonte, r.x, r.y, r.w, r.h, 0, 0, W, H);
    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    const y = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) y[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
    if (modo === 'pb') {
      // Limiar local (média da vizinhança): papel térmico claro, sombra da mão e reflexo do flash.
      const S = new Float64Array((W + 1) * (H + 1));
      for (let yy = 0; yy < H; yy++) {
        let s = 0;
        for (let x = 0; x < W; x++) {
          s += y[yy * W + x];
          S[(yy + 1) * (W + 1) + x + 1] = S[yy * (W + 1) + x + 1] + s;
        }
      }
      const raio = Math.max(8, Math.round(W / 30));
      for (let yy = 0; yy < H; yy++) {
        const y0 = Math.max(0, yy - raio), y1 = Math.min(H, yy + raio + 1);
        for (let x = 0; x < W; x++) {
          const x0 = Math.max(0, x - raio), x1 = Math.min(W, x + raio + 1);
          const media = (S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
          const v = y[yy * W + x] < media * 0.82 ? 0 : 255;
          const o = (yy * W + x) * 4;
          d[o] = d[o + 1] = d[o + 2] = v;
        }
      }
    } else {
      let min = 255;
      let max = 0;
      for (const v of y) { if (v < min) min = v; if (v > max) max = v; }
      const f = max - min > 20 ? 255 / (max - min) : 1;
      for (let i = 0; i < W * H; i++) d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = Math.max(0, Math.min(255, (y[i] - min) * f));
    }
    g.putImageData(img, 0, 0);
    return tela;
  }
  async function lerTexto(fonte, largura, altura, opcoes = {}) {
    const w = await comPrazo(leitor(), PRAZO_CARGA);
    await w.setParameters({ tessedit_pageseg_mode: opcoes.psm || '4' });
    const r = await comPrazo(w.recognize(preparar(fonte, largura, altura, opcoes)), PRAZO_LEITURA);
    return (r && r.data && r.data.text) || '';
  }
  const tamanho = (f) => [f.naturalWidth || f.videoWidth || f.width, f.naturalHeight || f.videoHeight || f.height];

  // Uma leitura (a imagem em que o QR foi achado, ou um quadro da câmera).
  async function lerValor(fonte, largura, altura) {
    try {
      return valorDoTexto(await lerTexto(fonte, largura, altura, { alvo: 1400, modo: 'pb' }));
    } catch {
      return null;
    }
  }

  // Foto tirada com calma: várias leituras (tamanhos e modos diferentes) somando os candidatos.
  const TENTATIVAS = [
    { alvo: 1400, modo: 'pb', psm: '4' },
    { alvo: 1800, modo: 'pb', psm: '4' },
    { alvo: 1800, modo: 'pb', psm: '6' },
    { alvo: 1400, modo: 'cinza', psm: '4' },
  ];
  async function lerFoto(fonte, { progresso } = {}) {
    const [largura, altura] = tamanho(fonte);
    const recorte = recortePapel(fonte, largura, altura);
    const cands = [];
    for (let i = 0; i < TENTATIVAS.length; i++) {
      progresso && progresso(i + 1, TENTATIVAS.length);
      try {
        cands.push(...candidatos(await lerTexto(fonte, largura, altura, { ...TENTATIVAS[i], recorte })));
      } catch (e) {
        if (!cands.length && i === 0) return null; // o leitor nem carregou
      }
      const m = melhor(cands);
      if (m && m.confirmado) return m.valor;
    }
    const m = melhor(cands);
    return m ? m.valor : null;
  }

  /* ---------- Câmera apontada para o total ---------- */
  // Lê quadros seguidos; aceita o valor confirmado num quadro ou igual em dois quadros.
  function camera(video, { achou, aviso } = {}) {
    let parado = false;
    let stream = null;
    let pausa = false;
    const parar = () => {
      parado = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
      video.srcObject = null;
    };
    // Lê o quadro atual com calma (várias leituras), a partir de uma cópia na resolução da câmera.
    parar.capturar = async () => {
      if (!video.videoWidth) return null;
      pausa = true;
      const c = document.createElement('canvas');
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      try {
        return await lerFoto(c);
      } finally {
        pausa = false;
      }
    };
    parar.lanterna = async (ligar) => {
      const t = stream && stream.getVideoTracks()[0];
      const pode = t && t.getCapabilities && t.getCapabilities().torch;
      if (!pode) return false;
      try {
        await t.applyConstraints({ advanced: [{ torch: !!ligar }] });
        return true;
      } catch {
        return false;
      }
    };
    parar.temLanterna = () => {
      const t = stream && stream.getVideoTracks()[0];
      return !!(t && t.getCapabilities && t.getCapabilities().torch);
    };
    (async () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return aviso && aviso('sem-camera');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        if (parado) return parar();
        video.srcObject = stream;
        await video.play();
        // Foco contínuo quando o aparelho deixa (papel perto da câmera).
        const t = stream.getVideoTracks()[0];
        const cap = t.getCapabilities ? t.getCapabilities() : {};
        if (cap.focusMode && cap.focusMode.includes('continuous')) t.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
        aviso && aviso('camera');
      } catch {
        parar();
        return aviso && aviso('sem-camera');
      }
      aviso && aviso('carregando');
      try {
        await comPrazo(leitor(), PRAZO_CARGA);
      } catch {
        parar();
        return aviso && aviso('sem-ocr');
      }
      aviso && aviso('lendo');
      let ultimo = null;
      while (!parado) {
        if (!pausa && video.readyState >= 2 && video.videoWidth) {
          let m = null;
          try {
            m = melhor(candidatos(await lerTexto(video, video.videoWidth, video.videoHeight, { alvo: 1200, modo: 'pb' })));
          } catch {}
          if (parado) break;
          if (m && !pausa && (m.confirmado || m.valor === ultimo)) {
            parar();
            return achou && achou(m.valor);
          }
          ultimo = m ? m.valor : null;
        }
        await espera(150);
      }
    })();
    return parar;
  }

  // Abre a foto escolhida/tirada (a orientação do celular já vem aplicada pelo navegador).
  function abrirFoto(arquivo) {
    return new Promise((ok, falha) => {
      const url = URL.createObjectURL(arquivo);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); ok(img); };
      img.onerror = () => { URL.revokeObjectURL(url); falha(new Error('foto')); };
      img.src = url;
    });
  }

  // Deixa o leitor de texto baixando enquanto a pessoa ainda enquadra o QR.
  const preaquecer = () => leitor().catch(() => {});

  window.OcrNota = { valorDoTexto, lerValor, lerFoto, camera, abrirFoto, preaquecer };
})();
