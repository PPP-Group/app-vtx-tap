/*
 * Valor total da NFC-e lido da própria nota impressa (OCR).
 * O QR da nota emitida online não traz o valor e a consulta da SEFAZ-MG é protegida,
 * então lemos o "VALOR A PAGAR" impresso. Quem leu sempre confere antes de enviar.
 * O leitor de texto (tesseract.js) só é baixado na primeira vez que é usado.
 *
 *   OcrNota.valorDoTexto(texto)          → número ou null
 *   OcrNota.lerValor(fonte, largura, altura) → Promise<número ou null>
 *   OcrNota.camera(video, { achou(valor), aviso(texto) }) → função que para a câmera
 */
(function () {
  const BASE = 'https://cdn.jsdelivr.net/npm/';
  const TESS = BASE + 'tesseract.js@5.1.1/dist/tesseract.min.js';
  const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
  // Internet ruim não pode travar a tela: passou do prazo, segue sem o valor (a pessoa digita).
  const comPrazo = (p, ms) => Promise.race([p, espera(ms).then(() => { throw new Error('prazo'); })]);
  const PRAZO_CARGA = 30000;
  const PRAZO_LEITURA = 15000;

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
  const DINHEIRO = /(\d{1,3}(?:[.\s]\d{3})*|\d+)\s?[.,]\s?([\dOo]{2})(?!\d)/g;
  function numeros(linha) {
    const out = [];
    let m;
    DINHEIRO.lastIndex = 0;
    while ((m = DINHEIRO.exec(linha))) {
      const v = +(m[1].replace(/[.\s]/g, '') + '.' + m[2].replace(/[Oo]/g, '0'));
      if (v > 0 && v < 100000) out.push(v);
    }
    return out;
  }
  const semAcento = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const CHAVES = [
    /VALOR\s*A\s*PAGAR/,
    /VALOR\s*PAGO/,
    /VALOR\s*TOTAL(?!\s*D[OE]S?\s*TRIB)/,
    /(^|\s)TOTAL(\s*R\$|\s*GERAL|\s*A\s*PAGAR|\s*:|\s*$|\s+\d)/,
  ];
  const IGNORAR = /ITENS|TRIBUT|DESCONTO|TROCO|IMPOSTO|APROX|LEI\s*12|ACRESC/;
  function valorDoTexto(texto) {
    const linhas = semAcento(String(texto || '')).toUpperCase().split(/\n+/).map((l) => l.trim()).filter(Boolean);
    for (const chave of CHAVES) {
      for (let i = 0; i < linhas.length; i++) {
        const l = linhas[i];
        if (!chave.test(l) || IGNORAR.test(l)) continue;
        const aqui = numeros(l.slice(l.search(chave)));
        if (aqui.length) return aqui[aqui.length - 1];
        const prox = linhas[i + 1] ? numeros(linhas[i + 1]) : [];
        if (prox.length) return prox[prox.length - 1];
      }
    }
    return null;
  }

  /* ---------- Imagem → valor ---------- */
  const tela = document.createElement('canvas');
  // Cinza com contraste: o papel térmico sai claro e o OCR erra menos.
  function preparar(fonte, largura, altura, lado) {
    const k = Math.min(1, lado / Math.max(largura, altura));
    const w = Math.max(1, Math.round(largura * k));
    const h = Math.max(1, Math.round(altura * k));
    tela.width = w;
    tela.height = h;
    const g = tela.getContext('2d', { willReadFrequently: true });
    g.drawImage(fonte, 0, 0, w, h);
    const img = g.getImageData(0, 0, w, h);
    const d = img.data;
    let min = 255;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      d[i] = y;
      if (y < min) min = y;
      if (y > max) max = y;
    }
    const f = max - min > 20 ? 255 / (max - min) : 1;
    for (let i = 0; i < d.length; i += 4) {
      const y = Math.max(0, Math.min(255, (d[i] - min) * f));
      d[i] = d[i + 1] = d[i + 2] = y;
    }
    g.putImageData(img, 0, 0);
    return tela;
  }
  async function lerTexto(fonte, largura, altura, lado = 1600) {
    const w = await comPrazo(leitor(), PRAZO_CARGA);
    const r = await comPrazo(w.recognize(preparar(fonte, largura, altura, lado)), PRAZO_LEITURA);
    return (r && r.data && r.data.text) || '';
  }
  async function lerValor(fonte, largura, altura) {
    try {
      return valorDoTexto(await lerTexto(fonte, largura, altura));
    } catch {
      return null;
    }
  }

  /* ---------- Câmera apontada para o total ---------- */
  // Lê quadros seguidos e só aceita o valor quando ele aparece igual duas vezes.
  function camera(video, { achou, aviso } = {}) {
    let parado = false;
    let stream = null;
    const parar = () => {
      parado = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
      video.srcObject = null;
    };
    (async () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return aviso && aviso('sem-camera');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        if (parado) return parar();
        video.srcObject = stream;
        await video.play();
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
        if (video.readyState >= 2 && video.videoWidth) {
          const v = await lerValor(video, video.videoWidth, video.videoHeight);
          if (parado) break;
          if (v && v === ultimo) {
            parar();
            return achou && achou(v);
          }
          ultimo = v;
        }
        await espera(150);
      }
    })();
    return parar;
  }

  // Deixa o leitor de texto baixando enquanto a pessoa ainda enquadra o QR.
  const preaquecer = () => leitor().catch(() => {});

  window.OcrNota = { valorDoTexto, lerValor, camera, preaquecer };
})();
