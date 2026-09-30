/*
 * Leitor do QR Code da nota fiscal (NFC-e): câmera, foto da nota ou chave de
 * acesso digitada. Usa o leitor do próprio aparelho (BarcodeDetector) quando
 * existe; no iPhone e onde ele não existe, o zxing-wasm, carregado só na hora.
 * O QR da nota térmica é pequeno e às vezes borrado: a foto é lida em vários tamanhos.
 *
 *   Leitor.abrir({ titulo, dica, aceitar(texto) → mensagem de erro ou null, pronto(texto, { quadro }), valor })
 *   `quadro` é a imagem em que o QR foi achado (a foto ou o quadro da câmera), para ler o valor da nota.
 *   Com `valor: true`, o leitor de texto da nota (OcrNota) já começa a baixar enquanto a pessoa enquadra.
 */
(function () {
  const { icon } = UI;
  const ZXING = 'https://cdn.jsdelivr.net/npm/zxing-wasm@2.2.4/dist/iife/reader/index.js';
  const WASM = 'https://cdn.jsdelivr.net/npm/zxing-wasm@2.2.4/dist/reader/zxing_reader.wasm';
  const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));

  let zx = null;
  function zxing() {
    if (!zx) {
      zx = new Promise((ok, fail) => {
        const s = document.createElement('script');
        s.src = ZXING;
        s.onload = () => {
          const Z = window.ZXingWASM;
          Z.prepareZXingModule({ overrides: { locateFile: (p, pre) => (p.endsWith('.wasm') ? WASM : pre + p) }, fireImmediately: true });
          ok(Z);
        };
        s.onerror = () => {
          zx = null;
          fail(new Error('Não foi possível carregar o leitor de QR. Confira a internet.'));
        };
        document.head.appendChild(s);
      });
    }
    return zx;
  }

  let nativo;
  async function detectorNativo() {
    if (nativo === undefined) {
      nativo = null;
      try {
        if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
          nativo = new BarcodeDetector({ formats: ['qr_code'] });
        }
      } catch {}
    }
    return nativo;
  }

  // Lê o QR de um vídeo ou imagem, redesenhado com no máximo `lado` px no maior lado.
  // Câmera e foto usam telas separadas: a foto pode ser lida enquanto a câmera ainda procura.
  const tela = document.createElement('canvas');
  const telaFoto = document.createElement('canvas');
  async function lerDe(fonte, largura, altura, lado, c = tela) {
    const k = Math.min(1, lado / Math.max(largura, altura));
    const w = Math.max(1, Math.round(largura * k));
    const h = Math.max(1, Math.round(altura * k));
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(fonte, 0, 0, w, h);
    const d = await detectorNativo();
    if (d) {
      const r = await d.detect(c);
      return r.length ? r[0].rawValue : null;
    }
    const Z = await zxing();
    const r = await Z.readBarcodes(g.getImageData(0, 0, w, h), { formats: ['QRCode'], tryHarder: true, maxNumberOfSymbols: 1 });
    return r.length && r[0].isValid !== false ? r[0].text : null;
  }

  const abrirImagem = (arquivo) =>
    new Promise((ok, fail) => {
      const url = URL.createObjectURL(arquivo);
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => fail(new Error('Não foi possível abrir a foto.'));
      img.src = url;
    });

  async function lerFoto(arquivo, comImagem = false) {
    const img = await abrirImagem(arquivo);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    for (const lado of [1100, 1500, 800, 2000, 650, 2600]) {
      const t = await lerDe(img, w, h, lado, telaFoto).catch(() => null);
      if (t) return comImagem ? { texto: t, img } : t;
    }
    return null;
  }
  // Cópia do quadro atual da câmera (o vídeo para logo depois).
  function copiaDoVideo() {
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    return c;
  }

  /* ---------- A folha do leitor ---------- */
  let el;
  let video;
  let stream = null;
  let laco = 0;
  let aberto = false;
  let opcoes = {};

  function montar() {
    if (el) return;
    el = document.createElement('div');
    el.className = 'sheet leitor';
    el.id = 'sh-leitor';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'leitorTitulo');
    el.innerHTML = `<div class="sheet-backdrop" data-close></div>
      <div class="sheet-panel" tabindex="-1">
        <div class="sheet-grip"></div>
        <header class="sheet-head"><h2 id="leitorTitulo"></h2><button class="icon-btn" type="button" data-close aria-label="Fechar">${icon('x')}</button></header>
        <div class="sheet-body leitor-body">
          <div class="leitor-cam"><video playsinline muted></video><span class="leitor-mira" aria-hidden="true"></span></div>
          <p class="leitor-msg" aria-live="polite"></p>
          <div class="leitor-acts">
            <label class="btn btn-line">${icon('camera')} Tirar foto da nota<input type="file" accept="image/*" capture="environment" class="sr-only" data-leitor-foto></label>
            <button type="button" class="btn btn-quiet" data-leitor-digitar>Digitar a chave de acesso</button>
          </div>
          <form class="leitor-dig stack" hidden novalidate>
            <label class="field"><span>Chave de acesso: os 44 números embaixo do QR Code</span>
              <textarea class="input mono" rows="2" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000"></textarea></label>
            <button type="submit" class="btn btn-cobalt btn-block">Continuar</button>
          </form>
        </div>
      </div>`;
    document.body.appendChild(el);
    video = el.querySelector('video');
    el.addEventListener('sheet:close', () => {
      aberto = false;
      parar();
    });
    el.querySelector('[data-leitor-foto]').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      msg('Lendo a foto…');
      try {
        const r = await lerFoto(f, true);
        if (!r) return msg('Não achamos o QR na foto. Tire outra mais de perto, sem sombra e com a nota esticada, ou digite a chave.', true);
        achou(r.texto, r.img);
      } catch (ex) {
        msg(ex.message || 'Não foi possível ler a foto.', true);
      }
    });
    el.querySelector('[data-leitor-digitar]').addEventListener('click', () => {
      const f = el.querySelector('.leitor-dig');
      f.hidden = !f.hidden;
      if (!f.hidden) setTimeout(() => f.querySelector('textarea').focus(), 50);
    });
    el.querySelector('.leitor-dig').addEventListener('submit', (e) => {
      e.preventDefault();
      const d = e.target.querySelector('textarea').value.replace(/\D/g, '');
      if (d.length !== 44) return msg(`A chave tem 44 números (você digitou ${d.length}).`, true);
      achou(d);
    });
  }

  function msg(texto, erro = false) {
    const p = el.querySelector('.leitor-msg');
    p.textContent = texto;
    p.classList.toggle('is-erro', erro);
  }

  function achou(texto, quadro = null) {
    const erro = opcoes.aceitar ? opcoes.aceitar(texto) : null;
    if (erro) {
      msg(erro, true);
      return false;
    }
    navigator.vibrate && navigator.vibrate(40);
    parar();
    const pronto = opcoes.pronto;
    UI.closeSheet();
    setTimeout(() => pronto && pronto(texto, { quadro }), 380);
    return true;
  }

  async function ligarCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return msg('A câmera não abre neste navegador. Tire uma foto da nota ou digite a chave.', true);
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (!aberto) return parar();
      video.srcObject = stream;
      await Promise.race([video.play(), espera(6000).then(() => { throw new Error('tempo'); })]);
    } catch (e) {
      parar();
      return msg(e && e.name === 'NotAllowedError'
        ? 'Permita o uso da câmera, ou tire uma foto da nota.'
        : 'A câmera não abriu. Tire uma foto da nota ou digite a chave.', true);
    }
    el.classList.add('com-camera');
    // Deixa o leitor pronto enquanto a pessoa enquadra a nota.
    detectorNativo().then((d) => d || zxing().catch(() => {}));
    ler();
  }

  async function ler() {
    if (!aberto || !stream) return;
    if (video.readyState >= 2 && video.videoWidth) {
      try {
        const d = await detectorNativo();
        let t = null;
        if (d) {
          const r = await d.detect(video);
          t = r.length ? r[0].rawValue : null;
        } else {
          t = await lerDe(video, video.videoWidth, video.videoHeight, 1000);
        }
        if (t && achou(t, copiaDoVideo())) return;
      } catch {}
    }
    laco = setTimeout(ler, 180);
  }

  function parar() {
    clearTimeout(laco);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (video) video.srcObject = null;
    if (el) el.classList.remove('com-camera');
  }

  function abrir(o = {}) {
    montar();
    opcoes = o;
    el.querySelector('#leitorTitulo').textContent = o.titulo || 'Ler QR Code';
    el.querySelector('.leitor-dig').hidden = true;
    el.querySelector('textarea').value = '';
    msg(o.dica || 'Aponte a câmera para o QR Code.');
    aberto = true;
    if (o.valor && window.OcrNota) OcrNota.preaquecer();
    UI.openSheet(el);
    ligarCamera();
  }

  window.Leitor = { abrir, lerFoto };
})();
