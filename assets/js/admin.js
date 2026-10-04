/* Painel da equipe — recebe os chamados das mesas em tempo real. */
(function () {
  const cfg = window.NFC_CONFIG;
  const { $, $$, esc, brl, pad, icon, toast, clock, ago, hhmm, secondsSince, openSheet, closeSheet,
    instagramHandle, initials, safeUrl } = UI;
  const store = Store.create();
  const isDemo = store.mode === 'local';

  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const set = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
  const uid = () => (crypto.randomUUID && crypto.randomUUID()) || Date.now().toString(36) + Math.random().toString(36).slice(2);

  const S = {
    user: null,
    settings: Store.padrao(isDemo),
    widgetEdit: null,
    itemEdit: null,
    ajTab: 'restaurante',
    loginModo: 'entrar',
    view: 'salao',
    filtro: 'abertos',
    fbFiltro: 'todos',
    calls: [],
    fb: [],
    sessoes: [],
    mesasAbertas: [],
    etiquetas: [],
    seen: new Set(),
    seenFb: new Set(),
    seenSess: new Set(),
    // Plaquinha nova lida pela equipe (/admin/?vincular=CODIGO).
    vincular: (new URLSearchParams(location.search).get('vincular') || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || null,
    // QR do garçom da Prorrogação (/admin/?chopp=1): soma 1 chopp no relógio.
    chopp: new URLSearchParams(location.search).get('chopp') === '1',
    fresh: new Map(),
    ready: false,
    online: true,
    mesaAberta: null,
    som: get('nfc-som') !== '0',
    lembrete: get('nfc-lembrete') !== '0',
    telaLigada: get('nfc-tela') === '1',
  };

  const VIEWS = [
    { id: 'salao', label: 'Salão', icon: 'grid' },
    { id: 'chamados', label: 'Chamados', icon: 'bell' },
    { id: 'comentarios', label: 'Comentários', icon: 'msg' },
    { id: 'plaquinhas', label: 'Mesas', icon: 'nfc' },
    { id: 'ajustes', label: 'Ajustes', icon: 'sliders' },
  ];
  // Fidelidade aparece quando a central libera o módulo para o restaurante.
  const temFid = () => !!(S.settings.modulos && S.settings.modulos.fidelidade && window.FidPainel);
  // Sem o serviço de chamar o garçom no plano, somem Chamados e Salão; com o sino desligado na página, some Chamados.
  const temServico = (k) => !S.settings.plano || !!S.settings.plano.servicos[k];
  // Delivery aparece com o serviço no plano.
  const temDel = () => temServico('delivery') && !!window.DelPainel;
  // Prorrogação (adicional) aparece com o adicional no plano.
  const temHH = () => !!(S.settings.plano && S.settings.plano.adicionais && S.settings.plano.adicionais.prorrogacao && window.HHPainel);
  const views = () => {
    const sino = S.settings.mesas.sino !== false;
    let base = VIEWS.filter((v) => (temServico('garcom') || !['chamados', 'salao'].includes(v.id)) && (sino || v.id !== 'chamados'));
    if (temDel()) {
      const i = base.findIndex((v) => v.id === 'comentarios');
      base = [...base.slice(0, i), { id: 'delivery', label: 'Delivery', curto: 'Delivery', icon: 'receipt' }, ...base.slice(i)];
    }
    if (temHH()) {
      const i = base.findIndex((v) => v.id === 'comentarios');
      base = [...base.slice(0, i), { id: 'prorrogacao', label: HHPainel.nome(), curto: 'Happy', icon: 'timer' }, ...base.slice(i)];
    }
    if (!temFid()) return base;
    const i = base.findIndex((v) => v.id === 'plaquinhas');
    return [...base.slice(0, i), { id: 'fidelidade', label: 'Fidelidade', curto: 'Pontos', icon: 'gift' }, ...base.slice(i)];
  };

  const motivo = (id) => cfg.motivos.find((m) => m.id === id) || { label: id, curto: id };
  const areaDe = (n) => (S.settings.mesas.areas.find((a) => n >= a.de && n <= a.ate) || {}).nome || '';
  const [WARN, LATE] = cfg.equipe.alertaMin;
  const urgency = (c) => {
    if (c.status !== 'aberto') return 'calm';
    const m = secondsSince(c.criado_em) / 60;
    return m >= LATE ? 'late' : m >= WARN ? 'warn' : 'calm';
  };
  const firstName = (n) => String(n || '').trim().split(/\s+/)[0];
  const nomeRest = () => S.settings.restaurante.nome || 'Restaurante';

  /* Sessões: celulares que pediram (ou já têm) o sino liberado. */
  const vigente = (s) =>
    s.status === 'pendente' ? secondsSince(s.criado_em) < 1800
      : s.status === 'liberada' ? secondsSince(s.liberada_em || s.criado_em) < 6 * 3600 : false;
  const pendentes = () => S.sessoes.filter((s) => s.status === 'pendente' && vigente(s));
  const pessoasNa = (n) => S.sessoes.filter((s) => s.mesa === n && s.status === 'liberada' && vigente(s));
  const codigoDa = (n) => (S.mesasAbertas.find((m) => m.mesa === n) || {}).codigo || '';
  const nomeDaSessao = (id) => (id && (S.sessoes.find((s) => s.id === id) || {}).nome) || '';

  /* ============================== Entrada ============================== */
  // Entrar: só o PIN. Criar conta: nome, PIN novo e o código da equipe. A primeira conta vira administradora;
  // as outras entram como equipe (um administrador pode dar o acesso de administrador em Ajustes → Restaurante → Equipe).
  let temSenhaEquipe = true;
  let temEquipe = false;
  function showLogin(msg = '') {
    $('#shell').hidden = true;
    $('#login').hidden = false;
    $('#loginBrand').textContent = nomeRest();
    const criar = S.loginModo === 'criar';
    // Esqueci o PIN: e-mail de recuperação → código → PIN novo.
    if (S.loginModo === 'esqueci' || S.loginModo === 'codigo') {
      const passo2 = S.loginModo === 'codigo';
      $('#loginForm').innerHTML = `<h2 class="login-sub">Esqueci meu PIN</h2>
        ${passo2
          ? `<p class="muted">Enviamos um código de 6 números para <b>${esc(S.esqueci.mascara)}</b>. Ele vale 15 minutos.${S.esqueci.demo ? ` <span class="note">Demonstração: o código é <b class="mono">${esc(S.esqueci.demo)}</b>.</span>` : ''}</p>
             <label class="field"><span>Código do e-mail</span><input class="input mono" id="lgCodigo" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required></label>
             <label class="field"><span>Crie um PIN novo</span><input class="input pin-input" id="lgPinNovo" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="new-password" required>
               <small class="help">De 4 a 8 números.</small></label>
             <p class="form-error" id="lgErr" role="alert">${esc(msg)}</p>
             <button class="btn btn-cobalt btn-block" type="submit">Trocar o PIN e entrar</button>
             <button class="btn btn-quiet btn-block" type="button" data-login="esqueci">Mandar outro código</button>`
          : `<p class="muted">Digite o e-mail de recuperação da sua conta. Ele é cadastrado em Ajustes › Restaurante › Equipe.</p>
             <label class="field"><span>E-mail</span><input class="input" id="lgEmail" type="email" autocomplete="email" maxlength="120" required value="${esc((S.esqueci && S.esqueci.email) || '')}"></label>
             <p class="form-error" id="lgErr" role="alert">${esc(msg)}</p>
             <button class="btn btn-cobalt btn-block" type="submit">Mandar código</button>
             <p class="login-hint">Sem e-mail cadastrado? O administrador do restaurante troca o seu PIN em Ajustes › Restaurante › Equipe. Se você é o único administrador, fale com a Vortex: a central troca para você.</p>`}
        <button class="btn btn-quiet btn-block" type="button" data-login="entrar">Voltar para entrar</button>`;
      setTimeout(() => ($('#lgCodigo') || $('#lgEmail')).focus(), 50);
      return;
    }
    $('#loginForm').innerHTML = `${S.vincular ? `<p class="note">${icon('nfc')}<span>Entre para ligar a plaquinha <b class="mono">${esc(S.vincular)}</b> a uma mesa.</span></p>` : ''}
      <div class="seg login-tabs" role="tablist" aria-label="Acesso da equipe">
        <button type="button" role="tab" aria-selected="${!criar}" data-login="entrar">Entrar</button>
        <button type="button" role="tab" aria-selected="${criar}" data-login="criar">Criar conta</button>
      </div>
      ${criar
        ? `<label class="field"><span>Seu nome</span><input class="input" id="lgNome" autocomplete="name" maxlength="60" required placeholder="Como a mesa vai ver você"></label>
           <label class="field"><span>Crie seu PIN</span><input class="input pin-input" id="lgPinNovo" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="new-password" required>
             <small class="help">De 4 a 8 números. É com ele que você entra daqui para frente.</small></label>
           ${temEquipe
             ? `<p class="note">${icon('users')}<span>Você entra como <b>equipe</b>. Se precisar ser administrador, peça para um administrador liberar em Ajustes → Restaurante → Equipe.</span></p>`
             : `<p class="note">${icon('lock')}<span>É a primeira conta do restaurante: ela vira a do <b>administrador</b>.</span></p>`}
           <label class="field"><span>${temSenhaEquipe ? 'Código da equipe' : 'Crie o código da equipe'}</span><input class="input" id="lgSenha" type="password" autocomplete="${temSenhaEquipe ? 'off' : 'new-password'}" minlength="6" required>
             <small class="help">${temSenhaEquipe ? 'Peça ao administrador do restaurante. Na primeira conta, é o código enviado pela Vortex.' : 'Demonstração: este passa a ser o código da equipe neste navegador.'}</small></label>
           <p class="form-error" id="lgErr" role="alert">${esc(msg)}</p>
           <button class="btn btn-cobalt btn-block" type="submit">Criar conta e entrar</button>`
        : `<label class="field"><span>Seu PIN</span><input class="input pin-input" id="lgPin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="current-password" required></label>
           ${S.aparelhoNovo ? `<label class="field"><span>Código da equipe</span><input class="input" id="lgSenhaEq" type="password" autocomplete="off" minlength="6" required>
             <small class="help">Só na primeira vez neste aparelho. Depois, o painel pede só o PIN.</small></label>` : ''}
           <p class="form-error" id="lgErr" role="alert">${esc(msg)}</p>
           <button class="btn btn-cobalt btn-block" type="submit">Entrar no painel</button>
           <button class="btn btn-quiet btn-block" type="button" data-login="esqueci">Esqueci meu PIN</button>
           <p class="login-hint">Ainda não tem PIN? Toque em “Criar conta” com o código da equipe, ou peça para o administrador cadastrar você.</p>`}`;
    setTimeout(() => ($('#lgPin') || $('#lgNome')).focus(), 50);
  }

  $('#loginForm').addEventListener('click', (e) => {
    const b = e.target.closest('[data-login]');
    if (!b || b.dataset.login === S.loginModo) return;
    S.loginModo = b.dataset.login;
    showLogin();
  });

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#lgErr');
    const btn = e.target.querySelector('[type=submit]');
    const falhar = (msg, campo) => {
      err.textContent = msg;
      campo && campo.focus();
    };
    let r;
    if (S.loginModo === 'esqueci') {
      const email = $('#lgEmail').value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return falhar('Digite um e-mail válido.', $('#lgEmail'));
      btn.disabled = true;
      try {
        const x = await store.auth.esqueci(email);
        S.esqueci = { email, mascara: x.email || email, demo: x.demoCodigo || null };
      } catch (ex) {
        btn.disabled = false;
        return falhar(ex.message, $('#lgEmail'));
      }
      S.loginModo = 'codigo';
      return showLogin();
    }
    if (S.loginModo === 'codigo') {
      const codigo = $('#lgCodigo').value.replace(/\D/g, '');
      const pin = $('#lgPinNovo').value.trim();
      if (codigo.length !== 6) return falhar('O código tem 6 números.', $('#lgCodigo'));
      if (!/^\d{4,8}$/.test(pin)) return falhar('O PIN precisa ter de 4 a 8 números.', $('#lgPinNovo'));
      btn.disabled = true;
      try {
        r = await store.auth.redefinir({ email: S.esqueci.email, codigo, pin });
      } catch (ex) {
        btn.disabled = false;
        return falhar(ex.message, /PIN/.test(ex.message) ? $('#lgPinNovo') : $('#lgCodigo'));
      }
      S.loginModo = 'entrar';
      toast('PIN trocado. Use o PIN novo nas próximas vezes.', { tone: 'ok' });
    } else if (S.loginModo === 'criar') {
      const nome = $('#lgNome').value.trim();
      const pin = $('#lgPinNovo').value.trim();
      const senhaEquipe = $('#lgSenha').value;
      if (!nome) return falhar('Informe seu nome. Ele aparece para a mesa quando você estiver a caminho.', $('#lgNome'));
      if (!/^\d{4,8}$/.test(pin)) return falhar('O PIN precisa ter de 4 a 8 números.', $('#lgPinNovo'));
      if (senhaEquipe.length < 6) return falhar('O código da equipe tem pelo menos 6 caracteres.', $('#lgSenha'));
      btn.disabled = true;
      try {
        r = await store.auth.cadastrar({ nome, pin, senhaEquipe });
      } catch (ex) {
        btn.disabled = false;
        return falhar(ex.message, /PIN/.test(ex.message) ? $('#lgPinNovo') : /[Cc]ódigo/.test(ex.message) ? $('#lgSenha') : null);
      }
      toast(r.admin ? 'Conta de administrador criada. Cadastre a equipe em Ajustes → Restaurante → Equipe.' : `Bem-vindo, ${firstName(r.nome)}! Sua conta da equipe foi criada.`, { tone: 'ok', ms: 6000 });
    } else {
      const pin = $('#lgPin').value.trim();
      if (!/^\d{4,8}$/.test(pin)) return falhar('Digite seu PIN (4 a 8 números).', $('#lgPin'));
      const senhaEq = $('#lgSenhaEq') ? $('#lgSenhaEq').value : '';
      if (S.aparelhoNovo && senhaEq.length < 6) return falhar('Digite o código da equipe (só na primeira vez neste aparelho).', $('#lgSenhaEq'));
      btn.disabled = true;
      try {
        r = await store.auth.entrar(pin, senhaEq);
      } catch (ex) {
        btn.disabled = false;
        if (ex.aparelhoNovo && !S.aparelhoNovo) {
          // Aparelho novo: mostra o campo do código da equipe e mantém o PIN digitado.
          S.aparelhoNovo = true;
          showLogin(ex.message);
          $('#lgPin').value = pin;
          return $('#lgSenhaEq').focus();
        }
        $('#lgPin').value = '';
        return falhar(ex.message, ex.aparelhoNovo ? $('#lgSenhaEq') : $('#lgPin'));
      }
      S.aparelhoNovo = false;
    }
    S.user = { nome: r.nome, admin: !!r.admin };
    unlockAudio();
    startApp();
  });

  async function logout() {
    try { await store.auth.sair(); } catch {}
    location.hash = '';
    location.reload();
  }

  /* ============================== Alertas ============================== */
  let actx;
  function unlockAudio() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      actx.state === 'suspended' && actx.resume();
    } catch {}
  }
  // Sino de balcão sintetizado: dois golpes com harmônicos e decaimento longo.
  function ding(strikes = 2) {
    if (!S.som || !actx) return;
    const t = actx.currentTime + 0.02;
    for (let s = 0; s < strikes; s++) {
      [[1567.98, 0.32], [3135.96, 0.08], [4700, 0.04]].forEach(([f, vol]) => {
        const o = actx.createOscillator();
        const g = actx.createGain();
        const st = t + s * 0.22;
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, st);
        g.gain.exponentialRampToValueAtTime(vol, st + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, st + 1.6);
        o.connect(g).connect(actx.destination);
        o.start(st);
        o.stop(st + 1.7);
      });
    }
  }
  document.addEventListener('pointerdown', unlockAudio, { once: true });

  async function notify(c) {
    if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
    const titulo = c.titulo || `Mesa ${c.mesa} · ${motivo(c.tipo).label}`;
    const opcoes = {
      body: c.corpo || c.nota || (c.pagamento ? `Pagamento: ${c.pagamento}` : 'Toque para abrir o painel'),
      tag: c.id,
      icon: '/admin/icons/icon-192.png',
      badge: '/admin/icons/icon-192.png',
      vibrate: [200, 100, 200],
    };
    try {
      // No Android e no app instalado, a notificação só sai pelo service worker.
      const reg = 'serviceWorker' in navigator && (await navigator.serviceWorker.getRegistration('/admin/'));
      if (reg) return await reg.showNotification(titulo, opcoes);
      const n = new Notification(titulo, opcoes);
      n.onclick = () => { window.focus(); n.close(); };
    } catch {}
  }

  /* ============================== App no celular ============================== */
  const APP = {
    pedido: null,
    instalado: () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
    ios: () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  };
  if ('serviceWorker' in navigator) {
    addEventListener('load', () => navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin/' }).catch(() => {}));
  }

  /* App instalado com o nome e a logo do restaurante ("Ciência Food · Painel", não só "Painel").
     O manifesto e os ícones ficam no cache 'painel-marca' e o service worker entrega no endereço de sempre.
     Mudou o nome ou a logo: o link do manifesto muda e o Android atualiza o app instalado ao abrir.
     No iPhone, o nome e o ícone valem na hora de adicionar à tela de início. */
  let marcaFeita = '';
  const nomeCurto = (nome) => {
    if (nome.length <= 12) return nome;
    let r = '';
    for (const w of nome.split(/\s+/)) {
      if ((r ? `${r} ${w}` : w).length > 12) break;
      r = r ? `${r} ${w}` : w;
    }
    return r || nome.slice(0, 12);
  };
  // Logo centralizada num quadrado branco (folga maior no ícone "maskable", que o Android recorta).
  const iconeDaLogo = (img, lado, folga) => new Promise((ok) => {
    const c = document.createElement('canvas');
    c.width = c.height = lado;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, lado, lado);
    const area = lado * (1 - 2 * folga);
    const k = Math.min(area / img.naturalWidth, area / img.naturalHeight);
    const w = img.naturalWidth * k;
    const h = img.naturalHeight * k;
    g.drawImage(img, (lado - w) / 2, (lado - h) / 2, w, h);
    c.toBlob(ok, 'image/png');
  });
  const carregarImg = (src) => new Promise((ok, erro) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => ok(img);
    img.onerror = erro;
    img.src = src;
  });
  async function marcaDoApp(nome, logo) {
    const chave = `${nome}|${logo}`;
    if (chave === marcaFeita) return;
    marcaFeita = chave;
    const curto = nomeCurto(nome);
    const meta = (n, v) => { const m = document.querySelector(`meta[name="${n}"]`); if (m) m.content = v; };
    meta('apple-mobile-web-app-title', curto);
    meta('application-name', curto);
    if (!('caches' in window) || !('serviceWorker' in navigator)) return;
    try {
      const v = [...chave].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(36);
      const cache = await caches.open('painel-marca');
      let icons = [
        { src: '/admin/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/admin/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/admin/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ];
      if (logo) {
        try {
          const img = await carregarImg(logo);
          const png = (b) => new Response(b, { headers: { 'Content-Type': 'image/png' } });
          const [p192, p512, pm, p180] = await Promise.all([iconeDaLogo(img, 192, 0.08), iconeDaLogo(img, 512, 0.08), iconeDaLogo(img, 512, 0.2), iconeDaLogo(img, 180, 0.08)]);
          await Promise.all([
            cache.put(`/admin/icons/marca-192-${v}.png`, png(p192)),
            cache.put(`/admin/icons/marca-512-${v}.png`, png(p512)),
            cache.put(`/admin/icons/marca-maskable-${v}.png`, png(pm)),
          ]);
          icons = [
            { src: `/admin/icons/marca-192-${v}.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: `/admin/icons/marca-512-${v}.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: `/admin/icons/marca-maskable-${v}.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ];
          // iPhone lê o ícone direto da página.
          const touch = document.querySelector('link[rel="apple-touch-icon"]');
          if (touch && p180) touch.href = await new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(p180); });
        } catch {} // Logo sem permissão de leitura (CORS) ou quebrada: fica o ícone da VTX, com o nome do restaurante.
      }
      const manifesto = {
        id: '/admin/', name: `${nome} · Painel`, short_name: curto,
        description: `Painel da equipe do ${nome}: chamados, salão, pedidos e ajustes.`,
        lang: 'pt-BR', start_url: '/admin/', scope: '/admin/', display: 'standalone', orientation: 'any',
        background_color: '#F4F2F9', theme_color: '#140B33', categories: ['business', 'food'], icons,
      };
      await cache.put('/admin/manifest.webmanifest', new Response(JSON.stringify(manifesto), { headers: { 'Content-Type': 'application/manifest+json' } }));
      // Link novo: o navegador lê o manifesto de novo (e o Android atualiza o app instalado).
      const link = document.querySelector('link[rel="manifest"]');
      if (link) link.href = `/admin/manifest.webmanifest?m=${v}`;
    } catch {}
  }
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    APP.pedido = e;
    avisoApp();
    if (S.user) renderChrome();
    if (S.user && S.view === 'ajustes' && S.ajTab === 'aparelho') renderView();
  });
  addEventListener('appinstalled', () => {
    APP.pedido = null;
    $('#appAviso')?.remove();
    toast('App instalado. Abra pelo ícone “Painel” na tela inicial.', { tone: 'ok', ms: 4500 });
    if (S.user && S.view === 'ajustes' && S.ajTab === 'aparelho') renderView();
  });

  async function instalarApp() {
    if (APP.pedido) {
      const pedido = APP.pedido;
      APP.pedido = null;
      pedido.prompt();
      await pedido.userChoice.catch(() => null);
      if (S.view === 'ajustes' && S.ajTab === 'aparelho') renderView();
      return;
    }
    S.ajTab = 'aparelho';
    if (S.view === 'ajustes') renderView();
    else go('ajustes');
  }

  function passosIos() {
    return `<ol class="app-passos">
        <li>Abra este endereço no <b>Safari</b>.</li>
        <li>Toque em <b>Compartilhar</b> ${icon('share')}.</li>
        <li>Escolha <b>Adicionar à Tela de Início</b> e toque em <b>Adicionar</b>.</li>
      </ol>`;
  }

  // Convite para instalar (celular e computador). Fechado, volta depois de 14 dias.
  function avisoApp() {
    if (!S.user || APP.instalado() || $('#appAviso')) return;
    if (Date.now() - (+get('nfc-app-aviso') || 0) < 14 * 864e5) return;
    if (!APP.pedido && !APP.ios()) return;
    const el = document.createElement('div');
    el.className = 'app-aviso';
    el.id = 'appAviso';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Instalar o app');
    el.innerHTML = `<img src="/admin/icons/icon-192.png" alt="" width="40" height="40">
      <div><b>Instale o painel</b><small>Abre direto da tela inicial ou da barra de tarefas, em tela cheia, e avisa dos chamados.</small></div>
      <button type="button" class="btn btn-cobalt btn-sm" data-app="instalar">${APP.pedido ? 'Instalar' : 'Como instalar'}</button>
      <button type="button" class="icon-btn" data-app="fechar" aria-label="Agora não">${icon('x')}</button>`;
    document.body.append(el);
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-app]');
    if (!b) return;
    if (b.closest('#appAviso')) {
      set('nfc-app-aviso', String(Date.now()));
      $('#appAviso').remove();
    }
    if (b.dataset.app === 'instalar') instalarApp();
  });

  let wakeLock = null;
  async function applyWakeLock() {
    try {
      if (S.telaLigada && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        if (!wakeLock) {
          wakeLock = await navigator.wakeLock.request('screen');
          wakeLock.addEventListener('release', () => (wakeLock = null));
        }
      } else if (!S.telaLigada && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch {}
  }
  document.addEventListener('visibilitychange', () => {
    applyWakeLock();
    if (document.visibilityState === 'visible') refresh();
  });

  /* ============================== Dados ============================== */
  const desde = () => new Date(Date.now() - 16 * 3600e3);

  async function refresh() {
    if (!S.user) return;
    try {
      const [calls, fb, sessoes, abertas, etiquetas] = await Promise.all([
        store.listCalls({ desde: desde() }),
        store.listFeedback(),
        store.listSessoes({ desde: desde() }),
        store.listMesasAbertas(),
        store.listEtiquetas(),
      ]);
      S.calls = calls || [];
      S.fb = fb || [];
      S.sessoes = sessoes || [];
      S.mesasAbertas = abertas || [];
      S.etiquetas = etiquetas || [];
      S.online = true;
    } catch (e) {
      console.error(e);
      S.online = false;
    }
    if (temFid()) await FidPainel.atualizar();
    if (temDel()) await DelPainel.atualizar();
    if (temHH()) await HHPainel.atualizar();
    detectNew();
    renderChrome();
    // Na fidelidade só redesenha sem formulário em edição (não apaga o que está sendo digitado).
    if (['chamados', 'salao', 'comentarios', 'plaquinhas'].includes(S.view)) renderView();
    else if (S.view === 'fidelidade' && !$('#main').contains(document.activeElement)) renderView();
    else if (S.view === 'delivery' && !DelPainel.editando()) renderView();
    if (S.mesaAberta && !$('#sh-mesa').hidden) renderMesaSheet(S.mesaAberta);
  }

  let refreshT;
  const queueRefresh = () => {
    clearTimeout(refreshT);
    refreshT = setTimeout(refresh, 80);
  };

  function detectNew() {
    const novos = [];
    for (const c of S.calls) {
      if (S.seen.has(c.id)) continue;
      S.seen.add(c.id);
      if (S.ready && c.status === 'aberto') novos.push(c);
    }
    const novasSess = [];
    for (const x of S.sessoes) {
      if (S.seenSess.has(x.id)) continue;
      S.seenSess.add(x.id);
      if (S.ready && x.status === 'pendente') novasSess.push(x);
    }
    let novosFb = 0;
    for (const f of S.fb) {
      if (S.seenFb.has(f.id)) continue;
      S.seenFb.add(f.id);
      if (S.ready) novosFb++;
    }
    S.ready = true;
    if (novos.length) {
      ding(2);
      navigator.vibrate && navigator.vibrate([80, 60, 80]);
      novos.forEach((c) => {
        S.fresh.set(c.id, Date.now());
        notify(c);
      });
      const c = novos[novos.length - 1];
      toast(`Mesa ${c.mesa} chamou · ${motivo(c.tipo).label}`, {
        action: S.view !== 'chamados' ? { label: 'Ver', run: () => go('chamados') } : null,
      });
    }
    if (novasSess.length) {
      if (!novos.length) ding(2);
      navigator.vibrate && navigator.vibrate([80, 60, 80]);
      novasSess.forEach((x) => {
        S.fresh.set(x.id, Date.now());
        notify({ id: x.id, titulo: `Mesa ${x.mesa} · ${x.nome}`, corpo: 'Pede para usar o sino. Confira se está na mesa e libere.' });
      });
      const x = novasSess[novasSess.length - 1];
      toast(`Mesa ${x.mesa}: ${x.nome} pede para usar o sino`, {
        ms: 5000,
        action: S.view !== 'chamados' ? { label: 'Ver', run: () => go('chamados') } : null,
      });
    }
    if (novosFb) toast(novosFb === 1 ? 'Novo comentário anônimo recebido.' : `${novosFb} comentários novos.`, {
      action: S.view !== 'comentarios' ? { label: 'Ler', run: () => go('comentarios') } : null,
    });
    const abertos = S.calls.filter((c) => c.status === 'aberto').length + pendentes().length;
    document.title = abertos ? `(${abertos}) Chamados · ${nomeRest()}` : `Painel · ${nomeRest()}`;
  }

  async function act(id, what) {
    const c = S.calls.find((x) => x.id === id);
    if (!c) return;
    const prev = { status: c.status, atendente: c.atendente || null, visto_em: c.visto_em || null, resolvido_em: c.resolvido_em || null };
    const now = new Date().toISOString();
    const patch =
      what === 'ir'
        ? { status: 'a_caminho', atendente: S.user.nome, visto_em: now }
        : { status: 'resolvido', resolvido_em: now, atendente: c.atendente || S.user.nome, visto_em: c.visto_em || now };
    Object.assign(c, patch);
    renderView();
    renderChrome();
    try {
      await store.updateCall(id, patch);
      if (what === 'ok') {
        toast(`Mesa ${c.mesa} resolvida.`, {
          ms: 5000,
          action: { label: 'Desfazer', run: () => store.updateCall(id, prev).then(queueRefresh) },
        });
      }
    } catch (e) {
      console.error(e);
      toast('A alteração não foi salva. Verifique a conexão.', { tone: 'error' });
      queueRefresh();
    }
  }

  /* ============================== Estrutura ============================== */
  function counts() {
    return {
      abertos: S.calls.filter((c) => c.status === 'aberto').length + pendentes().length,
      caminho: S.calls.filter((c) => c.status === 'a_caminho').length,
      naoLidos: S.fb.filter((f) => !f.lido).length,
    };
  }
  const badgeFor = (id, n) => {
    if (id === 'chamados' && n.abertos) return `<span class="badge">${n.abertos}</span>`;
    if (id === 'comentarios' && n.naoLidos) return `<span class="badge badge--soft">${n.naoLidos}</span>`;
    if (id === 'fidelidade' && temFid() && FidPainel.badge()) return `<span class="badge">${FidPainel.badge()}</span>`;
    if (id === 'delivery' && temDel() && DelPainel.badge()) return `<span class="badge">${DelPainel.badge()}</span>`;
    if (id === 'prorrogacao' && temHH() && HHPainel.badge()) return '<span class="badge badge--vivo" aria-label="rolando agora">●</span>';
    return '';
  };

  function renderChrome() {
    const n = counts();
    $('#sideBrand').textContent = nomeRest();
    UI.aplicarCor(S.settings.restaurante.cor);
    const logo = safeUrl(S.settings.restaurante.logo);
    const mark = $('.side-mark');
    mark.classList.toggle('has-logo', !!logo);
    mark.innerHTML = logo ? `<img src="${esc(logo)}" alt="">` : esc(initials(nomeRest()));
    marcaDoApp(nomeRest(), logo);
    const lista = views();
    $('#sideNav').innerHTML = lista.map(
      (v) => `<a class="nav-item" href="#${v.id}" ${S.view === v.id ? 'aria-current="page"' : ''}>${icon(v.icon)}<span>${v.label}</span>${badgeFor(v.id, n)}</a>`
    ).join('');
    // Celular: até 5 abas cabem na barra; com mais, ficam as 4 mais usadas e o resto vai para "Mais".
    const PRIORIDADE = ['salao', 'chamados', 'fidelidade', 'delivery', 'prorrogacao', 'plaquinhas', 'comentarios', 'ajustes'];
    const fixas = lista.length > 5 ? [...lista].sort((x, y) => PRIORIDADE.indexOf(x.id) - PRIORIDADE.indexOf(y.id)).slice(0, 4) : lista;
    const resto = lista.filter((v) => !fixas.includes(v));
    const tab = (v) => `<a class="tab" href="#${v.id}" ${S.view === v.id ? 'aria-current="page"' : ''}>${icon(v.icon)}<span>${v.curto || v.label}</span>${badgeFor(v.id, n)}</a>`;
    const noResto = resto.find((v) => v.id === S.view);
    $('#tabbar').style.gridTemplateColumns = `repeat(${fixas.length + (resto.length ? 1 : 0)}, 1fr)`;
    $('#tabbar').innerHTML = lista.filter((v) => fixas.includes(v)).map(tab).join('')
      + (resto.length ? `<button type="button" class="tab" data-mais ${noResto ? 'aria-current="page"' : ''} aria-haspopup="dialog">${icon(noResto ? noResto.icon : 'more')}<span>${noResto ? noResto.curto || noResto.label : 'Mais'}</span>${resto.some((v) => badgeFor(v.id, n)) ? '<span class="badge badge-dot" aria-label="tem novidade"></span>' : ''}</button>` : '');
    $('#maisBody').innerHTML = `<nav class="mais-lista" aria-label="Outras abas">${resto.map((v) => `<a class="mais-item" href="#${v.id}" data-mais-ir="${v.id}" ${S.view === v.id ? 'aria-current="page"' : ''}>${icon(v.icon)}<span>${v.label}</span>${badgeFor(v.id, n)}</a>`).join('')}</nav>`;
    $('#sideFoot').innerHTML = `
      <span class="live ${S.online ? '' : 'is-off'}">${S.online ? (isDemo ? 'Ao vivo · modo demonstração' : 'Ao vivo') : 'Sem conexão'}</span>
      <div class="side-user"><span class="avatar">${esc(firstName(S.user.nome)[0] || '?').toUpperCase()}</span>
        <div>${esc(S.user.nome)}<small>Em serviço</small></div></div>
      <div class="side-tools">
        <button class="icon-btn" type="button" data-tool="som" aria-pressed="${S.som}" aria-label="${S.som ? 'Silenciar alertas' : 'Ativar som dos alertas'}" title="Som dos alertas">${icon(S.som ? 'volume' : 'mute')}</button>
        ${!APP.instalado() && (APP.pedido || APP.ios()) ? `<button class="icon-btn" type="button" data-app="instalar" aria-label="Instalar o app" title="Instalar o app">${icon('download')}</button>` : ''}
        <button class="icon-btn" type="button" data-tool="tema" aria-label="Alternar tema claro/escuro" title="Tema">${icon(isDark() ? 'sun' : 'moon')}</button>
        <button class="icon-btn" type="button" data-tool="sair" aria-label="Sair" title="Sair">${icon('logout')}</button>
      </div>`;
    $('#mtopTitle').textContent = lista.find((v) => v.id === S.view).label;
    $('#mtopActions').innerHTML = `
      <button class="icon-btn" type="button" data-tool="som" aria-pressed="${S.som}" aria-label="${S.som ? 'Silenciar alertas' : 'Ativar som dos alertas'}">${icon(S.som ? 'volume' : 'mute')}</button>
      <span class="avatar" title="${esc(S.user.nome)}">${esc(firstName(S.user.nome)[0] || '?').toUpperCase()}</span>`;
  }

  const isDark = () => {
    const t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  };
  function setTheme(t) {
    if (t === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    set('nfc-tema-painel', t);
    renderChrome();
    if (S.view === 'ajustes') renderView();
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tool]');
    if (!t) return;
    if (t.dataset.tool === 'som') {
      S.som = !S.som;
      set('nfc-som', S.som ? '1' : '0');
      unlockAudio();
      if (S.som) ding(1);
      renderChrome();
      if (S.view === 'ajustes') renderView();
    } else if (t.dataset.tool === 'tema') setTheme(isDark() ? 'light' : 'dark');
    else if (t.dataset.tool === 'sair') logout();
  });

  // "Mais" no celular: abre a lista; escolher uma aba fecha a folha e depois navega (o fechar mexe no histórico).
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-mais]')) { openSheet('sh-mais'); return; }
    const ir = e.target.closest('[data-mais-ir]');
    if (!ir) return;
    e.preventDefault();
    const el = $('#sh-mais');
    el.addEventListener('sheet:close', () => go(ir.dataset.maisIr), { once: true });
    closeSheet();
  });
  function go(view) {
    location.hash = view;
  }
  function route() {
    const v = location.hash.replace('#', '');
    S.view = views().some((x) => x.id === v) ? v : views()[0].id;
    renderChrome();
    renderView();
    $('#main').scrollTop = 0;
    window.scrollTo(0, 0);
  }

  /* ============================== Telas ============================== */
  /* ---------- Configuração inicial: o que falta preencher ---------- */
  function infoPreenchida() {
    const r = S.settings.restaurante;
    return [
      r.endereco && 'endereço',
      String(r.telefone || '').replace(/\D/g, '').length >= 10 && 'telefone',
      (r.horarios || []).length && 'horários',
      instagramHandle(r.instagram) && 'Instagram',
    ].filter(Boolean);
  }
  function passosConfig() {
    const r = S.settings.restaurante;
    const itens = S.settings.cardapio.reduce((n, c) => n + c.itens.length, 0);
    const info = S.settings.widgets.find((w) => w.tipo === 'info');
    return [
      { ok: !!r.logo, txt: 'Logo', aba: 'restaurante' },
      { ok: !!r.endereco, txt: 'Endereço', aba: 'restaurante' },
      { ok: String(r.telefone || '').replace(/\D/g, '').length >= 10, txt: 'Telefone', aba: 'restaurante' },
      { ok: (r.horarios || []).length > 0, txt: 'Horários', aba: 'restaurante' },
      { ok: !!instagramHandle(r.instagram), txt: 'Instagram', aba: 'restaurante' },
      { ok: !!r.googleUrl, txt: 'Link de avaliação do Google', aba: 'restaurante' },
      { ok: !!(S.settings.wifi && S.settings.wifi.rede), txt: 'Wi-Fi', aba: 'restaurante' },
      { ok: itens > 0, txt: 'Cardápio', aba: 'cardapio' },
      { ok: !!(info && info.ativo), txt: 'Mostrar as informações para o cliente', aba: 'widgets' },
    ];
  }
  const chavePulo = () => `nfc-config-pulada:${cfg.backend.slug || 'demo'}`;
  function avisoConfig() {
    if (S.settings.restaurante.configConcluida) return '';
    // Só na primeira aba e em Ajustes: no celular o aviso ocupava o topo de todas as telas.
    if (![views()[0].id, 'ajustes'].includes(S.view)) return '';
    const pulado = +get(chavePulo()) || 0;
    if (Date.now() - pulado < 7 * 864e5) return '';
    const passos = passosConfig();
    const feitos = passos.filter((p) => p.ok).length;
    if (feitos === passos.length) return '';
    return `<section class="cfg-aviso" aria-label="Configuração do restaurante">
      <div class="cfg-aviso-h">
        <div><h2>Conclua a configuração do restaurante</h2>
          <p>O que não estiver preenchido não aparece para o cliente. ${feitos} de ${passos.length} feitos; falta:</p></div>
        <span class="cfg-barra" aria-hidden="true"><i style="width:${Math.round((feitos / passos.length) * 100)}%"></i></span>
      </div>
      <ul class="cfg-passos">${passos.filter((p) => !p.ok).map((p) => `<li class="${p.ok ? 'is-ok' : ''}">${p.ok ? icon('check') : ''}<button type="button" class="link" data-cfg-ir="${p.aba}">${p.txt}</button></li>`).join('')}</ul>
      <div class="vhead-actions">
        <button type="button" class="btn btn-cobalt btn-sm" data-cfg-ir="${(passos.find((p) => !p.ok) || passos[0]).aba}">Continuar configuração</button>
        <button type="button" class="btn btn-quiet btn-sm" data-cfg="pular">Pular por agora</button>
        <button type="button" class="btn btn-quiet btn-sm" data-cfg="concluir">Marcar como concluída</button>
      </div>
    </section>`;
  }
  document.addEventListener('click', async (e) => {
    const ir = e.target.closest('[data-cfg-ir]');
    if (ir) {
      S.ajTab = ir.dataset.cfgIr;
      if (S.view === 'ajustes') renderView();
      else go('ajustes');
      return;
    }
    const b = e.target.closest('[data-cfg]');
    if (!b) return;
    if (b.dataset.cfg === 'pular') {
      set(chavePulo(), String(Date.now()));
      toast('Tudo bem. Lembramos de novo em 7 dias.');
    } else {
      await saveRestaurante({ configConcluida: true });
      toast('Configuração marcada como concluída.', { tone: 'ok' });
    }
    renderView();
  });

  function renderView() {
    const main = $('#main');
    main.dataset.view = S.view;
    main.innerHTML = avisoConfig() + { chamados: vChamados, salao: vSalao, comentarios: vComentarios, plaquinhas: vPlaquinhas, ajustes: vAjustes, fidelidade: () => FidPainel.html(), delivery: () => DelPainel.html(),
      prorrogacao: () => HHPainel.html() }[S.view]();
    if (S.view === 'ajustes' && S.ajTab === 'restaurante') carregarEquipe();
  }

  /* ---------- Chamados ---------- */
  function callCard(c) {
    const m = motivo(c.tipo);
    const done = c.status === 'resolvido' || c.status === 'cancelado';
    const isNew = S.fresh.has(c.id) && Date.now() - S.fresh.get(c.id) < 1500;
    const itens = Array.isArray(c.itens) && c.itens.length
      ? `<ul class="ccard-items">${c.itens.map((i) => `<li><span><b>${i.qtd}×</b>${esc(i.nome)}</span>${i.preco ? `<span class="muted">${brl(i.preco * i.qtd)}</span>` : ''}</li>`).join('')}</ul>`
      : '';
    return `<article class="ccard ${done ? 'ccard--done' : ''} ${isNew ? 'is-new' : ''}" data-id="${c.id}" data-status="${c.status}" data-urg="${urgency(c)}">
      <div class="mini-plate" aria-label="Mesa ${c.mesa}"><small>Mesa</small><b>${pad(c.mesa)}</b></div>
      <div class="ccard-body">
        <div class="ccard-row"><h3>${esc(m.label)}</h3>
          ${done
            ? `<span class="state-tag ${c.status === 'resolvido' ? 'state-tag--ok' : ''}">${c.status === 'resolvido' ? 'Resolvido' : 'Cancelado'}</span>`
            : `<time class="timer" data-since="${c.criado_em}" title="Tempo desde o chamado">${clock(c.criado_em)}</time>`}
        </div>
        <p class="ccard-meta">${nomeDaSessao(c.sessao_id) ? `<b>${esc(nomeDaSessao(c.sessao_id))}</b> · ` : ''}${esc(areaDe(c.mesa))} · ${hhmm(c.criado_em)}${done && c.atendente ? ` · ${esc(firstName(c.atendente))}` : ''}</p>
        ${c.pagamento ? `<span class="ccard-pay">Pagamento: ${esc(c.pagamento)}</span>` : ''}
        ${c.nota ? `<p class="ccard-note">“${esc(c.nota)}”</p>` : ''}
        ${itens}
        ${c.status === 'a_caminho' ? `<p class="ccard-who">${icon('arrow')} ${esc(firstName(c.atendente))} a caminho · ${ago(c.visto_em || c.atualizado_em)}</p>` : ''}
      </div>
      ${done ? '' : `<div class="ccard-actions">
        ${c.status === 'aberto' ? `<button type="button" class="btn btn-cobalt" data-act="ir" data-id="${c.id}">Estou indo</button>` : ''}
        <button type="button" class="btn ${c.status === 'a_caminho' ? 'btn-primary' : 'btn-quiet'}" data-act="ok" data-id="${c.id}">${icon('check')} Resolvido</button>
        ${c.tipo === 'conta' ? `<button type="button" class="btn btn-line ccard-close" data-fechar="${c.mesa}" data-id="${c.id}">${icon('lock')} Conta paga · fechar mesa</button>` : ''}
      </div>`}
    </article>`;
  }

  function sessCard(x) {
    const junto = pessoasNa(x.mesa);
    const isNew = S.fresh.has(x.id) && Date.now() - S.fresh.get(x.id) < 1500;
    return `<article class="ccard scard ${isNew ? 'is-new' : ''}" data-sess="${x.id}">
      <div class="mini-plate" aria-label="Mesa ${x.mesa}"><small>Mesa</small><b>${pad(x.mesa)}</b></div>
      <div class="ccard-body">
        <div class="ccard-row"><h3>${esc(x.nome)}</h3><time class="timer" data-since="${x.criado_em}">${clock(x.criado_em)}</time></div>
        <p class="ccard-meta">Pede para usar o sino${areaDe(x.mesa) ? ` · ${esc(areaDe(x.mesa))}` : ''}</p>
        <p class="scard-hint">${junto.length
          ? `Já liberados na mesa: ${junto.map((p) => esc(firstName(p.nome))).join(', ')}${codigoDa(x.mesa) ? ` · código <b class="mono">${codigoDa(x.mesa)}</b>` : ''}`
          : 'Ninguém liberado nesta mesa ainda. Confira se há alguém sentado nela.'}</p>
      </div>
      <div class="ccard-actions">
        <button type="button" class="btn btn-cobalt" data-sess-ok="${x.id}">${icon('check')} Liberar</button>
        <button type="button" class="btn btn-quiet" data-sess-no="${x.id}">Recusar</button>
      </div>
    </article>`;
  }

  async function decidir(id, liberar) {
    const x = S.sessoes.find((y) => y.id === id);
    if (!x) return;
    x.status = liberar ? 'liberada' : 'recusada';
    x.liberada_em = new Date().toISOString();
    renderView();
    renderChrome();
    try {
      await store.decidirSessao(id, liberar, S.user.nome);
      toast(liberar ? `Sino liberado para ${x.nome} (mesa ${x.mesa}).` : `Pedido de ${x.nome} recusado.`, { tone: liberar ? 'ok' : 'ink' });
    } catch (e) {
      console.error(e);
      toast('Não foi possível salvar. Verifique a conexão.', { tone: 'error' });
    }
    queueRefresh();
  }

  async function fecharMesa(n, callId) {
    const gente = pessoasNa(n).length;
    if (!confirm(`Fechar a mesa ${n}? ${gente ? `O sino de ${gente === 1 ? '1 pessoa' : `${gente} pessoas`} será bloqueado` : 'O sino fica bloqueado'} até a equipe liberar de novo.`)) return;
    try {
      if (callId) {
        const c = S.calls.find((x) => x.id === callId);
        if (c && c.status !== 'resolvido') {
          const now = new Date().toISOString();
          await store.updateCall(callId, { status: 'resolvido', resolvido_em: now, atendente: c.atendente || S.user.nome, visto_em: c.visto_em || now });
        }
      }
      await store.fecharMesa(n);
      toast(`Mesa ${n} fechada.`, { tone: 'ok' });
    } catch (e) {
      console.error(e);
      toast('Não foi possível fechar a mesa. Verifique a conexão.', { tone: 'error' });
    }
    queueRefresh();
  }

  function avgResponse() {
    const t = S.calls.filter((c) => c.visto_em).map((c) => (new Date(c.visto_em) - new Date(c.criado_em)) / 1000).filter((s) => s >= 0);
    if (!t.length) return null;
    const s = Math.round(t.reduce((a, b) => a + b, 0) / t.length);
    return s < 60 ? { v: s, u: 's' } : { v: `${Math.floor(s / 60)}:${pad(s % 60)}`, u: 'min' };
  }

  function vChamados() {
    const byOld = (a, b) => new Date(a.criado_em) - new Date(b.criado_em);
    const abertos = S.calls.filter((c) => c.status === 'aberto').sort(byOld);
    const caminho = S.calls.filter((c) => c.status === 'a_caminho').sort(byOld);
    const feitos = S.calls.filter((c) => c.status === 'resolvido' || c.status === 'cancelado').sort((a, b) => -byOld(a, b));
    const atrasados = abertos.filter((c) => urgency(c) === 'late').length;
    const resp = avgResponse();
    const list = S.filtro === 'abertos' ? [...abertos, ...caminho] : feitos;
    const pedidos = pendentes().sort(byOld);

    const empty = S.filtro === 'abertos'
      ? `<div class="empty"><span class="empty-ico">${icon('bell')}</span><h2>Nenhuma mesa chamando</h2>
          <p>Quando um cliente segurar o sino na página da mesa, você ouve um aviso e o chamado aparece aqui.</p>
          ${isDemo ? `<div class="vhead-actions"><button type="button" class="btn btn-cobalt" data-demo="simular">${icon('sparkle')} Simular um chamado</button>
            <a class="btn btn-line" href="/?mesa=7" target="_blank" rel="noopener">${icon('external')} Abrir a mesa 7</a></div>` : ''}</div>`
      : `<div class="empty"><span class="empty-ico">${icon('inbox')}</span><h2>Nada concluído ainda</h2><p>Os chamados resolvidos nas últimas 16 horas aparecem aqui.</p></div>`;

    return `
      <div class="vhead"><div><h1>Chamados</h1><p>Mais antigos primeiro. Toque em “Estou indo” para a mesa saber que alguém está a caminho.</p></div>
        ${isDemo ? `<div class="vhead-actions"><button type="button" class="btn btn-line btn-sm" data-demo="simular">${icon('sparkle')} Simular chamado</button></div>` : ''}</div>
      <dl class="strip">
        <div class="${abertos.length || pedidos.length ? 'is-alert' : ''}"><dt>Aguardando</dt><dd>${abertos.length + pedidos.length}</dd></div>
        <div><dt>A caminho</dt><dd>${caminho.length}</dd></div>
        <div class="${atrasados ? 'is-alert' : ''}"><dt>Mais de ${LATE} min</dt><dd>${atrasados}</dd></div>
        <div><dt>Resposta média</dt><dd>${resp ? `${resp.v}<small>${resp.u}</small>` : '—'}</dd></div>
      </dl>
      <div class="board">
        <div>
          ${pedidos.length ? `<section class="pedidos" aria-labelledby="hPedidos">
            <h2 id="hPedidos">Pedindo para usar o sino <small>Libere só quem está mesmo na mesa</small></h2>
            <div class="calls">${pedidos.map(sessCard).join('')}</div>
          </section>` : ''}
          <div class="toolbar">
            <div class="seg" role="radiogroup" aria-label="Filtrar chamados">
              <button type="button" role="radio" aria-checked="${S.filtro === 'abertos'}" data-filtro="abertos">Em aberto (${abertos.length + caminho.length})</button>
              <button type="button" role="radio" aria-checked="${S.filtro === 'feitos'}" data-filtro="feitos">Concluídos (${feitos.length})</button>
            </div>
          </div>
          ${list.length ? `<div class="calls">${list.map(callCard).join('')}</div>` : empty}
        </div>
        <aside class="rail" aria-label="Mesas agora"><h2>Mesas agora</h2>${mesasGrid(1, S.settings.mesas.total)}
          <div class="legend"><span><i class="l-call"></i>Chamando</span><span><i class="l-go"></i>A caminho</span><span><i class="l-occ"></i>Ocupada</span></div></aside>
      </div>`;
  }

  /* ---------- Salão ---------- */
  function mesaState(n) {
    const ativos = S.calls.filter((c) => c.mesa === n && (c.status === 'aberto' || c.status === 'a_caminho'));
    const aberto = ativos.find((c) => c.status === 'aberto');
    const pedindo = pendentes().some((x) => x.mesa === n);
    const pessoas = pessoasNa(n);
    return {
      st: aberto || pedindo ? 'aberto' : ativos.length ? 'a_caminho' : pessoas.length ? 'ocupada' : 'livre',
      call: aberto || ativos[0], pedindo, pessoas, hoje: S.calls.filter((c) => c.mesa === n).length,
    };
  }
  function mesasGrid(de, ate) {
    let h = '<div class="mesas">';
    for (let n = de; n <= ate; n++) {
      const s = mesaState(n);
      const label = s.st === 'aberto' ? (s.call ? `Chamando · <span data-since="${s.call.criado_em}">${clock(s.call.criado_em)}</span>` : 'Pede o sino')
        : s.st === 'a_caminho' ? `${esc(firstName(s.call.atendente))} a caminho`
        : s.st === 'ocupada' ? `${s.pessoas.length} ${s.pessoas.length === 1 ? 'pessoa' : 'pessoas'}`
        : s.hoje ? `${s.hoje} ${s.hoje === 1 ? 'chamado' : 'chamados'} hoje` : 'Livre';
      h += `<button type="button" class="mesa" data-mesa="${n}" data-st="${s.st}" aria-label="Mesa ${n}"><span class="mesa-n">${pad(n)}</span><span class="mesa-st">${label}</span></button>`;
    }
    return h + '</div>';
  }
  function vSalao() {
    return `<div class="vhead"><div><h1>Salão</h1><p>Toque em uma mesa para ver quem está nela, os chamados de hoje e fechar a mesa.</p></div>
        <div class="legend"><span><i class="l-call"></i>Chamando</span><span><i class="l-go"></i>A caminho</span><span><i class="l-occ"></i>Ocupada</span><span><i></i>Livre</span></div></div>
      ${S.settings.mesas.areas.map((a) => {
        let n = 0;
        for (let i = a.de; i <= a.ate; i++) if (mesaState(i).st === 'aberto') n++;
        return `<section class="area"><h2>${esc(a.nome)} <small>Mesas ${a.de}–${a.ate}${n ? ` · ${n} chamando` : ''}</small></h2>${mesasGrid(a.de, a.ate)}</section>`;
      }).join('')}`;
  }

  function renderMesaSheet(n) {
    $('#mesaTitle').textContent = `Mesa ${pad(n)}`;
    const calls = S.calls.filter((c) => c.mesa === n).sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em));
    const pessoas = pessoasNa(n);
    const pedindo = pendentes().filter((x) => x.mesa === n);
    const placas = S.etiquetas.filter((e) => e.mesa === n);
    $('#mesaBody').innerHTML = `<div class="stack">
      <p class="muted">${esc(areaDe(n))}${areaDe(n) ? ' · ' : ''}${calls.length} ${calls.length === 1 ? 'chamado' : 'chamados'} nas últimas 16 horas</p>
      <section class="mesa-gente">
        <div class="mesa-gente-head"><h3>Na mesa agora</h3>${codigoDa(n) ? `<span class="mesa-cod">Código <b class="mono">${codigoDa(n)}</b></span>` : ''}</div>
        ${pessoas.length || pedindo.length ? `<ul class="gente">
          ${pessoas.map((p) => `<li><span class="avatar" aria-hidden="true">${esc((firstName(p.nome)[0] || '?').toUpperCase())}</span><div><b>${esc(p.nome)}</b><small>Sino liberado ${ago(p.liberada_em || p.criado_em)}${p.via === 'codigo' ? ' · pelo código da mesa' : p.liberada_por ? ` · por ${esc(firstName(p.liberada_por))}` : ''}</small></div></li>`).join('')}
          ${pedindo.map((p) => `<li class="is-pend"><span class="avatar" aria-hidden="true">${esc((firstName(p.nome)[0] || '?').toUpperCase())}</span><div><b>${esc(p.nome)}</b><small>Pede para usar o sino · ${ago(p.criado_em)}</small></div>
            <span class="gente-acts"><button type="button" class="btn btn-cobalt btn-sm" data-sess-ok="${p.id}">Liberar</button><button type="button" class="btn btn-quiet btn-sm" data-sess-no="${p.id}">Recusar</button></span></li>`).join('')}
        </ul>` : '<p class="note">Ninguém com o sino liberado. Quando o cliente pedir, o pedido aparece em Chamados.</p>'}
        ${codigoDa(n) ? '<small class="help">Quem está na mesa pode passar o código para os acompanhantes: com ele, o sino libera sem precisar da equipe.</small>' : ''}
        ${pessoas.length || pedindo.length ? `<button type="button" class="btn btn-danger btn-block" data-fechar="${n}">${icon('lock')} Fechar mesa</button>` : ''}
      </section>
      ${calls.length ? `<div class="calls">${calls.map(callCard).join('')}</div>` : '<p class="note">Esta mesa ainda não fez chamados hoje.</p>'}
      <p class="muted" style="font-size:13px">${placas.length ? `Plaquinha${placas.length > 1 ? 's' : ''}: ${placas.map((e) => `<span class="mono">${esc(e.codigo)}</span>`).join(', ')}` : 'Nenhuma plaquinha ligada a esta mesa.'}</p>
      <div class="vhead-actions">
        <a class="btn btn-line btn-sm" href="${esc(tableUrl(n))}" target="_blank" rel="noopener">${icon('external')} Abrir página da mesa</a>
      </div></div>`;
  }

  /* ---------- Comentários ---------- */
  const starsHtml = (n) => `<span class="st" aria-label="${n} de 5 estrelas">${[1, 2, 3, 4, 5].map((i) => icon('star', i <= n ? 'on' : 'off')).join('')}</span>`;
  function vComentarios() {
    const all = S.fb;
    const total = all.length;
    const avg = total ? all.reduce((s, f) => s + f.estrelas, 0) / total : 0;
    const dist = [5, 4, 3, 2, 1].map((n) => ({ n, c: all.filter((f) => f.estrelas === n).length }));
    const max = Math.max(1, ...dist.map((d) => d.c));
    const tagMap = {};
    all.forEach((f) => (f.tags || []).forEach((t) => (tagMap[t] = (tagMap[t] || 0) + 1)));
    const tags = Object.entries(tagMap).sort((a, b) => b[1] - a[1]);
    const naoLidos = all.filter((f) => !f.lido).length;
    const list = all.filter((f) => (S.fbFiltro === 'nao-lidos' ? !f.lido : S.fbFiltro === 'baixas' ? f.estrelas <= 3 : true));

    return `<div class="vhead"><div><h1>Comentários</h1><p>Enviados de forma anônima pelos clientes. Nenhum dado pessoal é coletado.</p></div>
        ${naoLidos ? `<div class="vhead-actions"><button type="button" class="btn btn-line btn-sm" data-fb="todos-lidos">${icon('check')} Marcar todos como lidos</button></div>` : ''}</div>
      ${total ? `<div class="fb-sum">
        <div class="panel avg"><h2>Nota média</h2><strong>${avg.toFixed(1).replace('.', ',')}</strong>${starsHtml(Math.round(avg))}<small>${total} ${total === 1 ? 'comentário' : 'comentários'}</small></div>
        <div class="panel"><h2>Distribuição</h2><div class="dist">${dist.map((d) => `<div class="dist-row"><span>${d.n}★</span><span class="dist-bar"><i style="width:${(d.c / max) * 100}%"></i></span><span>${d.c}</span></div>`).join('')}</div></div>
        <div class="panel"><h2>O que mais citam</h2>${tags.length ? `<div class="tagcount">${tags.map(([t, c]) => `<span>${esc(t)}<b>${c}</b></span>`).join('')}</div>` : '<p class="muted">Sem marcações ainda.</p>'}</div>
      </div>
      <div class="toolbar"><div class="seg" role="radiogroup" aria-label="Filtrar comentários">
        <button type="button" role="radio" aria-checked="${S.fbFiltro === 'todos'}" data-fbf="todos">Todos</button>
        <button type="button" role="radio" aria-checked="${S.fbFiltro === 'nao-lidos'}" data-fbf="nao-lidos">Não lidos (${naoLidos})</button>
        <button type="button" role="radio" aria-checked="${S.fbFiltro === 'baixas'}" data-fbf="baixas">Até 3★</button>
      </div></div>
      ${list.length ? `<div class="fb-list">${list.map((f) => `<article class="fcard ${f.lido ? '' : 'is-unread'}">
          <div class="fcard-top">${starsHtml(f.estrelas)}<span>${ago(f.criado_em)}</span></div>
          ${(f.tags || []).length ? `<div class="tagcount">${f.tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
          ${f.texto ? `<p>${esc(f.texto)}</p>` : '<p class="muted">Sem texto — apenas a nota.</p>'}
          <div class="fcard-foot"><span>${f.mesa ? `Mesa ${pad(f.mesa)}` : 'Mesa não informada'}${f.estrelas <= 2 ? ' · <span class="fcard-low">Atenção</span>' : ''}</span>
            ${f.lido ? '<span>Lido</span>' : `<button type="button" data-fb="lido" data-id="${f.id}">Marcar como lido</button>`}</div>
        </article>`).join('')}</div>`
        : `<div class="empty"><span class="empty-ico">${icon('inbox')}</span><h2>Nada por aqui</h2><p>Nenhum comentário neste filtro.</p></div>`}`
      : `<div class="empty"><span class="empty-ico">${icon('msg')}</span><h2>Nenhum comentário ainda</h2><p>Os clientes enviam pelo botão “Comentário anônimo” na página da mesa. As notas e textos aparecem aqui.</p>
          ${isDemo ? `<div class="vhead-actions"><button type="button" class="btn btn-line" data-demo="comentario">${icon('sparkle')} Simular comentário</button></div>` : ''}</div>`}`;
  }

  /* ---------- Mesas e plaquinhas ---------- */
  // As plaquinhas saem de fábrica com um código (NFC e QR iguais) que passa
  // pelo redirecionador central e chega aqui como /?tag=CODIGO. Na primeira
  // leitura, alguém da equipe escolhe a mesa; depois o código abre direto.
  // Links públicos: pelo domínio próprio quando ele está no ar (window.VTX_ORIGEM), senão por este endereço.
  const tableUrl = (n) => new URL(`/?mesa=${n}`, window.VTX_ORIGEM || location.origin).href;
  const tagUrl = (codigo) => new URL(`/?tag=${encodeURIComponent(codigo)}`, window.VTX_ORIGEM || location.origin).href;
  const normCodigo = (c) => String(c || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const placasDa = (n) => S.etiquetas.filter((e) => e.mesa === n);

  function vPlaquinhas() {
    const total = S.settings.mesas.total;
    const semPlaca = [];
    for (let n = 1; n <= total; n++) if (!placasDa(n).length) semPlaca.push(n);
    const foraDoTotal = S.etiquetas.filter((e) => e.mesa > total);
    const semMesa = S.etiquetas.filter((e) => !e.mesa && !e.comanda);
    const comandas = S.etiquetas.filter((e) => e.comanda).sort((a, b) => a.comanda - b.comanda);
    const areas = S.settings.mesas.areas;
    const areaErro = areas.map((a, i) => erroDaArea(a, areas, i, total)).find(Boolean);
    const mesasCfg = `<div class="panel stack" id="mesasCfg">
        <h2>Quantidade de mesas</h2>
        <label class="field" style="max-width:220px"><span>Total no restaurante</span>
          <input class="input mono" id="totalMesas" type="number" min="1" max="${Math.min(300, S.settings.plano.mesas)}" value="${total}"></label>
        ${S.settings.plano.mesas < 500 ? `<p class="help">Seu plano tem ${S.settings.plano.mesas} mesas. Para usar mais, <button type="button" class="link" data-cfg-ir="plano">aumente no Plano</button>.</p>` : ''}
        <h2 style="margin-top:6px">Áreas do salão</h2>
        <p class="muted" style="font-size:13px">Dê nome aos grupos de mesa (salão, varanda, mezanino…). Uma mesa fora de qualquer faixa aparece sem área.</p>
        ${areaErro ? `<p class="area-erro" role="alert">${icon('alert')} <span>${esc(areaErro)} Corrija a faixa abaixo.</span></p>` : ''}
        <div class="arows">${areas.map((a, i) => `<div class="arow ${erroDaArea(a, areas, i, total) ? 'is-erro' : ''}" data-area-idx="${i}">
            <input class="input" data-afield="nome" value="${esc(a.nome)}" placeholder="Nome da área" aria-label="Nome da área">
            <input class="input mono" data-afield="de" type="number" min="1" max="${total}" value="${a.de}" aria-label="Primeira mesa da área">
            <span class="arow-sep">–</span>
            <input class="input mono" data-afield="ate" type="number" min="1" max="${total}" value="${a.ate}" aria-label="Última mesa da área">
            <button type="button" class="icon-btn" data-area="del" aria-label="Remover área">${icon('trash')}</button>
          </div>`).join('') || '<p class="muted">Nenhuma área cadastrada — todas as mesas aparecem sem nome.</p>'}</div>
        <button type="button" class="btn btn-line btn-sm" data-area="add">${icon('plus')} Adicionar área</button>
      </div>`;
    const linhas = [];
    for (let n = 1; n <= total; n++) {
      const placas = placasDa(n);
      linhas.push(`<li class="prow ${placas.length ? '' : 'is-vazia'}">
        <div class="mini-plate"><small>Mesa</small><b>${pad(n)}</b></div>
        <div class="prow-body"><b>${placas.length ? placas.map((e) => `<span class="mono">${esc(e.codigo)}</span>`).join(' · ') : 'Sem plaquinha'}</b>
          <small>${esc(areaDe(n))}${placas.length ? `${areaDe(n) ? ' · ' : ''}ligada ${ago(placas[0].vinculada_em)}${placas[0].vinculada_por ? ` por ${esc(firstName(placas[0].vinculada_por))}` : ''}` : ''}</small></div>
        <span class="prow-acts">
          ${placas.map((e) => `<button type="button" class="btn btn-quiet btn-sm" data-placa="${esc(e.codigo)}" aria-label="Alterar plaquinha ${esc(e.codigo)}">${icon('edit')}<span>Alterar</span></button>`).join('')}
          <a class="btn btn-quiet btn-sm" href="${esc(tableUrl(n))}" target="_blank" rel="noopener" aria-label="Abrir a página da mesa ${n}">${icon('external')}</a>
        </span>
      </li>`);
    }
    return `<div class="vhead"><div><h1>Mesas</h1><p>Quantidade de mesas, áreas do salão e qual plaquinha está em cada mesa.</p></div></div>
      ${mesasCfg}
      <div class="howto">
        <div class="panel stack"><h2>Como ligar uma plaquinha a uma mesa</h2>
          <ol>
            <li>Cole a plaquinha na mesa.</li>
            <li>Encoste o celular nela (ou aponte a câmera para o QR). Na primeira vez aparece <strong>Plaquinha nova</strong>.</li>
            <li>Digite o <strong>endereço do restaurante</strong> (só na primeira plaquinha: o celular lembra para as próximas).</li>
            <li>Entre com seu PIN e escolha o número da mesa.</li>
            <li>Pronto: daí em diante, a plaquinha abre direto a página dessa mesa.</li>
          </ol>
          <small class="help">As plaquinhas já vêm gravadas e bloqueadas. Não é preciso app nenhum para configurar.</small>
        </div>
        <form class="panel stack" id="placaManual" novalidate><h2>Ligar pelo código</h2>
          <p class="muted" style="font-size:13px">Sem o celular por perto? Digite o código impresso no verso da plaquinha.</p>
          <div class="placa-manual">
            <label class="field"><span>Código</span><input class="input mono" id="pmCodigo" maxlength="16" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="K7P2QXA"></label>
            <label class="field"><span>Mesa</span><input class="input mono" id="pmMesa" type="number" min="1" max="${total}" inputmode="numeric"></label>
            <label class="field"><span>ou Comanda</span><input class="input mono" id="pmComanda" type="number" min="1" max="9999" inputmode="numeric"></label>
          </div>
          <button type="submit" class="btn btn-cobalt btn-sm">${icon('check')} Ligar plaquinha</button>
        </form>
      </div>
      <div class="toolbar"><p class="muted" style="font-size:14px">${S.etiquetas.length} ${S.etiquetas.length === 1 ? 'plaquinha ligada' : 'plaquinhas ligadas'}${semPlaca.length ? ` · ${semPlaca.length} ${semPlaca.length === 1 ? 'mesa sem plaquinha' : 'mesas sem plaquinha'}` : ''}</p></div>
      ${semMesa.length ? `<div class="note">${icon('nfc')}<span><b>${semMesa.length === 1 ? 'Plaquinha ativada sem mesa' : `${semMesa.length} plaquinhas ativadas sem mesa`}:</b>
        ${semMesa.map((e) => `<button type="button" class="link-cod mono" data-placa="${esc(e.codigo)}">${esc(e.codigo)}</button>`).join(' ')} · toque para escolher a mesa.</span></div>` : ''}
      ${foraDoTotal.length ? `<p class="note">${icon('msg')}<span>${foraDoTotal.length === 1 ? 'Uma plaquinha está ligada' : `${foraDoTotal.length} plaquinhas estão ligadas`} a mesa acima do total (${foraDoTotal.map((e) => `${esc(e.codigo)} → ${e.mesa}`).join(', ')}). Aumente o total ou altere a plaquinha.</span></p>` : ''}
      <ul class="plist">${linhas.join('')}</ul>
      <div class="panel stack comandas-box">
        <h2>Comandas individuais</h2>
        <p class="muted" style="font-size:13px">A mesma plaquinha serve de comanda: uma por pessoa (no happy hour da ${esc(nomeHH())}, por exemplo). Lida pelo cliente, abre a página com o número da comanda; lida pelo garçom logado durante a ${esc(nomeHH())}, soma o chopp no relógio.</p>
        ${comandas.length ? `<ul class="comandas">${comandas.map((e) => `<li><button type="button" class="comanda-chip" data-placa="${esc(e.codigo)}" aria-label="Alterar a comanda ${e.comanda}">
            <small>Comanda</small><b>${pad(e.comanda)}</b><span class="mono">${esc(e.codigo)}</span></button></li>`).join('')}</ul>`
          : '<p class="muted">Nenhuma comanda ainda. Leia uma plaquinha nova (ou toque no código de uma sem mesa) e escolha <b>Comanda</b>.</p>'}
      </div>`;
  }
  const nomeHH = () => (S.settings.prorrogacao && S.settings.prorrogacao.nome) || 'Prorrogação';
  const proximaComanda = () => { const usadas = new Set(S.etiquetas.map((e) => e.comanda).filter(Boolean)); let n = 1; while (usadas.has(n)) n++; return n; };

  /* Áreas do salão: faixas dentro do total e sem mesa em duas áreas. */
  function erroDaArea(a, areas, i, total) {
    if (!(a.de >= 1 && a.ate >= 1)) return 'Use números de mesa a partir de 1.';
    if (a.de > total || a.ate > total) return `O restaurante tem ${total} mesas: a faixa vai no máximo até a mesa ${total}.`;
    if (a.de > a.ate) return 'A primeira mesa da faixa precisa ser menor ou igual à última.';
    const outra = areas.find((b, j) => j !== i && a.de <= b.ate && b.de <= a.ate);
    if (outra) {
      const de = Math.max(a.de, outra.de), ate = Math.min(a.ate, outra.ate);
      return `${de === ate ? `A mesa ${de} já está` : `As mesas ${de} a ${ate} já estão`} em “${outra.nome}”. Cada mesa fica em uma área só.`;
    }
    return '';
  }
  // Primeira sequência de mesas sem área (para o botão "Adicionar área").
  function faixaLivre(areas, total) {
    const ocupada = (n) => areas.some((a) => n >= a.de && n <= a.ate);
    let de = 1;
    while (de <= total && ocupada(de)) de++;
    if (de > total) return null;
    let ate = de;
    while (ate < total && !ocupada(ate + 1)) ate++;
    return { de, ate };
  }

  const saveMesas = (patch) => saveSettings({ mesas: { ...S.settings.mesas, ...patch } });

  /* Ligar uma plaquinha a uma mesa: aberto pela leitura da plaquinha (?vincular=) ou pela lista. */
  let vincCodigo = null;
  let vincMesa = null;
  // 'mesa' ou 'comanda' (plaquinha individual).
  let vincTipo = 'mesa';
  let vincComanda = null;
  function abrirVincular(codigo) {
    vincCodigo = normCodigo(codigo);
    const atual = S.etiquetas.find((e) => e.codigo === vincCodigo);
    vincMesa = atual ? atual.mesa : null;
    vincTipo = atual && atual.comanda ? 'comanda' : 'mesa';
    vincComanda = atual && atual.comanda ? atual.comanda : null;
    renderVincular();
    openSheet('sh-vincular');
  }
  function renderVincular() {
    const atual = S.etiquetas.find((e) => e.codigo === vincCodigo);
    const total = S.settings.mesas.total;
    let grid = '';
    for (let n = 1; n <= total; n++) {
      const outras = placasDa(n).filter((e) => e.codigo !== vincCodigo).length;
      grid += `<button type="button" class="vmesa" data-vmesa="${n}" aria-pressed="${vincMesa === n}" ${outras ? 'data-tem="1"' : ''}>
        <b>${pad(n)}</b>${outras ? '<small>já tem</small>' : areaDe(n) ? `<small>${esc(areaDe(n))}</small>` : ''}</button>`;
    }
    $('#vincTitle').textContent = atual ? 'Alterar plaquinha' : 'Plaquinha nova';
    const hoje = atual && atual.comanda ? ` · hoje é a comanda <b>${atual.comanda}</b>` : atual && atual.mesa ? ` · hoje na mesa <b>${atual.mesa}</b>` : '';
    const tipos = `<div class="seg vinc-tipo" role="radiogroup" aria-label="Usar como">
        <button type="button" role="radio" aria-checked="${vincTipo === 'mesa'}" data-vtipo="mesa">${icon('grid')} Mesa</button>
        <button type="button" role="radio" aria-checked="${vincTipo === 'comanda'}" data-vtipo="comanda">${icon('ticket')} Comanda individual</button></div>`;
    if (vincTipo === 'comanda') {
      const n = vincComanda || proximaComanda();
      $('#vincBody').innerHTML = `<div class="stack">
        <p class="vinc-cod">Código <b class="mono">${esc(vincCodigo)}</b>${hoje}</p>
        ${tipos}
        <p class="muted">A plaquinha vira a comanda de uma pessoa. Cada número é de uma plaquinha só.</p>
        <label class="field"><span>Número da comanda</span><input class="input mono vinc-comanda" id="vincComanda" type="number" min="1" max="9999" inputmode="numeric" value="${n}"></label>
        <button type="button" class="btn btn-cobalt btn-block" data-vinc="comanda">${icon('check')} Ligar como comanda</button>
        ${atual && (atual.mesa || atual.comanda) ? `<button type="button" class="btn btn-line btn-block" data-vinc="soltar">Desligar a plaquinha</button>` : ''}
      </div>`;
      return;
    }
    $('#vincBody').innerHTML = `<div class="stack">
      <p class="vinc-cod">Código <b class="mono">${esc(vincCodigo)}</b>${hoje}</p>
      ${tipos}
      <p class="muted">Em qual mesa esta plaquinha está colada?</p>
      <div class="vmesas">${grid}</div>
      <button type="button" class="btn btn-cobalt btn-block" data-vinc="salvar" ${vincMesa ? '' : 'disabled'}>${icon('check')} ${vincMesa ? `Ligar à mesa ${vincMesa}` : 'Escolha a mesa'}</button>
      ${atual && (atual.mesa || atual.comanda) ? `<button type="button" class="btn btn-line btn-block" data-vinc="soltar">${atual.mesa ? 'Desligar desta mesa' : 'Desligar a plaquinha'}</button>` : ''}
      <small class="help">Uma mesa pode ter mais de uma plaquinha (por exemplo, uma em cada ponta).</small>
    </div>`;
  }
  async function salvarVinculo() {
    if (!vincCodigo || !vincMesa) return;
    const codigo = vincCodigo;
    const mesa = vincMesa;
    try {
      await store.vincularEtiqueta(codigo, mesa, S.user.nome);
      closeSheet();
      toast(`Plaquinha ligada à mesa ${mesa}.`, { tone: 'ok', ms: 6000, action: { label: 'Testar', run: () => window.open(tagUrl(codigo), '_blank', 'noopener') } });
      queueRefresh();
    } catch (e) {
      console.error(e);
      toast(e.message && !/fetch|network/i.test(e.message) ? e.message : 'Não foi possível salvar. Verifique a conexão.', { tone: 'error', ms: 4500 });
    }
  }
  async function salvarComanda() {
    const n = parseInt(($('#vincComanda') || {}).value, 10);
    if (!(n >= 1 && n <= 9999)) return toast('Digite o número da comanda (1 a 9999).', { tone: 'error' });
    const codigo = vincCodigo;
    try {
      await store.vincularComanda(codigo, n, S.user.nome);
      closeSheet();
      toast(`Plaquinha ligada como comanda ${n}.`, { tone: 'ok', ms: 6000, action: { label: 'Testar', run: () => window.open(tagUrl(codigo), '_blank', 'noopener') } });
      queueRefresh();
    } catch (e) {
      console.error(e);
      toast(e.message && !/fetch|network/i.test(e.message) ? e.message : 'Não foi possível salvar. Verifique a conexão.', { tone: 'error', ms: 4500 });
    }
  }
  async function soltarVinculo() {
    if (!confirm(`Desligar a plaquinha ${vincCodigo}? Ela continua do restaurante e volta a aparecer como “Plaquinha nova” até ser ligada a outra mesa.`)) return;
    try {
      await store.desvincularEtiqueta(vincCodigo);
      closeSheet();
      toast('Plaquinha desligada da mesa.');
      queueRefresh();
    } catch (e) {
      console.error(e);
      toast('Não foi possível salvar. Verifique a conexão.', { tone: 'error' });
    }
  }


  /* ---------- Salvar configuração ---------- */
  let savedT;
  function markSaved() {
    const el = $('#saveState');
    if (!el) return;
    el.innerHTML = `${icon('check')} Salvo`;
    el.classList.add('is-on');
    clearTimeout(savedT);
    savedT = setTimeout(() => el.classList.remove('is-on'), 2200);
  }
  async function saveSettings(patch) {
    Object.assign(S.settings, patch);
    try {
      await store.updateSettings(patch);
      markSaved();
      return true;
    } catch (e) {
      console.error(e);
      toast(/espaço|plano/i.test(e.message || '') ? e.message : 'Não foi possível salvar. Confira a conexão e tente de novo.', { tone: 'error', ms: 4500 });
      return false;
    }
  }
  // Cores sugeridas para a marca; a primeira é o roxo padrão do sistema.
  const CORES = ['#7d27fc', '#1b3a9e', '#0f766e', '#15803d', '#b45309', '#c2410c', '#b91c1c', '#be185d', '#3f3f46'];
  const corAtual = () => (/^#[0-9a-f]{6}$/i.test(S.settings.restaurante.cor || '') ? S.settings.restaurante.cor.toLowerCase() : UI.COR_PADRAO);
  async function salvarCor(cor) {
    UI.aplicarCor(cor);
    await saveRestaurante({ cor: cor === UI.COR_PADRAO ? '' : cor });
    renderView();
  }
  const saveRestaurante = (patch) => saveSettings({ restaurante: { ...S.settings.restaurante, ...patch } });

  /* ---------- Widgets do cliente ---------- */
  const WIDGET_ICON = { info: 'pin', fidelidade: 'gift', cardapio: 'book', wifi: 'wifi', dividir: 'users', google: 'star', comentario: 'msg' };
  const WIDGET_LABEL = { info: 'Informações do restaurante', fidelidade: 'Programa de fidelidade', cardapio: 'Cardápio', wifi: 'Wi-Fi', dividir: 'Dividir a conta', google: 'Avaliar no Google', comentario: 'Comentário anônimo' };
  const WIDGET_ICONS = [
    ['link', 'Link'], ['book', 'Livro'], ['star', 'Estrela'], ['msg', 'Mensagem'], ['wifi', 'Wi-Fi'],
    ['users', 'Pessoas'], ['printer', 'Impressora'], ['qr', 'QR'], ['sparkle', 'Destaque'],
    ['pin', 'Local'], ['clock', 'Horário'], ['instagram', 'Instagram'],
  ];
  function builtinSub(tipo) {
    const r = S.settings.restaurante;
    if (tipo === 'cardapio') {
      const n = S.settings.cardapio.reduce((s, c) => s + c.itens.length, 0);
      return n ? `${n} ${n === 1 ? 'item' : 'itens'} · edite na aba Cardápio` : 'Sem itens: não aparece para o cliente · monte na aba Cardápio';
    }
    if (tipo === 'wifi') return S.settings.wifi && S.settings.wifi.rede ? `Rede ${S.settings.wifi.rede} · edite na aba Restaurante` : 'Rede não informada: não aparece para o cliente · preencha na aba Restaurante';
    if (tipo === 'google') return r.googleUrl ? 'Link de avaliação configurado' : 'Sem link: não aparece para o cliente · cole o link na aba Restaurante';
    if (tipo === 'info') {
      const tem = infoPreenchida();
      return tem.length ? `${tem.join(', ')} · edite na aba Restaurante` : 'Nada preenchido ainda · preencha na aba Restaurante';
    }
    if (tipo === 'dividir') return `Serviço de ${Number(r.taxaServico) || 0}%`;
    if (tipo === 'comentario') return 'Chega na aba Comentários';
    if (tipo === 'fidelidade') return (S.settings.fidelidade || {}).ativo ? 'Regras e prêmios na aba Fidelidade' : 'Pausado: coloque no ar na aba Fidelidade';
    return '';
  }

  function widgetRow(w, i, total) {
    const label = w.label || WIDGET_LABEL[w.tipo] || 'Widget';
    const sub = w.tipo === 'link' ? w.sub || w.url || '' : builtinSub(w.tipo);
    return `<li class="wrow" data-widx="${i}">
      <span class="wrow-order">
        <button type="button" class="icon-btn" data-w="up" ${i === 0 ? 'disabled' : ''} aria-label="Mover ${esc(label)} para cima">${icon('chevronUp')}</button>
        <button type="button" class="icon-btn" data-w="down" ${i === total - 1 ? 'disabled' : ''} aria-label="Mover ${esc(label)} para baixo">${icon('chevronDown')}</button>
      </span>
      <span class="tile-ico ico-cobalt">${icon(w.tipo === 'link' ? w.icone || 'link' : WIDGET_ICON[w.tipo])}</span>
      <div class="wrow-body"><b>${esc(label)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>
      ${!w.embutido ? `<span class="wrow-actions">
        <button type="button" class="icon-btn" data-w="edit" aria-label="Editar ${esc(label)}">${icon('edit')}</button>
        <button type="button" class="icon-btn" data-w="del" aria-label="Excluir ${esc(label)}">${icon('trash')}</button>
      </span>` : ''}
      <label class="switch"><input type="checkbox" data-w="toggle" ${w.ativo !== false ? 'checked' : ''} aria-label="Mostrar ${esc(label)} para o cliente"><span></span></label>
    </li>`;
  }

  function widgetForm() {
    if (S.widgetEdit === null) return `<button type="button" class="btn btn-line btn-sm" data-w="novo">${icon('plus')} Adicionar widget personalizado</button>`;
    const editing = typeof S.widgetEdit === 'number';
    const w = editing ? S.settings.widgets[S.widgetEdit] : { label: '', sub: '', url: '', icone: 'link' };
    return `<form class="stack widget-form" id="widgetForm">
      <label class="field"><span>Título</span><input class="input" id="wLabel" required maxlength="40" value="${esc(w.label)}" placeholder="Ex.: Carta de vinhos"></label>
      <label class="field"><span>Subtítulo (opcional)</span><input class="input" id="wSub" maxlength="60" value="${esc(w.sub || '')}" placeholder="Ex.: rótulos da semana"></label>
      <label class="field"><span>Link</span><input class="input" id="wUrl" type="url" required value="${esc(w.url || '')}" placeholder="https://…"></label>
      <label class="field"><span>Ícone</span><select class="input" id="wIcone">${WIDGET_ICONS.map(([v, l]) => `<option value="${v}" ${w.icone === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="vhead-actions">
        <button type="submit" class="btn btn-cobalt btn-sm">${editing ? 'Salvar widget' : 'Adicionar widget'}</button>
        <button type="button" class="btn btn-quiet btn-sm" data-w="cancelar">Cancelar</button>
      </div>
    </form>`;
  }

  const saveWidgets = (list) => saveSettings({ widgets: list });
  function moveWidget(i, dir) {
    const list = S.settings.widgets.slice();
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    saveWidgets(list).then(renderView);
  }
  function deleteWidget(i) {
    if (!confirm('Remover este widget da página da mesa?')) return;
    const list = S.settings.widgets.slice();
    list.splice(i, 1);
    saveWidgets(list).then(renderView);
  }

  /* ---------- Ajustes ---------- */
  const AJ_TABS = [
    { id: 'restaurante', label: 'Restaurante', intro: 'Nome, logo, capa, endereço, redes, Wi-Fi e horários. O que você salvar aqui aparece na hora para os clientes.' },
    { id: 'cardapio', label: 'Cardápio', intro: 'Categorias e pratos que o cliente vê no cardápio da mesa.' },
    { id: 'widgets', label: 'Widgets', intro: 'Escolha o que aparece na página da mesa e em que ordem.' },
    { id: 'aparelho', label: 'Aparelho', intro: 'Preferências deste aparelho. Cada pessoa da equipe ajusta o seu.' },
    { id: 'endereco', label: 'Endereço', intro: 'O endereço do site do restaurante. O incluso funciona sempre; se quiser, conecte o domínio do restaurante e o sistema confere e ativa sozinho.' },
    { id: 'plano', label: 'Plano', intro: 'Serviços e mesas contratados. Aumente ou diminua aqui: a mudança vale na hora e a nova mensalidade entra na próxima cobrança.' },
  ];
  const DIAS = [[1, 'Segunda'], [2, 'Terça'], [3, 'Quarta'], [4, 'Quinta'], [5, 'Sexta'], [6, 'Sábado'], [0, 'Domingo']];

  function vAjustes() {
    const tab = AJ_TABS.find((t) => t.id === S.ajTab) || AJ_TABS[0];
    const body = { restaurante: ajRestaurante, cardapio: ajCardapio, widgets: ajWidgets, aparelho: ajAparelho, endereco: ajEndereco, plano: ajPlano }[tab.id]();
    return `<div class="vhead"><div><h1>Ajustes</h1><p>${tab.intro}</p></div><span class="save-state" id="saveState" role="status"></span></div>
      <div class="aj-tabs" role="tablist" aria-label="Seções de ajustes">
        ${AJ_TABS.map((t) => `<button type="button" role="tab" aria-selected="${t.id === tab.id}" data-aj="${t.id}">${t.label}</button>`).join('')}
      </div>
      ${body}`;
  }

  /* Restaurante */
  function brandPreview() {
    const r = S.settings.restaurante;
    const logo = safeUrl(r.logo);
    const capa = safeUrl(r.capa);
    return `<div class="bp-cover ${capa ? 'has-img' : ''}" ${capa ? `style="background-image:url('${esc(capa)}')"` : ''}></div>
      <div class="bp-row">
        <div class="bp-logo ${logo ? '' : 'is-initials'}">${logo ? `<img src="${esc(logo)}" alt="">` : esc(initials(r.nome))}</div>
        <div class="bp-id"><b>${esc(r.nome)}</b>${r.descricao ? `<small>${esc(r.descricao)}</small>` : ''}</div>
        <div class="bp-plate"><small>Mesa</small><b>12</b></div>
      </div>`;
  }
  const horaDo = (d) => {
    const h = (S.settings.restaurante.horarios || []).find((x) => x.dias.includes(d));
    return h ? { on: true, abre: h.abre, fecha: h.fecha } : { on: false, abre: '18:00', fecha: '23:00' };
  };
  function salvarHorarios(mudar) {
    const dias = {};
    for (const [d] of DIAS) dias[d] = horaDo(d);
    mudar(dias);
    const grupos = {};
    for (const [d] of DIAS) {
      const h = dias[d];
      if (!h.on) continue;
      const k = `${h.abre}|${h.fecha}`;
      (grupos[k] = grupos[k] || { dias: [], abre: h.abre, fecha: h.fecha }).dias.push(d);
    }
    return saveRestaurante({ horarios: Object.values(grupos) });
  }

  function ajRestaurante() {
    const r = S.settings.restaurante;
    const w = S.settings.wifi;
    const aberta = w.seguranca === 'nopass';
    const logo = safeUrl(r.logo);
    const capa = safeUrl(r.capa);
    const fileBtn = (tipo, tem) => `<label class="btn btn-line btn-sm file-btn">${icon('upload')} ${tem ? 'Trocar' : 'Enviar'}
        <input type="file" class="sr-only" accept="image/jpeg,image/png,image/webp" data-img="${tipo}"></label>
      ${tem ? `<button type="button" class="btn btn-line btn-sm" data-img-del="${tipo}">Remover</button>` : ''}`;

    return `<div class="aj-grid">
      <section class="panel stack aj-brand" aria-labelledby="hMarca">
        <h2 id="hMarca">Logo, capa e cor</h2>
        <div class="brand-preview" id="brandPreview">${brandPreview()}</div>
        <div class="img-slots">
          <div class="img-slot"><div><b>Foto de capa</b><small>Foto horizontal do salão ou de um prato. A imagem é ajustada sozinha.</small></div>
            <div class="vhead-actions">${fileBtn('capa', capa)}</div></div>
          <div class="img-slot"><div><b>Logo</b><small>Imagem quadrada; aparece dentro do círculo.</small></div>
            <div class="vhead-actions">${fileBtn('logo', logo)}</div></div>
          <div class="img-slot cor-slot"><div><b>Cor principal</b><small>Botões, placa da mesa e destaques. Cores muito claras ficam um pouco mais escuras para o texto continuar legível.</small></div>
            <div class="vhead-actions">
              <div class="cor-opcoes" role="group" aria-label="Cores sugeridas">${CORES.map((c) => `<button type="button" class="cor-bola" data-cor="${c}" style="background:${c}" aria-label="Usar a cor ${c}" aria-pressed="${corAtual() === c}"></button>`).join('')}
                <label class="cor-bola cor-livre" title="Outra cor" aria-pressed="${!CORES.includes(corAtual())}" style="${CORES.includes(corAtual()) ? '' : `background:${corAtual()}`}">${icon('plus')}<input type="color" class="sr-only" data-cor-livre value="${corAtual()}" aria-label="Escolher outra cor"></label>
              </div>
              ${corAtual() !== UI.COR_PADRAO ? '<button type="button" class="btn btn-line btn-sm" data-cor="padrao">Voltar ao roxo padrão</button>' : ''}
            </div></div>
        </div>
        <a class="btn btn-line aj-view" href="/?mesa=1" target="_blank" rel="noopener">${icon('external')} Ver a página da mesa como o cliente</a>
      </section>

      <section class="panel stack" aria-labelledby="hInfo">
        <h2 id="hInfo">Informações</h2>
        <label class="field"><span>Nome do restaurante</span><input class="input" data-r="nome" required maxlength="40" value="${esc(r.nome)}" autocomplete="organization"></label>
        <label class="field"><span>Frase curta (opcional)</span><input class="input" data-r="descricao" maxlength="60" value="${esc(r.descricao || '')}" placeholder="Ex.: Cozinha de brasa e horta"></label>
        <label class="field"><span>Endereço</span><input class="input" data-r="endereco" maxlength="120" value="${esc(r.endereco || '')}" placeholder="Rua, número — bairro, cidade" autocomplete="street-address"></label>
        <label class="field"><span>Telefone ou WhatsApp</span><input class="input" data-r="telefone" type="tel" inputmode="tel" maxlength="20" value="${esc(r.telefone || '')}" placeholder="(31) 99999-9999" autocomplete="tel"></label>
        <label class="field"><span>Instagram</span><input class="input" data-r="instagram" maxlength="80" value="${esc(instagramHandle(r.instagram) ? '@' + instagramHandle(r.instagram) : '')}" placeholder="@seurestaurante" autocapitalize="off" spellcheck="false"></label>
        <label class="field"><span>Link de avaliação do Google</span><input class="input" data-r="googleUrl" type="url" value="${esc(r.googleUrl || '')}" placeholder="https://g.page/r/…/review" spellcheck="false">
          <small class="help">No Perfil da Empresa no Google, toque em “Pedir avaliações” e cole o link aqui. Sem link, o botão abre a busca do Google pelo nome do restaurante.</small></label>
        <label class="field field-narrow"><span>Taxa de serviço (%)</span><input class="input mono" data-r="taxaServico" type="number" min="0" max="30" step="1" inputmode="numeric" value="${Number(r.taxaServico) || 0}">
          <small class="help">Usada na calculadora “Dividir a conta”.</small></label>
      </section>

      <div class="aj-col">
        <section class="panel stack" aria-labelledby="hWifi">
          <h2 id="hWifi">Wi-Fi dos clientes</h2>
          <label class="field"><span>Nome da rede</span><input class="input" data-wf="rede" maxlength="32" value="${esc(w.rede || '')}" autocapitalize="off" spellcheck="false"></label>
          <label class="field"><span>Senha</span><input class="input mono" data-wf="senha" maxlength="63" value="${esc(aberta ? '' : w.senha || '')}" ${aberta ? 'disabled placeholder="Rede sem senha"' : ''} autocapitalize="off" autocomplete="off" spellcheck="false"></label>
          <label class="set-inline"><span>Rede aberta, sem senha</span><span class="switch"><input type="checkbox" data-wf="aberta" ${aberta ? 'checked' : ''}><span></span></span></label>
        </section>

        <section class="panel stack" aria-labelledby="hEquipe">
          <h2 id="hEquipe">Equipe</h2>
          <ul class="team-list" id="teamList"><li class="muted">Carregando…</li></ul>
          <form class="team-add stack" id="meuEmailForm" novalidate>
            <h3>Seu e-mail para recuperar o PIN</h3>
            <p class="help">Se esquecer o PIN, toque em “Esqueci meu PIN” na entrada do painel: mandamos um código para este e-mail e você cria um PIN novo sozinho.</p>
            <div class="team-add-row">
              <label class="field"><span>E-mail</span><input class="input" name="email" id="meuEmail" type="email" maxlength="120" autocomplete="email" placeholder="voce@email.com"></label>
            </div>
            <button type="submit" class="btn btn-line btn-sm">${icon('check')} Salvar e-mail</button>
          </form>
          ${S.user.admin ? `<form class="team-add stack" id="teamAddForm" novalidate>
            <h3>Cadastrar pessoa</h3>
            <div class="team-add-row">
              <label class="field"><span>Nome</span><input class="input" name="nome" maxlength="60" autocomplete="off" required></label>
              <label class="field"><span>PIN (4 a 8 números)</span><input class="input mono" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="new-password" required></label>
            </div>
            <label class="set-inline"><span>Também é administrador</span><span class="switch"><input type="checkbox" name="admin"><span></span></span></label>
            <button type="submit" class="btn btn-cobalt btn-sm">${icon('plus')} Cadastrar</button>
          </form>
          <small class="help">Passe o PIN para a pessoa: ela entra só com ele. Ou passe o código da equipe: ela mesma cria a conta em “Criar conta” e entra como equipe.</small>
          <form class="team-add stack" id="teamCodigoForm" novalidate>
            <h3>Código da equipe</h3>
            <p class="help">Quem tiver o código cria a própria conta no painel (entra como equipe, nunca como administrador). Trocar o código não tira ninguém que já tem conta.</p>
            <div class="team-add-row">
              <label class="field"><span>Novo código</span><input class="input mono" name="codigo" type="password" minlength="6" maxlength="40" autocomplete="new-password" required></label>
              <label class="field"><span>Repita o código</span><input class="input mono" name="codigo2" type="password" minlength="6" maxlength="40" autocomplete="new-password" required></label>
            </div>
            <button type="submit" class="btn btn-line btn-sm">${icon('lock')} Trocar o código</button>
          </form>
          <div class="team-add stack">
            <h3>Aparelhos</h3>
            <p class="help">Cada aparelho entra uma vez com o código da equipe e depois só com o PIN. Perdeu um celular ou alguém saiu da equipe? Desconecte todos: cada aparelho volta a pedir o código na próxima entrada.</p>
            <button type="button" class="btn btn-line btn-sm" data-esquecer-aparelhos>${icon('logout')} Desconectar todos os aparelhos</button>
          </div>`
          : '<small class="help">Quem cadastra e remove pessoas é o administrador do restaurante. Você pode trocar o seu PIN.</small>'}
        </section>
      </div>

      ${S.user.admin ? `<section class="panel stack" aria-labelledby="hAvisos">
        <h2 id="hAvisos">Avisos por e-mail</h2>
        <p class="help">Para onde a VTX manda os avisos do restaurante. Só o administrador muda.</p>
        <form class="stack" id="avisosForm" novalidate>
          <label class="field"><span>E-mail dos avisos</span><input class="input" name="email" type="email" maxlength="120" autocomplete="email" placeholder="gerencia@seurestaurante.com.br"></label>
          <label class="set-inline"><span>Novo cliente no clube</span><span class="switch"><input type="checkbox" name="novo_cliente"><span></span></span></label>
          <label class="set-inline"><span>Novo pedido no delivery</span><span class="switch"><input type="checkbox" name="novo_pedido"><span></span></span></label>
          <label class="set-inline"><span>E-mail de boas-vindas para quem entra no clube</span><span class="switch"><input type="checkbox" name="boas_vindas"><span></span></span></label>
          <button type="submit" class="btn btn-line btn-sm">${icon('check')} Salvar avisos</button>
        </form>
      </section>` : ''}

      <section class="panel stack" aria-labelledby="hHoras">
        <h2 id="hHoras">Horário de funcionamento</h2>
        <div class="hours-edit">${DIAS.map(([d, nome]) => {
          const h = horaDo(d);
          return `<div class="hrow ${h.on ? '' : 'is-off'}" data-dia="${d}">
            <label class="switch"><input type="checkbox" data-h-on ${h.on ? 'checked' : ''} aria-label="Abre na ${nome}"><span></span></label>
            <span class="hrow-dia">${nome}</span>
            ${h.on ? `<span class="hrow-times"><input class="input mono" type="time" data-hk="abre" value="${esc(h.abre)}" aria-label="${nome}: abre às">
              <span class="arow-sep">às</span>
              <input class="input mono" type="time" data-hk="fecha" value="${esc(h.fecha)}" aria-label="${nome}: fecha às"></span>` : '<span class="hrow-off">Fechado</span>'}
          </div>`;
        }).join('')}</div>
        <small class="help">Pode fechar depois da meia-noite: por exemplo, das 18:00 às 01:00.</small>
      </section>
    </div>`;
  }

  /* Equipe: quem tem conta no painel. Só o administrador cadastra, remove e troca o PIN dos outros. */
  async function carregarEquipe() {
    const alvo = () => $('#teamList');
    if (!alvo()) return;
    try {
      const lista = await store.auth.membros();
      if (!alvo()) return;
      const eu = lista.find((m) => m.voce);
      if (eu && $('#meuEmail') && !$('#meuEmail').value) $('#meuEmail').value = eu.email || '';
      if ($('#avisosForm') && !$('#avisosForm').dataset.ok) {
        $('#avisosForm').dataset.ok = '1';
        store.meusAvisos().then((a) => {
          const f = $('#avisosForm');
          if (!f) return;
          f.elements.email.value = a.email || '';
          f.elements.novo_cliente.checked = a.novo_cliente !== false;
          f.elements.novo_pedido.checked = !!a.novo_pedido;
          f.elements.boas_vindas.checked = a.boas_vindas !== false;
        }).catch(() => {});
      }
      const adm = !!S.user.admin;
      alvo().innerHTML = lista.length
        ? lista.map((m) => `<li class="team-row">
            <span class="avatar" aria-hidden="true">${esc((firstName(m.nome)[0] || '?').toUpperCase())}</span>
            <div class="team-id"><b>${esc(m.nome)}</b><small>${m.admin ? 'Administrador · ' : ''}Desde ${new Date(m.criado_em).toLocaleDateString('pt-BR')}</small></div>
            <div class="team-acts">
              ${m.voce ? '<span class="state-tag">Você</span>' : ''}
              ${m.voce || adm ? `<button type="button" class="btn btn-quiet btn-sm" data-membro-pin="${esc(m.id)}" data-nome="${esc(m.nome)}" data-voce="${m.voce ? 1 : ''}">Trocar PIN</button>` : ''}
              ${adm && !m.voce ? `<button type="button" class="btn btn-quiet btn-sm" data-membro-adm="${esc(m.id)}" data-nome="${esc(m.nome)}" data-admin="${m.admin ? 1 : ''}">${m.admin ? 'Tirar admin' : 'Tornar admin'}</button>
                <button type="button" class="btn btn-line btn-sm" data-membro-del="${esc(m.id)}" data-nome="${esc(m.nome)}">Remover</button>` : ''}
            </div>
          </li>`).join('')
        : '<li class="muted">Ninguém cadastrado ainda.</li>';
    } catch (e) {
      if (alvo()) alvo().innerHTML = `<li class="form-error">${esc(e.message)}</li>`;
    }
  }
  const pedirPin = (quem) => {
    const pin = prompt(`Novo PIN ${quem} (4 a 8 números):`);
    if (pin == null) return null;
    if (!/^\d{4,8}$/.test(pin.trim())) { toast('O PIN precisa ter de 4 a 8 números.', { tone: 'error' }); return null; }
    return pin.trim();
  };
  document.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-membro-del]');
    const pinB = e.target.closest('[data-membro-pin]');
    const adm = e.target.closest('[data-membro-adm]');
    const b = del || pinB || adm;
    if (!b) return;
    try {
      if (del) {
        if (!confirm(`Remover ${b.dataset.nome} da equipe? A pessoa perde o acesso ao painel na hora.`)) return;
        b.disabled = true;
        await store.auth.remover(b.dataset.membroDel);
        toast(`${b.dataset.nome} foi removido da equipe.`, { tone: 'ok' });
      } else if (pinB) {
        const pin = pedirPin(pinB.dataset.voce ? 'para você' : `de ${b.dataset.nome}`);
        if (!pin) return;
        b.disabled = true;
        await store.auth.trocarPin(pinB.dataset.voce ? null : pinB.dataset.membroPin, pin);
        toast(pinB.dataset.voce ? 'Seu PIN foi trocado.' : `PIN de ${b.dataset.nome} trocado. Avise a pessoa.`, { tone: 'ok', ms: 4000 });
      } else {
        const vira = !adm.dataset.admin;
        if (!confirm(vira ? `Tornar ${b.dataset.nome} administrador? Ele poderá cadastrar e remover pessoas e mudar o plano.` : `Tirar ${b.dataset.nome} de administrador?`)) return;
        b.disabled = true;
        await store.auth.definirAdmin(adm.dataset.membroAdm, vira);
        toast(vira ? `${b.dataset.nome} agora é administrador.` : `${b.dataset.nome} deixou de ser administrador.`, { tone: 'ok' });
      }
    } catch (ex) {
      toast(ex.message, { tone: 'error', ms: 4500 });
    }
    carregarEquipe();
  });
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-esquecer-aparelhos]');
    if (!b) return;
    if (!confirm('Desconectar todos os aparelhos? Na próxima entrada, cada um pede o código da equipe junto com o PIN. Quem está usando agora continua até sair.')) return;
    b.disabled = true;
    try {
      await store.auth.esquecerAparelhos();
      toast('Aparelhos desconectados. Na próxima entrada, cada um pede o código da equipe.', { tone: 'ok', ms: 5000 });
    } catch (ex) {
      toast(ex.message, { tone: 'error', ms: 4500 });
    }
    b.disabled = false;
  });
  document.addEventListener('submit', async (e) => {
    if (!['meuEmailForm', 'avisosForm'].includes(e.target.id)) return;
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      if (f.id === 'meuEmailForm') {
        await store.auth.meuEmail(f.elements.email.value.trim());
        toast(f.elements.email.value.trim() ? 'E-mail salvo. Se esquecer o PIN, o código vai para ele.' : 'E-mail de recuperação removido.', { tone: 'ok' });
      } else {
        await store.salvarAvisos({ email: f.elements.email.value.trim(), novo_cliente: f.elements.novo_cliente.checked,
          novo_pedido: f.elements.novo_pedido.checked, boas_vindas: f.elements.boas_vindas.checked });
        toast('Avisos salvos.', { tone: 'ok' });
      }
    } catch (ex) {
      toast(ex.message, { tone: 'error', ms: 4500 });
    }
    btn.disabled = false;
  });
  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'teamCodigoForm') return;
    e.preventDefault();
    const f = e.target;
    const codigo = f.elements.codigo.value;
    if (codigo.length < 6) return toast('O código da equipe precisa ter pelo menos 6 caracteres.', { tone: 'error' });
    if (codigo !== f.elements.codigo2.value) return toast('Os dois códigos não estão iguais. Digite de novo.', { tone: 'error' });
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await store.auth.trocarSenha(codigo);
      f.reset();
      toast('Código da equipe trocado. Passe o novo código para quem ainda vai criar a conta.', { tone: 'ok', ms: 5000 });
    } catch (ex) {
      toast(ex.message, { tone: 'error', ms: 4500 });
    }
    btn.disabled = false;
  });
  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'teamAddForm') return;
    e.preventDefault();
    const f = e.target;
    const nome = f.elements.nome.value.trim();
    const pin = f.elements.pin.value.trim();
    if (!nome) return toast('Informe o nome da pessoa.', { tone: 'error' });
    if (!/^\d{4,8}$/.test(pin)) return toast('O PIN precisa ter de 4 a 8 números.', { tone: 'error' });
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await store.auth.adicionar({ nome, pin, admin: f.elements.admin.checked });
      f.reset();
      toast(`${nome} foi cadastrado. Passe o PIN para a pessoa entrar.`, { tone: 'ok', ms: 4500 });
      carregarEquipe();
    } catch (ex) {
      toast(ex.message, { tone: 'error', ms: 4500 });
    }
    btn.disabled = false;
  });

  async function prepararImagem(file, tipo) {
    if (!/^image\//.test(file.type)) throw new Error('Escolha uma imagem JPG, PNG ou WebP.');
    const src = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, fail) => {
        const i = new Image();
        i.onload = () => ok(i);
        i.onerror = () => fail(new Error('Não foi possível abrir essa imagem. Tente outra.'));
        i.src = src;
      });
      let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight, w, h;
      if (tipo === 'logo' || tipo === 'premio') {
        const lado = Math.min(sw, sh);
        sx = (sw - lado) / 2;
        sy = (sh - lado) / 2;
        sw = sh = lado;
        w = h = Math.min(tipo === 'premio' ? 720 : 480, lado);
      } else {
        const k = Math.min(1, (isDemo ? 1280 : 1800) / sw);
        w = Math.round(sw * k);
        h = Math.round(sh * k);
      }
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
      const toBlob = (type, q) => new Promise((ok) => c.toBlob(ok, type, q));
      let blob = await toBlob('image/webp', 0.85);
      // Navegadores sem WebP devolvem PNG: para fotos, JPEG fica bem menor.
      if (!blob || (blob.type !== 'image/webp' && tipo === 'capa')) blob = await toBlob('image/jpeg', 0.84);
      if (!blob) throw new Error('Não foi possível processar essa imagem.');
      return blob;
    } finally {
      URL.revokeObjectURL(src);
    }
  }
  async function enviarImagem(input) {
    const tipo = input.dataset.img;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    const slot = input.closest('.img-slot');
    slot && slot.classList.add('is-busy');
    try {
      const blob = await prepararImagem(file, tipo);
      const url = await store.uploadImage(blob, tipo);
      if (await saveRestaurante({ [tipo]: url })) toast(tipo === 'logo' ? 'Logo atualizada.' : 'Foto de capa atualizada.', { tone: 'ok' });
    } catch (e) {
      console.error(e);
      toast(e.message && !/fetch|network/i.test(e.message) ? e.message : 'Não foi possível enviar a imagem. Tente de novo.', { tone: 'error', ms: 4500 });
    }
    renderView();
    renderChrome();
  }

  /* Cardápio */
  function ajCardapio() {
    const cats = S.settings.cardapio;
    const selos = (it) =>
      `${it.destaque ? '<span class="tag tag--casa">Da casa</span>' : ''}${(it.tags || []).map((t) => `<span class="tag">${esc(cfg.tags[t] || t)}</span>`).join('')}`;
    return `<div class="stack menu-edit">
      ${planilhaPainel()}
      ${cats.length ? '' : `<div class="empty"><span class="empty-ico">${icon('book')}</span><h2>Cardápio vazio</h2><p>Crie uma categoria (Entradas, Pratos, Bebidas…) e adicione os pratos.</p></div>`}
      ${cats.map((c, ci) => `<section class="panel mc" data-ci="${ci}" aria-label="Categoria ${esc(c.nome)}">
        <div class="mc-head">
          <input class="input mc-name" data-cat-name value="${esc(c.nome)}" maxlength="40" aria-label="Nome da categoria">
          <span class="mc-count">${c.itens.length} ${c.itens.length === 1 ? 'item' : 'itens'}</span>
          <span class="wrow-order">
            <button type="button" class="icon-btn" data-cat-move="-1" ${ci === 0 ? 'disabled' : ''} aria-label="Subir categoria ${esc(c.nome)}">${icon('chevronUp')}</button>
            <button type="button" class="icon-btn" data-cat-move="1" ${ci === cats.length - 1 ? 'disabled' : ''} aria-label="Descer categoria ${esc(c.nome)}">${icon('chevronDown')}</button>
          </span>
          <button type="button" class="icon-btn mc-del" data-cat-del aria-label="Excluir categoria ${esc(c.nome)}">${icon('trash')}</button>
        </div>
        ${c.itens.length ? `<ul class="mc-items">${c.itens.map((it, ii) => `<li class="mc-item" data-ii="${ii}">
            <button type="button" class="mc-open" data-item-edit aria-label="Editar ${esc(it.nome)}">
              <span class="mc-body"><b>${esc(it.nome)}</b>${it.desc ? `<small>${esc(it.desc)}</small>` : ''}<span class="tags">${selos(it)}${it.delivery ? `<span class="tag tag--delivery">${it.salao === false ? 'Só delivery' : 'Delivery'}</span>` : ''}${(it.grupos || []).length ? `<span class="tag">${it.grupos.length} ${it.grupos.length === 1 ? 'grupo' : 'grupos'} de opções</span>` : ''}</span></span>
              <span class="price">${Store.opcoes.temVariacao(it) ? '<small>a partir de</small> ' : ''}${brl(Store.opcoes.aPartir(it))}</span>
              <span class="mc-edit">${icon('edit')}</span>
            </button>
            <span class="wrow-order">
              <button type="button" class="icon-btn" data-item-move="-1" ${ii === 0 ? 'disabled' : ''} aria-label="Subir ${esc(it.nome)}">${icon('chevronUp')}</button>
              <button type="button" class="icon-btn" data-item-move="1" ${ii === c.itens.length - 1 ? 'disabled' : ''} aria-label="Descer ${esc(it.nome)}">${icon('chevronDown')}</button>
            </span>
          </li>`).join('')}</ul>` : '<p class="muted mc-empty">Nenhum prato nesta categoria ainda.</p>'}
        <button type="button" class="btn btn-quiet btn-sm" data-item-add>${icon('plus')} Adicionar prato</button>
      </section>`).join('')}
      <button type="button" class="btn btn-cobalt mc-add" data-cat-add>${icon('plus')} Nova categoria</button>
    </div>`;
  }
  const saveCardapio = (cats) => saveSettings({ cardapio: cats });
  const cloneMenu = () => S.settings.cardapio.map((c) => ({ ...c, itens: c.itens.slice() }));
  const parsePreco = (v) => {
    const s = String(v || '').replace(/[^\d,.]/g, '');
    const n = parseFloat(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
  };

  /* Cardápio por planilha: baixar o modelo, importar e conferir antes de gravar. */
  function planilhaPainel() {
    const imp = S.importacao;
    if (!imp) return `<section class="panel planilha">
        <div><h2>Cardápio por planilha</h2><p class="muted">Baixe o modelo, preencha no Excel ou no Google Planilhas (ou peça para uma IA preencher) e importe aqui.</p></div>
        <div class="planilha-acts">
          <button type="button" class="btn btn-line btn-sm" data-planilha-modelo>${icon('download')} Baixar modelo</button>
          <label class="btn btn-cobalt btn-sm">${icon('upload')} Importar planilha<input type="file" accept=".xlsx,.xls,.csv,.ods" class="sr-only" data-planilha-arq></label>
        </div>
      </section>`;
    const nItens = imp.categorias.reduce((t, c) => t + c.itens.length, 0);
    const nDel = imp.categorias.reduce((t, c) => t + c.itens.filter((i) => i.delivery).length, 0);
    return `<section class="panel planilha stack">
        <h2>Conferir a importação</h2>
        <p><b>${nItens}</b> ${nItens === 1 ? 'item' : 'itens'} em <b>${imp.categorias.length}</b> ${imp.categorias.length === 1 ? 'categoria' : 'categorias'}${nDel ? ` · ${nDel} no delivery` : ''} · arquivo ${esc(imp.arquivo)}</p>
        <ul class="planilha-cats">${imp.categorias.map((c) => `<li><b>${esc(c.nome)}</b> <span class="muted">${c.itens.length} ${c.itens.length === 1 ? 'item' : 'itens'}: ${esc(c.itens.slice(0, 4).map((i) => i.nome).join(', '))}${c.itens.length > 4 ? '…' : ''}</span></li>`).join('')}</ul>
        ${imp.erros.length ? `<div class="planilha-erros"><b>${imp.erros.length} ${imp.erros.length === 1 ? 'linha ficou' : 'linhas ficaram'} de fora:</b><ul>${imp.erros.slice(0, 8).map((e) => `<li>${esc(e)}</li>`).join('')}${imp.erros.length > 8 ? `<li>e mais ${imp.erros.length - 8}…</li>` : ''}</ul></div>` : ''}
        <div class="seg planilha-modo" role="radiogroup" aria-label="Como importar">
          <button type="button" role="radio" aria-checked="${imp.modo === 'somar'}" data-planilha-modo="somar">Somar ao cardápio atual</button>
          <button type="button" role="radio" aria-checked="${imp.modo === 'trocar'}" data-planilha-modo="trocar">Trocar o cardápio todo</button>
        </div>
        <small class="help">${imp.modo === 'somar' ? 'Itens com o mesmo nome na mesma categoria são atualizados; os novos entram no fim.' : 'O cardápio atual é apagado e fica só o que está na planilha.'}</small>
        <div class="vhead-actions">
          <button type="button" class="btn btn-cobalt" data-planilha-ok ${nItens ? '' : 'disabled'}>${icon('check')} Importar ${nItens} ${nItens === 1 ? 'item' : 'itens'}</button>
          <button type="button" class="btn btn-quiet" data-planilha-cancelar>Cancelar</button>
        </div>
      </section>`;
  }
  const chaveNome = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  function aplicarImportacao(imp) {
    const novo = (it) => ({ id: uid(), ...it });
    if (imp.modo === 'trocar') return imp.categorias.map((c) => ({ id: uid(), nome: c.nome, itens: c.itens.map(novo) }));
    const cats = cloneMenu();
    for (const c of imp.categorias) {
      let alvo = cats.find((x) => chaveNome(x.nome) === chaveNome(c.nome));
      if (!alvo) cats.push((alvo = { id: uid(), nome: c.nome, itens: [] }));
      for (const it of c.itens) {
        const i = alvo.itens.findIndex((x) => chaveNome(x.nome) === chaveNome(it.nome));
        if (i >= 0) alvo.itens[i] = { ...alvo.itens[i], ...it };
        else alvo.itens.push(novo(it));
      }
    }
    return cats;
  }
  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-planilha-modelo]')) {
      try {
        await Planilha.baixarModelo();
      } catch (ex) {
        toast(ex.message, { tone: 'error' });
      }
      return;
    }
    const modo = t.closest('[data-planilha-modo]');
    if (modo && S.importacao) {
      S.importacao.modo = modo.dataset.planilhaModo;
      return renderView();
    }
    if (t.closest('[data-planilha-cancelar]')) {
      S.importacao = null;
      return renderView();
    }
    const ok = t.closest('[data-planilha-ok]');
    if (ok && S.importacao) {
      const imp = S.importacao;
      if (imp.modo === 'trocar' && S.settings.cardapio.length && !confirm('Trocar o cardápio todo pelo da planilha? O cardápio atual será apagado.')) return;
      ok.disabled = true;
      const n = imp.categorias.reduce((t2, c) => t2 + c.itens.length, 0);
      if (await saveCardapio(aplicarImportacao(imp))) {
        S.importacao = null;
        toast(`${n} ${n === 1 ? 'item importado' : 'itens importados'} para o cardápio.`, { tone: 'ok', ms: 4000 });
      } else ok.disabled = false;
      renderView();
    }
  });
  document.addEventListener('change', async (e) => {
    if (!e.target.matches('[data-planilha-arq]')) return;
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const r = await Planilha.ler(f, cfg.tags);
      if (!r.total) return toast(r.erros[0] || 'A planilha não tem itens. Preencha a partir da segunda linha.', { tone: 'error', ms: 5000 });
      S.importacao = { ...r, arquivo: f.name, modo: S.settings.cardapio.length ? 'somar' : 'trocar' };
      renderView();
    } catch (ex) {
      console.error(ex);
      toast(ex.message || 'Não foi possível ler a planilha.', { tone: 'error', ms: 5000 });
    }
  });

  /* Opções do item: grupos "escolha uma" (tamanho, carne…) e "adicionais" (com quantidade). */
  const fmtPreco = (v) => (+v ? String(Number(v).toFixed(2)).replace('.', ',') : '');
  function gruposHtml() {
    return S.itemGrupos.map((g, i) => `<fieldset class="it-grupo" data-gi="${i}">
      <div class="it-grupo-top">
        <input class="input" data-gk="nome" maxlength="40" value="${esc(g.nome || '')}" placeholder="Ex.: Tamanho" aria-label="Nome do grupo">
        <select class="input" data-gk="tipo" aria-label="Tipo do grupo"><option value="escolha" ${g.tipo !== 'extras' ? 'selected' : ''}>Escolha uma</option><option value="extras" ${g.tipo === 'extras' ? 'selected' : ''}>Adicionais</option></select>
        <button type="button" class="icon-btn" data-g-del="${i}" aria-label="Tirar o grupo">${icon('trash')}</button>
      </div>
      ${g.tipo === 'extras'
        ? `<div class="it-grupo-lim"><label class="field"><span>Mínimo</span><input class="input mono" data-gk="min" type="number" min="0" max="20" value="${+g.min || 0}"></label>
            <label class="field"><span>Máximo (0 = sem limite)</span><input class="input mono" data-gk="max" type="number" min="0" max="50" value="${+g.max || 0}"></label></div>`
        : `<label class="check"><input type="checkbox" data-gk="obrig" ${+g.min >= 1 ? 'checked' : ''}> <span>Obrigatório escolher</span></label>`}
      <textarea class="textarea mono" data-gk="opcoes" rows="${Math.min(8, Math.max(3, (g.opcoes || []).length + 1))}" placeholder="${g.tipo === 'extras' ? 'Ovo frito = 3,00&#10;Bacon = 5,00' : 'Pequeno&#10;Grande = 3,00'}">${esc((g.opcoes || []).map((o) => `${o.nome}${+o.preco ? ` = ${fmtPreco(o.preco)}` : ''}`).join('\n'))}</textarea>
      <small class="help">Uma opção por linha. Depois do "=", quanto soma ao preço do item (sem "=" não muda o preço).</small>
    </fieldset>`).join('') || '<p class="muted" style="font-size:13.5px">Sem opções: o cliente pede o item como está.</p>';
  }
  // Lê os grupos da tela, mantendo os códigos das opções que já existiam (o carrinho dos clientes usa esses códigos).
  function lerGrupos() {
    const box = $('#itGrupos');
    if (!box) return S.itemGrupos;
    return [...box.querySelectorAll('.it-grupo')].map((fs) => {
      const antigo = S.itemGrupos[+fs.dataset.gi] || {};
      const v = (k) => fs.querySelector(`[data-gk="${k}"]`);
      const tipo = v('tipo').value === 'extras' ? 'extras' : 'escolha';
      const opcoes = v('opcoes').value.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 40).map((l) => {
        const [nome, preco] = l.split('=');
        const n = nome.trim().slice(0, 60);
        const velho = (antigo.opcoes || []).find((o) => o.nome === n);
        return { id: velho ? velho.id : uid(), nome: n, preco: Math.max(0, parsePreco(preco || '0') || 0) };
      }).filter((o) => o.nome);
      // Ao trocar o tipo, os campos do outro tipo ainda não existem na tela: usa o valor antigo.
      const num = (k, pad) => (v(k) ? Math.max(0, +v(k).value || 0) : +antigo[k] || pad);
      return { id: antigo.id || uid(), nome: v('nome').value.trim().slice(0, 40), tipo,
        min: tipo === 'extras' ? (v('min') ? num('min', 0) : 0) : v('obrig') ? (v('obrig').checked ? 1 : 0) : 1,
        max: tipo === 'extras' ? (v('max') ? num('max', 0) : 0) : 1, opcoes };
    });
  }
  const redesenharGrupos = () => { S.itemGrupos = lerGrupos(); $('#itGrupos').innerHTML = gruposHtml(); };
  function fotoItemHtml() {
    return `${S.itemFoto ? `<img src="${esc(S.itemFoto)}" alt="">` : ''}
      <label class="btn btn-line btn-sm">${icon('upload')} ${S.itemFoto ? 'Trocar foto' : 'Enviar foto'}<input type="file" accept="image/*" class="sr-only" data-item-foto></label>
      ${S.itemFoto ? `<button type="button" class="btn btn-quiet btn-sm" data-item-foto-del>Tirar foto</button>` : ''}`;
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#itemForm')) return;
    if (e.target.closest('[data-g-add]')) {
      S.itemGrupos = lerGrupos();
      S.itemGrupos.push({ id: uid(), nome: '', tipo: 'escolha', min: 1, max: 1, opcoes: [] });
      $('#itGrupos').innerHTML = gruposHtml();
      const n = $$('#itGrupos [data-gk="nome"]').pop();
      return n && n.focus();
    }
    const del = e.target.closest('[data-g-del]');
    if (del) {
      S.itemGrupos = lerGrupos();
      S.itemGrupos.splice(+del.dataset.gDel, 1);
      return ($('#itGrupos').innerHTML = gruposHtml());
    }
    if (e.target.closest('[data-item-foto-del]')) {
      S.itemFoto = '';
      $('#itFotoBox').innerHTML = fotoItemHtml();
    }
  });
  document.addEventListener('change', async (e) => {
    if (e.target.matches('#itemForm [data-gk="tipo"]')) return redesenharGrupos();
    if (!e.target.matches('[data-item-foto]')) return;
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const box = $('#itFotoBox');
    box.classList.add('is-busy');
    try {
      S.itemFoto = await store.uploadImage(await prepararImagem(f, 'premio'), 'item');
    } catch (ex) {
      toast(ex.message && !/fetch|network/i.test(ex.message) ? ex.message : 'Não foi possível enviar a foto.', { tone: 'error' });
    }
    box.classList.remove('is-busy');
    box.innerHTML = fotoItemHtml();
  });

  function openItem(ci, ii) {
    S.itemEdit = { ci, ii };
    const editing = ii != null;
    const it = editing ? S.settings.cardapio[ci].itens[ii] : { nome: '', desc: '', preco: '', tags: [], destaque: false };
    S.itemGrupos = JSON.parse(JSON.stringify(it.grupos || []));
    S.itemFoto = it.foto || '';
    $('#itemTitle').textContent = editing ? 'Editar prato' : 'Novo prato';
    $('#itemBody').innerHTML = `<form class="stack" id="itemForm" novalidate>
      <label class="field"><span>Nome</span><input class="input" id="itNome" required maxlength="60" value="${esc(it.nome)}" placeholder="Ex.: Mandioca na brasa"></label>
      <label class="field"><span>Descrição (opcional)</span><textarea class="textarea" id="itDesc" maxlength="320" rows="3" placeholder="Ingredientes, porção, acompanhamentos">${esc(it.desc || '')}</textarea></label>
      <div class="item-row">
        <label class="field"><span>Preço</span><div class="money"><span>R$</span><input class="input mono" id="itPreco" inputmode="decimal" required value="${it.preco === '' ? '' : String(Number(it.preco).toFixed(2)).replace('.', ',')}" placeholder="0,00"></div></label>
        <label class="field"><span>Categoria</span><select class="input" id="itCat">${S.settings.cardapio.map((c, i) => `<option value="${i}" ${i === ci ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select></label>
      </div>
      <div class="field"><span>Selos</span><div class="chips-wrap">${Object.entries(cfg.tags).map(([k, l]) => `<button type="button" class="chip" data-selo="${k}" aria-pressed="${(it.tags || []).includes(k)}">${esc(l)}</button>`).join('')}</div></div>
      <label class="set-inline"><span>Destaque da casa<small>Mostra o selo “Da casa” no prato.</small></span><span class="switch"><input type="checkbox" id="itDestaque" ${it.destaque ? 'checked' : ''}><span></span></span></label>
      <label class="set-inline"><span>Disponível no delivery<small>O item também aparece no cardápio de entrega.</small></span><span class="switch"><input type="checkbox" id="itDelivery" ${it.delivery ? 'checked' : ''}><span></span></span></label>
      <label class="set-inline"><span>Só no delivery<small>Não aparece no cardápio da mesa (ex.: bebidas com preço de entrega).</small></span><span class="switch"><input type="checkbox" id="itSoDelivery" ${it.salao === false ? 'checked' : ''}><span></span></span></label>
      <div class="field"><span>Foto (opcional)</span><div class="it-foto" id="itFotoBox">${fotoItemHtml()}</div></div>
      <div class="field"><span>Opções do item</span>
        <p class="help">Tamanhos, sabores, ponto da carne, adicionais… O cliente escolhe na hora de pedir.</p>
        <div id="itGrupos" class="stack">${gruposHtml()}</div>
        <button type="button" class="btn btn-quiet btn-sm" data-g-add>${icon('plus')} Adicionar grupo de opções</button></div>
      <p class="form-error" id="itErr" role="alert"></p>
      <div class="vhead-actions">
        <button type="submit" class="btn btn-cobalt">${editing ? 'Salvar prato' : 'Adicionar prato'}</button>
        ${editing ? `<button type="button" class="btn btn-danger" id="itemDel">${icon('trash')} Excluir</button>` : ''}
      </div>
    </form>`;
    openSheet('sh-item');
    setTimeout(() => !editing && $('#itNome').focus(), 80);
  }

  /* Este aparelho */
  const temaAtual = () => get('nfc-tema-painel') || 'light';
  /* Endereço: domínio próprio (ex.: cardapio.seurestaurante.com.br), configurado pelo próprio restaurante.
     O painel mostra o registro DNS a criar e confere sozinho a cada 20 s (função "dominio"); o roteador de
     domínios põe a rota e o certificado HTTPS no Traefik. Situações: dns → certificado → ativo. */
  const DOM_PASSOS = [['dns', 'Registro no DNS'], ['certificado', 'Certificado HTTPS'], ['ativo', 'No ar']];
  const DOM_ROTULO = { dns: 'Aguardando o DNS', certificado: 'Gerando o certificado', ativo: 'No ar' };
  let domTimer = 0;
  async function carregarDominio(silencioso) {
    clearTimeout(domTimer);
    try {
      S.dom = await store.dominioVerificar();
      if (S.dom.status === 'ativo' && S.dom.dominio) window.VTX_ORIGEM = `https://${S.dom.dominio}`;
      else window.VTX_ORIGEM = '';
    } catch (e) {
      console.error(e);
      if (!S.dom) S.dom = await store.dominio().catch(() => ({ erro: true }));
      if (!silencioso) toast(e.message || 'Não foi possível conferir o domínio agora.', { tone: 'error' });
    }
    S.domVerificando = false;
    if (S.view === 'ajustes' && S.ajTab === 'endereco') {
      renderView();
      // Enquanto não está no ar, confere sozinho a cada 20 segundos.
      if (S.dom && S.dom.dominio && S.dom.status !== 'ativo') domTimer = setTimeout(() => S.view === 'ajustes' && S.ajTab === 'endereco' && carregarDominio(true), 20000);
    }
  }
  function ajEndereco() {
    if (!S.dom) {
      carregarDominio(true);
      return '<p class="muted">Carregando o endereço…</p>';
    }
    const d = S.dom;
    const incluso = d.base && d.slug ? `${d.slug}.${d.base}` : location.host;
    const adm = !!S.user.admin;
    const i = d.dominio ? Math.max(0, DOM_PASSOS.findIndex(([k]) => k === d.status)) : -1;
    const regs = d.registros || [];
    const hora = d.checado_em ? new Date(d.checado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
    return `<div class="aj-grid dom-grid">
      <section class="panel stack">
        <h2>Endereço incluso</h2>
        <p class="dom-end"><a class="mono" href="https://${esc(incluso)}" target="_blank" rel="noopener">${esc(incluso)}</a>${icon('check')}</p>
        <p class="help">Funciona sempre, com HTTPS, e não precisa configurar nada.${d.status === 'ativo' ? ' Com o domínio próprio no ar, os dois endereços abrem o mesmo site.' : ''}</p>
      </section>
      <section class="panel stack dom-proprio">
        <h2>Domínio próprio</h2>
        ${!d.dominio ? (adm ? `<form class="stack" id="domForm" novalidate>
            <p>Use o domínio do restaurante, como <b class="mono">cardapio.seurestaurante.com.br</b>. O ideal é um subdomínio (cardapio., pedidos., menu.), que não mexe no site que vocês já têm.</p>
            <label class="field"><span>Domínio</span><input class="input mono" name="dominio" placeholder="cardapio.seurestaurante.com.br" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url" required></label>
            <p class="note">${icon('receipt')}<span><b>R$ 190 de configuração + R$ 19 por mês</b>, somados ao plano só quando o domínio ficar no ar.</span></p>
            <p class="form-error" id="domErro" role="alert"></p>
            <button type="submit" class="btn btn-cobalt">${icon('plus')} Adicionar domínio</button>
          </form>` : `<p class="note">${icon('lock')}<span>Só o administrador do restaurante conecta um domínio próprio.</span></p>`)
        : `<div class="dom-topo"><b class="mono dom-nome">${esc(d.dominio)}</b><span class="dom-selo is-${esc(d.status)}">${esc(DOM_ROTULO[d.status] || d.status)}</span></div>
          <ol class="dom-passos">
            <li class="is-feito">${icon('check')}<span>Domínio adicionado</span></li>
            ${DOM_PASSOS.map(([k, t], n) => `<li class="${n < i || d.status === 'ativo' ? 'is-feito' : n === i ? 'is-agora' : ''}">${n < i || d.status === 'ativo' ? icon('check') : `<i>${n + 2}</i>`}<span>${t}</span></li>`).join('')}
          </ol>
          ${d.status === 'ativo' ? `<div class="dom-ok">${icon('check')}<div><b>No ar em <a href="https://${esc(d.dominio)}" target="_blank" rel="noopener">https://${esc(d.dominio)}</a></b>
              <p>As plaquinhas, o link do clube de pontos e o link do delivery já abrem por ele.</p></div></div>`
            : `<p>${d.status === 'certificado' ? 'O DNS está certo. Agora é com a gente: o certificado HTTPS sai sozinho em poucos minutos.' : `Crie ${regs.length > 1 ? 'estes registros' : 'este registro'} no painel onde o domínio foi comprado (Registro.br, Hostinger, GoDaddy, Cloudflare…):`}</p>
            ${regs.length ? `<div class="dom-regs" role="table" aria-label="Registros DNS">
              <div class="dom-reg dom-reg--cab" role="row"><span role="columnheader">Tipo</span><span role="columnheader">Nome</span><span role="columnheader">Valor</span><span></span></div>
              ${regs.map((r) => `<div class="dom-reg ${r.ok ? 'is-ok' : ''}" role="row">
                <span role="cell"><b class="mono">${esc(r.tipo)}</b></span>
                <span role="cell" class="dom-copia"><b class="mono">${esc(r.nome)}</b><button type="button" class="icon-btn" data-copiar="${esc(r.nome)}" aria-label="Copiar o nome">${icon('copy')}</button></span>
                <span role="cell" class="dom-copia"><b class="mono">${esc(r.valor)}</b><button type="button" class="icon-btn" data-copiar="${esc(r.valor)}" aria-label="Copiar o valor">${icon('copy')}</button></span>
                <span role="cell" class="dom-reg-st">${r.ok ? `${icon('check')} Certo` : 'Aguardando'}</span></div>`).join('')}
            </div>` : ''}
            ${d.status === 'dns' ? `<ul class="dom-dicas">
              <li>${d.raiz ? 'No domínio inteiro (sem subdomínio) o registro é do tipo <b>A</b>, com o nome <b>@</b>. Apague outros registros A ou AAAA desse nome.' : 'No campo Nome vai só a parte antes do domínio. Se já existir um registro com esse nome, troque pelo novo.'}</li>
              <li>Na Cloudflare, deixe a nuvem <b>cinza</b> (somente DNS).</li>
              <li>A mudança costuma aparecer em minutos, mas pode levar algumas horas. Pode fechar esta tela: a conferência continua sozinha.</li>
            </ul>` : ''}
            ${d.mensagem ? `<p class="help">${esc(d.mensagem)}</p>` : ''}`}
          <div class="dom-acoes">
            ${d.status !== 'ativo' ? `<button type="button" class="btn btn-cobalt" data-dom="verificar" ${S.domVerificando ? 'disabled' : ''}>${icon('search')} ${S.domVerificando ? 'Conferindo…' : 'Verificar agora'}</button>` : ''}
            ${adm ? `<button type="button" class="btn btn-quiet" data-dom="remover">${d.status === 'ativo' ? 'Remover domínio' : 'Trocar ou remover'}</button>` : ''}
            ${hora && d.status !== 'ativo' ? `<small class="muted">Última conferência às ${hora}. Confere de novo sozinho a cada 20 s.</small>` : ''}
          </div>`}
      </section>
    </div>`;
  }
  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'domForm') return;
    e.preventDefault();
    const f = e.target;
    const v = f.elements.dominio.value.trim();
    const erro = (m) => { $('#domErro').textContent = m; };
    if (!v) return erro('Digite o domínio.');
    const b = f.querySelector('[type=submit]');
    b.disabled = true;
    try {
      await store.dominioDefinir(v);
      S.dom = null;
      toast('Domínio adicionado. Agora crie o registro DNS.', { tone: 'ok' });
      await carregarDominio(true);
    } catch (ex) {
      b.disabled = false;
      erro(ex.message || 'Não foi possível adicionar o domínio.');
    }
  });
  document.addEventListener('click', async (e) => {
    const cp = e.target.closest('.dom-regs [data-copiar]');
    if (cp) return UI.copyText(cp.dataset.copiar).then((ok) => toast(ok ? 'Copiado.' : 'Não foi possível copiar.', { tone: ok ? 'ok' : 'error' }));
    const b = e.target.closest('[data-dom]');
    if (!b) return;
    if (b.dataset.dom === 'verificar') {
      S.domVerificando = true;
      renderView();
      return carregarDominio();
    }
    if (b.dataset.dom === 'remover') {
      const d = S.dom || {};
      if (!confirm(`Remover o domínio ${d.dominio}? O site continua no endereço incluso${d.status === 'ativo' ? ', e o domínio próprio sai do plano' : ''}.`)) return;
      try {
        S.dom = await store.dominioRemover();
        window.VTX_ORIGEM = '';
        toast('Domínio removido.', { tone: 'ok' });
        await carregarDominio(true);
      } catch (ex) {
        toast(ex.message || 'Não foi possível remover.', { tone: 'error' });
      }
    }
  });

  /* Plano: upsell e downsell pelo próprio restaurante */
  const SERVICOS = Precos.SERVICOS.map((x) => [x.id, x.nome, x.preco, x.desc]);
  const reais = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR');
  const ADICIONAIS = Precos.ADICIONAIS;
  const precoAd = (a) => (a.preco ? `R$ ${a.preco}/mês` : 'Preço a combinar');
  const planoTxt = (p) => (p ? [...SERVICOS.filter(([k]) => p.servicos[k]).map(([, n]) => n), ...ADICIONAIS.filter((a) => (p.adicionais || {})[a.id]).map((a) => a.nome)].join(', ')
    + ` · ${p.mesas} mesas` : '—');
  async function carregarPlano() {
    try {
      [S.plano, S.cobranca] = await Promise.all([store.meuPlano(), store.minhaCobranca().catch(() => ({ indisponivel: true }))]);
      S.planoEd = { servicos: { ...S.plano.plano.servicos }, adicionais: { ...(S.plano.plano.adicionais || {}) }, mesas: S.plano.plano.mesas };
    } catch (e) {
      console.error(e);
      toast('Não foi possível carregar o plano.', { tone: 'error' });
    }
    if (S.view === 'ajustes' && S.ajTab === 'plano') renderView();
  }
  // Conferência automática na SEFAZ: cobrada por nota, à parte da mensalidade.
  function sefazPlano() {
    const u = S.plano.sefaz;
    if (!u || (!u.ativo && !u.meses.some((m) => m.notas))) return '';
    const nomeMes = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('pt-BR', { month: 'long' });
    const [este, ant] = u.meses;
    return `<section class="panel stack">
      <h2>Conferência na SEFAZ</h2>
      <p class="muted">${u.ativo ? 'Ligada' : 'Desligada'} · ${brl(u.preco)} por nota conferida, somado à mensalidade. Liga e desliga em Fidelidade → Regras.</p>
      <div class="plano-resumo"><span>Em ${nomeMes(este.mes)} até agora</span><b>${brl(este.valor)}<small> · ${este.notas} ${este.notas === 1 ? 'nota' : 'notas'}</small></b>
        <small>Mensalidade + conferência: ${brl(S.plano.mensal + este.valor)} até agora.</small></div>
      ${ant ? `<p class="help">Em ${nomeMes(ant.mes)}: ${ant.notas} ${ant.notas === 1 ? 'nota' : 'notas'} · ${brl(ant.valor)}.</p>` : ''}
    </section>`;
  }
  // Mensalidade: cartão recorrente ou Pix/boleto pelo Asaas. O cartão é digitado na página segura do Asaas.
  const FATURA = { PENDING: ['Em aberto', ''], OVERDUE: ['Vencida', 'is-late'], RECEIVED: ['Paga', 'is-paid'], CONFIRMED: ['Paga', 'is-paid'],
    RECEIVED_IN_CASH: ['Paga', 'is-paid'], REFUNDED: ['Estornada', ''], DELETED: ['Cancelada', ''] };
  const dataBr = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR') : '');
  function pagPanel() {
    const c = S.cobranca;
    if (!c || c.indisponivel) return '';
    const a = c.assinatura;
    const abertas = (c.faturas || []).filter((f) => f.status === 'PENDING' || f.status === 'OVERDUE').sort((x, y) => x.vencimento.localeCompare(y.vencimento));
    const prox = abertas[0];
    const vencida = abertas.some((f) => f.status === 'OVERDUE');
    if (!a || a.status !== 'ativa') {
      return `<section class="panel stack pag-panel">
        <h2>Pagamento da mensalidade</h2>
        ${!S.user.admin ? `<p class="note">${icon('lock')}<span>A cobrança ainda não foi ativada. Só o administrador do restaurante ativa.</span></p>` : `
        <p class="muted">Escolha como pagar os ${reais(S.plano.mensal)} por mês. No cartão, você digita os dados uma vez na página segura do Asaas e a mensalidade é cobrada sozinha todo mês. O VTX Tap não vê nem guarda o número do cartão.</p>
        <form id="pagAtivarForm" class="stack" novalidate>
          <div class="pag-formas" role="radiogroup" aria-label="Forma de pagamento">
            <label class="plano-op is-on"><span><b>Cartão de crédito automático</b><small>Qualquer bandeira. Cobra todo mês sem você precisar fazer nada.</small></span>
              <input type="radio" name="pagForma" value="cartao" checked></label>
            <label class="plano-op"><span><b>Pix ou boleto todo mês</b><small>Chega o link por e-mail alguns dias antes do vencimento.</small></span>
              <input type="radio" name="pagForma" value="pix"></label>
          </div>
          <div class="pag-campos">
            <label class="field"><span>Nome ou razão social</span><input class="input" name="nome" required maxlength="120" autocomplete="organization" value="${esc(S.settings.restaurante && S.settings.restaurante.nome || '')}"></label>
            <label class="field"><span>CPF ou CNPJ</span><input class="input mono" name="documento" required inputmode="numeric" maxlength="18"></label>
            <label class="field"><span>E-mail para as cobranças</span><input class="input" name="email" type="email" required maxlength="120" autocomplete="email"></label>
            <label class="field"><span>Celular (opcional)</span><input class="input" name="telefone" type="tel" inputmode="tel" maxlength="16" autocomplete="tel"></label>
          </div>
          <button class="btn btn-cobalt" type="submit">${icon('lock')} Ativar e ir para o pagamento</button>
          <small class="help">Abre a página de pagamento do Asaas em outra aba. A primeira mensalidade vence amanhã.</small>
        </form>`}
      </section>`;
    }
    return `<section class="panel stack pag-panel">
      <h2>Pagamento da mensalidade</h2>
      ${vencida ? `<p class="note is-warn">${icon('alert')}<span>Há mensalidade vencida. Pague pelo botão abaixo para não interromper o serviço.</span></p>` : ''}
      <div class="pag-resumo">
        <div class="plano-resumo"><span>Forma</span><b class="pag-forma">${a.forma === 'cartao' ? 'Cartão automático' : 'Pix ou boleto'}</b>
          <small>${a.forma === 'cartao' ? (a.cartao ? esc(a.cartao) : 'Cartão ainda não cadastrado: cadastre no primeiro pagamento.') : 'O link chega no e-mail ' + esc(a.email) + '.'}</small></div>
        <div class="plano-resumo"><span>${prox ? (prox.status === 'OVERDUE' ? 'Vencida' : 'Próxima cobrança') : 'Mensalidade'}</span>
          <b>${reais(prox ? prox.valor : a.valor)}</b><small>${prox ? `Vence em ${dataBr(prox.vencimento)}` : 'Nenhuma cobrança em aberto.'}</small></div>
      </div>
      ${S.user.admin ? `<div class="dom-acoes">
        ${prox ? `<button type="button" class="btn btn-cobalt" data-pag="pagar">${icon('external')} ${a.forma === 'cartao' && !a.cartao ? 'Cadastrar o cartão e pagar' : 'Pagar agora'}</button>` : ''}
        <button type="button" class="btn btn-line" data-pag="forma" data-forma="${a.forma === 'cartao' ? 'pix' : 'cartao'}">${a.forma === 'cartao' ? 'Mudar para Pix ou boleto' : 'Mudar para cartão automático'}</button>
      </div>
      <small class="help">Para trocar o cartão, mude para Pix ou boleto e volte para o cartão: a próxima cobrança pede o cartão novo. Dados de cobrança: ${esc(a.nome)} · ${esc(a.documento)}.</small>` : ''}
      ${(c.faturas || []).length ? `<h3 class="plano-sub">Cobranças</h3><ul class="plano-hist pag-faturas">${c.faturas.map((f) => {
        const [st, cls] = FATURA[f.status] || [f.status, ''];
        return `<li><span><b>${reais(f.valor)}</b> · ${esc(f.descricao || 'Mensalidade')} <span class="tag pag-st ${cls}">${st}</span></span>
          <small class="muted">Vencimento ${dataBr(f.vencimento)}${f.pago_em ? ` · pago em ${dataBr(f.pago_em)}` : ''}${f.url ? ` · <a href="${esc(f.url)}" target="_blank" rel="noopener">${f.status === 'PENDING' || f.status === 'OVERDUE' ? 'pagar' : 'recibo'}</a>` : ''}</small></li>`;
      }).join('')}</ul>` : ''}
    </section>`;
  }
  async function pagAcao(acao, dados, botao) {
    // Abre a aba antes da resposta (o navegador bloqueia janela aberta depois de esperar).
    const aba = window.open('', '_blank');
    if (botao) botao.disabled = true;
    try {
      const r = await store.pagamento(acao, dados);
      if (r.url && aba) aba.location.href = r.url;
      else if (aba) aba.close();
      S.cobranca = await store.minhaCobranca();
      toast(r.url ? 'Página de pagamento aberta em outra aba.' : r.demo ? 'Demonstração: pagamento registrado.' : 'Pronto.', { tone: 'ok', ms: 4500 });
      renderView();
    } catch (ex) {
      if (aba) aba.close();
      toast(ex.message || 'Não foi possível agora. Tente de novo.', { tone: 'error', ms: 5000 });
      if (botao) botao.disabled = false;
    }
  }
  document.addEventListener('submit', (e) => {
    if (e.target.id !== 'pagAtivarForm') return;
    e.preventDefault();
    const f = new FormData(e.target);
    const doc = String(f.get('documento') || '').replace(/\D/g, '');
    if (!/^(\d{11}|\d{14})$/.test(doc)) return toast('CPF ou CNPJ inválido.', { tone: 'error' });
    pagAcao('ativar', { forma: f.get('pagForma'), nome: f.get('nome'), documento: doc, email: f.get('email'), telefone: f.get('telefone') },
      e.target.querySelector('[type=submit]'));
  });
  document.addEventListener('change', (e) => {
    if (e.target.name !== 'pagForma') return;
    e.target.closest('.pag-formas').querySelectorAll('.plano-op').forEach((l) => l.classList.toggle('is-on', l.contains(e.target)));
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pag]');
    if (!b) return;
    if (b.dataset.pag === 'forma' && !confirm(b.dataset.forma === 'pix' ? 'Mudar para Pix ou boleto? O cartão deixa de ser cobrado e o link chega por e-mail todo mês.'
      : 'Mudar para cartão automático? A próxima cobrança pede o cartão na página segura do Asaas.')) return;
    pagAcao(b.dataset.pag, { forma: b.dataset.forma }, b);
  });
  function ajPlano() {
    if (!S.plano) {
      carregarPlano();
      return '<p class="muted">Carregando o plano…</p>';
    }
    const atual = S.plano.plano;
    const ed = S.planoEd;
    const novoPreco = Store.precoPlano({ ...atual, ...ed });
    const dif = novoPreco - S.plano.mensal;
    const adAtual = atual.adicionais || {};
    const mudou = SERVICOS.some(([k]) => !!ed.servicos[k] !== !!atual.servicos[k]) || ADICIONAIS.some((a) => !!ed.adicionais[a.id] !== !!adAtual[a.id]) || ed.mesas !== atual.mesas;
    // Subir de faixa de mesas (até 20, 21 a 50, 51 ou mais) cobra uma vez a diferença da implantação.
    const taxa = Precos.taxaMesas(S.plano.implantacao_paga || 0, ed.mesas, atual.contrato);
    const avisos = [
      atual.servicos.garcom && !ed.servicos.garcom && 'Sem “Chamar o garçom”, o sino some da página da mesa e as abas Chamados e Salão saem do painel.',
      atual.servicos.pagina && !ed.servicos.pagina && 'Sem a página e o cardápio, somem o cardápio, o Wi-Fi, a avaliação no Google e as informações.',
      atual.servicos.fidelidade && !ed.servicos.fidelidade && 'Sem a fidelidade, o clube de pontos some da página. Os pontos dos clientes ficam guardados se vocês voltarem.',
      adAtual.prorrogacao && !ed.adicionais.prorrogacao && 'Sem a Prorrogação, o relógio do happy hour some do telão e da página da mesa. O histórico fica guardado.',
      ed.mesas < S.settings.mesas.total && `Hoje vocês usam ${S.settings.mesas.total} mesas. As mesas acima da ${ed.mesas} deixam de funcionar.`,
    ].filter(Boolean);
    return `<div class="aj-grid plano-grid">
      ${pagPanel()}
      <section class="panel stack">
        <h2>Seu plano hoje</h2>
        ${atual.definido === false ? '<p class="note">A VTX ainda não definiu o plano deste restaurante: hoje tudo está liberado.</p>' : ''}
        <ul class="plano-atual">${SERVICOS.map(([k, n]) => `<li class="${atual.servicos[k] ? 'is-on' : ''}">${icon(atual.servicos[k] ? 'check' : 'x')} ${n}</li>`).join('')}
          ${ADICIONAIS.map((a) => `<li class="${adAtual[a.id] ? 'is-on' : ''}">${icon(adAtual[a.id] ? 'check' : 'x')} ${esc(a.nome)} <small class="muted">(adicional)</small></li>`).join('')}
          <li class="is-on">${icon('grid')} ${atual.mesas >= 500 ? 'Mesas sem limite' : `${atual.mesas} mesas`}</li></ul>
        <p class="plano-valor"><b>${reais(S.plano.mensal)}</b> por mês</p>
        <p class="help">Domínio próprio: em Ajustes › Endereço. Tempo de contrato: fale com a VTX.</p>
      </section>
      ${sefazPlano()}
      ${!S.user.admin ? `<section class="panel stack">
        <h2>Mudar o plano</h2>
        <p class="note">${icon('lock')}<span>Só o administrador do restaurante muda o plano.</span></p>
      </section>` : `<section class="panel stack">
        <h2>Mudar o plano</h2>
        <div class="plano-ops">${SERVICOS.map(([k, n, v, d]) => `<label class="plano-op ${ed.servicos[k] ? 'is-on' : ''}">
            <span><b>${n}</b><small>${d}</small></span>
            <span class="plano-op-preco">${v ? `R$ ${v}/mês` : 'incluso'}</span>
            <span class="switch"><input type="checkbox" data-plano-sv="${k}" ${ed.servicos[k] ? 'checked' : ''} aria-label="${n}"><span></span></span>
          </label>`).join('')}</div>
        <h3 class="plano-sub">Adicionais</h3>
        <div class="plano-ops">${ADICIONAIS.map((a) => `<label class="plano-op ${ed.adicionais[a.id] ? 'is-on' : ''}">
            <span><b>${esc(a.nome)}</b><small>${esc(a.desc)}${a.combo ? ' Entra no desconto de combo.' : ''}</small></span>
            <span class="plano-op-preco">${precoAd(a)}</span>
            <span class="switch"><input type="checkbox" data-plano-ad="${a.id}" ${ed.adicionais[a.id] ? 'checked' : ''} aria-label="${esc(a.nome)}"><span></span></span>
          </label>`).join('')}</div>
        <label class="field plano-mesas"><span>Mesas contratadas</span>
          <span class="plano-stepper"><button type="button" class="icon-btn" data-plano-mesas="-1" aria-label="Menos mesas">${icon('minus')}</button>
          <input class="input mono" id="planoMesas" type="number" min="1" max="500" value="${ed.mesas}">
          <button type="button" class="icon-btn" data-plano-mesas="1" aria-label="Mais mesas">${icon('plus')}</button></span>
          <small class="help">Faixas de implantação: ${Precos.IMPLANTACAO.map((f) => `${f.nome} ${reais(f.valor)}`).join(' · ')}. Passar para uma faixa maior cobra uma vez a diferença.</small></label>
        <div class="plano-resumo ${dif > 0 ? 'is-up' : dif < 0 ? 'is-down' : ''}">
          <span>Nova mensalidade</span><b>${reais(novoPreco)}<small> por mês</small></b>
          ${mudou ? `<small>${dif > 0 ? `+${reais(dif)} por mês` : dif < 0 ? `−${reais(-dif)} por mês` : 'mesmo valor'} (hoje ${reais(S.plano.mensal)})${Precos.combo(Precos.itens(ed)).economia ? ` · desconto de combo: −${reais(Precos.combo(Precos.itens(ed)).economia)}` : ''}</small>` : '<small>Mude os serviços ou as mesas acima.</small>'}
        </div>
        ${taxa ? `<div class="plano-resumo is-up"><span>Taxa única pelas mesas a mais</span><b>${reais(taxa)}<small> uma vez</small></b>
          <small>Diferença da implantação para ${esc(Precos.faixa(ed.mesas).nome)}${+atual.contrato === 12 ? ' (com os 50% do contrato de 12 meses)' : ''}. Entra na próxima cobrança, junto com a mensalidade.</small></div>` : ''}
        ${avisos.length ? `<ul class="plano-avisos">${avisos.map((a) => `<li>${icon('alert')} <span>${esc(a)}</span></li>`).join('')}</ul>` : ''}
        <button type="button" class="btn btn-cobalt" data-plano-confirmar ${mudou ? '' : 'disabled'}>${icon('check')} Confirmar mudança</button>
        <small class="help">A mudança vale na hora. A nova mensalidade entra na próxima cobrança.</small>
      </section>`}
      <section class="panel stack">
        <h2>Histórico</h2>
        ${S.plano.historico.length ? `<ul class="plano-hist">${S.plano.historico.map((h) => `<li>
            <span><b>${h.mensal_antes == null ? 'Plano definido' : h.mensal_depois > h.mensal_antes ? 'Aumento' : h.mensal_depois < h.mensal_antes ? 'Redução' : 'Ajuste'}</b> · ${esc(planoTxt(h.depois))}</span>
            <small class="muted">${new Date(h.criado_em).toLocaleDateString('pt-BR')} · ${h.origem === 'restaurante' ? esc(h.por || 'Equipe') : 'VTX'} · ${h.mensal_antes == null ? '' : `${reais(h.mensal_antes)} → `}${reais(h.mensal_depois)}/mês${+h.taxa_unica ? ` · taxa única ${reais(h.taxa_unica)}` : ''}</small>
          </li>`).join('')}</ul>` : '<p class="muted">Nenhuma mudança ainda.</p>'}
      </section>
    </div>`;
  }
  document.addEventListener('change', (e) => {
    const sv = e.target.closest('[data-plano-sv]');
    if (sv && S.planoEd) {
      S.planoEd.servicos[sv.dataset.planoSv] = sv.checked;
      return renderView();
    }
    const ad = e.target.closest('[data-plano-ad]');
    if (ad && S.planoEd) {
      S.planoEd.adicionais[ad.dataset.planoAd] = ad.checked;
      return renderView();
    }
    if (e.target.id === 'planoMesas' && S.planoEd) {
      S.planoEd.mesas = Math.min(500, Math.max(1, parseInt(e.target.value, 10) || S.planoEd.mesas));
      renderView();
    }
  });
  document.addEventListener('click', async (e) => {
    const st = e.target.closest('[data-plano-mesas]');
    if (st && S.planoEd) {
      S.planoEd.mesas = Math.min(500, Math.max(1, S.planoEd.mesas + +st.dataset.planoMesas));
      return renderView();
    }
    const ok = e.target.closest('[data-plano-confirmar]');
    if (!ok || !S.planoEd) return;
    const ed = S.planoEd;
    if (!Object.values(ed.servicos).some(Boolean)) return toast('Escolha pelo menos um serviço.', { tone: 'error' });
    const preco = Store.precoPlano({ ...S.plano.plano, ...ed });
    const taxa = Precos.taxaMesas(S.plano.implantacao_paga || 0, ed.mesas, S.plano.plano.contrato);
    if (!confirm(`Confirmar o novo plano (${planoTxt(ed)})? A mensalidade passa a ${reais(preco)} por mês.${taxa ? ` Taxa única pelas mesas a mais: ${reais(taxa)}, na próxima cobrança.` : ''}`)) return;
    ok.disabled = true;
    try {
      await store.alterarPlano(ed);
      S.settings = await store.getSettings();
      S.plano = null;
      await carregarPlano();
      toast(`Plano atualizado. Nova mensalidade: ${reais(preco)} por mês.`, { tone: 'ok', ms: 5000 });
      renderChrome();
    } catch (ex) {
      console.error(ex);
      toast(ex.message || 'Não foi possível mudar o plano.', { tone: 'error', ms: 5000 });
      ok.disabled = false;
    }
  });

  function ajAparelho() {
    const tema = temaAtual();
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    return `<div class="settings">
        ${linhaApp()}
        <div class="set-row"><div><h3>Som dos alertas</h3><p>Toca um sino quando uma mesa chama.</p></div>
          <div class="vhead-actions"><button type="button" class="btn btn-quiet btn-sm" data-set="testar">Testar</button>
          <label class="switch"><input type="checkbox" data-set="som" ${S.som ? 'checked' : ''} aria-label="Som dos alertas"><span></span></label></div></div>
        <div class="set-row"><div><h3>Lembrete de atrasados</h3><p>Repete o sino a cada 90 s enquanto houver chamado com mais de ${LATE} min.</p></div>
          <label class="switch"><input type="checkbox" data-set="lembrete" ${S.lembrete ? 'checked' : ''} aria-label="Lembrete de atrasados"><span></span></label></div>
        ${perm === 'default' ? `<div class="set-row"><div><h3>Notificações do sistema</h3><p>Receba avisos com o painel em segundo plano.</p></div>
          <button type="button" class="btn btn-cobalt btn-sm" data-set="notif">Ativar</button></div>` : ''}
        ${'wakeLock' in navigator ? `<div class="set-row"><div><h3>Manter a tela ligada</h3><p>Ideal para o tablet fixo no balcão.</p></div>
          <label class="switch"><input type="checkbox" data-set="tela" ${S.telaLigada ? 'checked' : ''} aria-label="Manter a tela ligada"><span></span></label></div>` : ''}
        <div class="set-row wrap"><div><h3>Tema</h3><p>Escuro ajuda em salões com pouca luz.</p></div>
          <div class="seg" role="radiogroup" aria-label="Tema">
            <button type="button" role="radio" aria-checked="${tema === 'light'}" data-tema="light">Claro</button>
            <button type="button" role="radio" aria-checked="${tema === 'dark'}" data-tema="dark">Escuro</button>
            <button type="button" role="radio" aria-checked="${tema === 'auto'}" data-tema="auto">Automático</button></div></div>
        ${isDemo ? `<div class="set-row"><div><h3>Dados de demonstração</h3><p>Apaga os chamados e comentários deste navegador. Os dados do restaurante continuam.</p></div>
          <button type="button" class="btn btn-danger btn-sm" data-set="reset">${icon('trash')} Apagar</button></div>` : ''}
        <div class="set-row"><div><h3>${esc(S.user.nome)}</h3><p>Sair do painel neste aparelho.</p></div>
          <button type="button" class="btn btn-line btn-sm" data-tool="sair">${icon('logout')} Sair</button></div>
      </div>`;
  }

  function linhaApp() {
    // Só aparece quando dá para fazer algo: instalar agora ou seguir os passos do iPhone.
    if (APP.instalado()) return '';
    if (APP.pedido) return `<div class="set-row"><div><h3>Instalar o app</h3><p>Coloca o painel na tela inicial, abre em tela cheia e avisa dos chamados.</p></div>
          <button type="button" class="btn btn-cobalt btn-sm" data-app="instalar">${icon('download')} Instalar</button></div>`;
    if (APP.ios()) return `<div class="set-row wrap"><div><h3>Instalar o app no iPhone</h3><p>Coloca o painel na tela inicial e libera as notificações de chamados.</p></div>${passosIos()}</div>`;
    return '';
  }

  /* Widgets */
  function ajWidgets() {
    // Com o módulo liberado, o atalho da fidelidade entra na lista (logo depois do cardápio) para poder mudar de lugar ou desligar.
    if (temFid() && !S.settings.widgets.some((w) => w.tipo === 'fidelidade')) {
      const i = S.settings.widgets.findIndex((w) => w.tipo === 'cardapio');
      S.settings.widgets.splice(i + 1, 0, { id: 'fidelidade', tipo: 'fidelidade', label: 'Programa de fidelidade', ativo: true, embutido: true });
    }
    return `${temServico('garcom') ? `<div class="panel stack">
        <div class="set-row"><div><h3>Sino de chamar o garçom</h3><p>Mostra o sino na página da mesa. Desligado, o cliente vê só o cardápio e os widgets.</p></div>
          <label class="switch"><input type="checkbox" data-sino ${S.settings.mesas.sino !== false ? 'checked' : ''} aria-label="Mostrar o sino na página da mesa"><span></span></label></div>
      </div>` : ''}
      <div class="panel stack" id="widgetsCfg">
        <p class="muted" style="font-size:13px">Desligue o que o restaurante não usa e use as setas para mudar a ordem. Os dados de Wi-Fi, Google e cardápio ficam nas abas Restaurante e Cardápio.</p>
        <ul class="wlist">${S.settings.widgets.map((w, i) => (w.tipo === 'fidelidade' && !temFid() ? '' : widgetRow(w, i, S.settings.widgets.length))).join('')}</ul>
        ${widgetForm()}
      </div>`;
  }

  document.addEventListener('change', (e) => {
    if (!e.target.matches('[data-sino]')) return;
    const on = e.target.checked;
    saveSettings({ mesas: { ...S.settings.mesas, sino: on } }).then((ok) => {
      if (!ok) return;
      // A aba Chamados aparece e some junto com o sino.
      renderChrome();
      toast(on ? 'Sino ligado na página da mesa. A aba Chamados voltou ao menu.' : 'Sino desligado: a página da mesa fica sem o botão de chamar e a aba Chamados sai do menu.', { tone: 'ok' });
    });
  });

  /* Eventos dos ajustes */
  document.addEventListener('click', async (e) => {
    const t = e.target;
    const tab = t.closest('[data-aj]');
    if (tab) {
      S.ajTab = tab.dataset.aj;
      S.widgetEdit = null;
      return renderView();
    }
    const cor = t.closest('[data-cor]');
    if (cor) return salvarCor(cor.dataset.cor === 'padrao' ? UI.COR_PADRAO : cor.dataset.cor);
    const del = t.closest('[data-img-del]');
    if (del) {
      await saveRestaurante({ [del.dataset.imgDel]: '' });
      renderView();
      return renderChrome();
    }
    const mc = t.closest('.mc');
    const ci = mc ? +mc.dataset.ci : null;
    if (t.closest('[data-cat-add]')) {
      const cats = cloneMenu();
      cats.push({ id: uid(), nome: 'Nova categoria', itens: [] });
      await saveCardapio(cats);
      renderView();
      const inp = $$('.mc-name').pop();
      inp && (inp.focus(), inp.select());
      return;
    }
    const cm = t.closest('[data-cat-move]');
    if (cm) {
      const cats = cloneMenu();
      const j = ci + +cm.dataset.catMove;
      if (j < 0 || j >= cats.length) return;
      [cats[ci], cats[j]] = [cats[j], cats[ci]];
      await saveCardapio(cats);
      return renderView();
    }
    if (t.closest('[data-cat-del]')) {
      const c = S.settings.cardapio[ci];
      const msg = c.itens.length ? `Excluir a categoria “${c.nome}” e os ${c.itens.length} pratos dela?` : `Excluir a categoria “${c.nome}”?`;
      if (!confirm(msg)) return;
      const cats = cloneMenu();
      cats.splice(ci, 1);
      await saveCardapio(cats);
      return renderView();
    }
    if (t.closest('[data-item-add]')) return openItem(ci, null);
    const ie = t.closest('[data-item-edit]');
    if (ie) return openItem(ci, +ie.closest('[data-ii]').dataset.ii);
    const im = t.closest('[data-item-move]');
    if (im) {
      const cats = cloneMenu();
      const ii = +im.closest('[data-ii]').dataset.ii;
      const j = ii + +im.dataset.itemMove;
      const arr = cats[ci].itens;
      if (j < 0 || j >= arr.length) return;
      [arr[ii], arr[j]] = [arr[j], arr[ii]];
      await saveCardapio(cats);
      return renderView();
    }
    const selo = t.closest('[data-selo]');
    if (selo) return selo.setAttribute('aria-pressed', selo.getAttribute('aria-pressed') !== 'true');
    if (t.closest('#itemDel')) {
      const { ci: c0, ii } = S.itemEdit;
      const it = S.settings.cardapio[c0].itens[ii];
      if (!confirm(`Excluir “${it.nome}” do cardápio?`)) return;
      const cats = cloneMenu();
      cats[c0].itens.splice(ii, 1);
      await saveCardapio(cats);
      closeSheet();
      return renderView();
    }
  });

  document.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.matches('[data-img]')) return enviarImagem(el);
    if (el.matches('[data-cor-livre]')) return salvarCor(el.value.toLowerCase());

    if (el.matches('[data-r]')) {
      const k = el.dataset.r;
      let v = el.value.trim();
      if (k === 'nome' && !v) {
        el.value = S.settings.restaurante.nome;
        return toast('O restaurante precisa de um nome.', { tone: 'error' });
      }
      if (k === 'googleUrl' && v) {
        if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
        try { new URL(v); } catch { return toast('Cole o link completo do Google, começando com https://', { tone: 'error' }); }
        el.value = v;
      }
      if (k === 'instagram') {
        v = instagramHandle(v);
        el.value = v ? '@' + v : '';
      }
      if (k === 'telefone' && v) {
        const d = v.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
        if (!/^\d{10,11}$/.test(d)) return toast('Telefone com DDD, ex.: (31) 99999-9999.', { tone: 'error' });
        v = d;
        el.value = d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
      }
      if (k === 'taxaServico') {
        v = Math.min(30, Math.max(0, Math.round(Number(v) || 0)));
        el.value = v;
      }
      await saveRestaurante({ [k]: v });
      if (k === 'nome' || k === 'descricao') {
        const bp = $('#brandPreview');
        bp && (bp.innerHTML = brandPreview());
        renderChrome();
      }
      return;
    }

    if (el.matches('[data-wf]')) {
      const k = el.dataset.wf;
      const wifi = { ...S.settings.wifi };
      if (k === 'aberta') {
        wifi.seguranca = el.checked ? 'nopass' : 'WPA';
        const senha = $('[data-wf="senha"]');
        if (senha) {
          senha.disabled = el.checked;
          senha.placeholder = el.checked ? 'Rede sem senha' : '';
          if (el.checked) senha.value = '';
        }
        if (el.checked) wifi.senha = '';
      } else {
        wifi[k] = el.value.trim();
      }
      return saveSettings({ wifi });
    }

    const hrow = el.closest('[data-dia]');
    if (hrow && (el.matches('[data-h-on]') || el.matches('[data-hk]'))) {
      const d = +hrow.dataset.dia;
      await salvarHorarios((dias) => {
        if (el.matches('[data-h-on]')) {
          const aberto = DIAS.map(([x]) => dias[x]).find((h) => h.on);
          dias[d] = el.checked ? { on: true, abre: aberto ? aberto.abre : '18:00', fecha: aberto ? aberto.fecha : '23:00' } : { ...dias[d], on: false };
        } else if (el.value) {
          dias[d] = { ...dias[d], [el.dataset.hk]: el.value };
        }
      });
      if (el.matches('[data-h-on]')) renderView();
      return;
    }


    if (el.matches('[data-cat-name]')) {
      const ci = +el.closest('.mc').dataset.ci;
      const nome = el.value.trim();
      if (!nome) {
        el.value = S.settings.cardapio[ci].nome;
        return toast('A categoria precisa de um nome.', { tone: 'error' });
      }
      const cats = cloneMenu();
      cats[ci] = { ...cats[ci], nome };
      return saveCardapio(cats);
    }
  });

  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'itemForm') return;
    e.preventDefault();
    const err = $('#itErr');
    const nome = $('#itNome').value.trim();
    const preco = parsePreco($('#itPreco').value);
    if (!nome) {
      err.textContent = 'Dê um nome ao prato.';
      return $('#itNome').focus();
    }
    if (!(preco >= 0)) {
      err.textContent = 'Digite o preço em reais, por exemplo 34,90.';
      return $('#itPreco').focus();
    }
    const destino = +$('#itCat').value;
    const { ci, ii } = S.itemEdit;
    const cats = cloneMenu();
    const antigo = ii != null ? cats[ci].itens[ii] : null;
    const item = {
      ...(antigo || { id: uid() }),
      nome,
      desc: $('#itDesc').value.trim(),
      preco,
      tags: $$('[data-selo]').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.selo),
      destaque: $('#itDestaque').checked,
      delivery: $('#itDelivery').checked,
      salao: !$('#itSoDelivery').checked,
      foto: S.itemFoto || '',
      grupos: lerGrupos().filter((g) => g.nome && g.opcoes.length),
    };
    if (item.salao) delete item.salao;
    if (!item.foto) delete item.foto;
    if (!item.grupos.length) delete item.grupos;
    if (item.salao === false && !item.delivery) {
      err.textContent = 'Um item "só no delivery" precisa estar disponível no delivery.';
      return;
    }
    if (antigo && destino === ci) cats[ci].itens[ii] = item;
    else {
      if (antigo) cats[ci].itens.splice(ii, 1);
      cats[destino].itens.push(item);
    }
    if (await saveCardapio(cats)) {
      closeSheet();
      renderView();
      toast(antigo ? 'Prato atualizado.' : 'Prato adicionado.', { tone: 'ok' });
    }
  });

  /* ============================== Demonstração ============================== */
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  async function simular() {
    const tipo = pick(cfg.motivos).id;
    const data = { mesa: 1 + Math.floor(Math.random() * S.settings.mesas.total), tipo };
    if (tipo === 'conta') data.pagamento = pick(cfg.pagamentos);
    if (tipo === 'outro') data.nota = pick(['Cadeira para criança, por favor', 'Mais guardanapos', 'Pode baixar o ar-condicionado?']);
    if (tipo === 'pedido') {
      const itens = S.settings.cardapio.flatMap((c) => c.itens);
      data.itens = [pick(itens), pick(itens)].filter((v, i, a) => a.indexOf(v) === i).map((i) => ({ id: i.id, nome: i.nome, qtd: 1 + Math.floor(Math.random() * 2), preco: i.preco }));
    }
    await store.createCall(data);
  }
  async function simularComentario() {
    const e = pick([5, 5, 4, 4, 3, 2]);
    await store.createFeedback({
      estrelas: e,
      tags: e >= 4 ? ['Comida', 'Ambiente'] : ['Tempo de espera'],
      texto: e >= 4 ? 'O ancho estava no ponto certo e o atendimento foi muito atencioso.' : 'A comida estava boa, mas demorou bastante para chegar.',
      mesa: Math.random() > 0.5 ? 1 + Math.floor(Math.random() * S.settings.mesas.total) : null,
    });
  }

  /* ============================== Eventos ============================== */
  document.addEventListener('click', async (e) => {
    const t = e.target;
    const a = t.closest('[data-act]');
    if (a) return act(a.dataset.id, a.dataset.act);
    const f = t.closest('[data-filtro]');
    if (f) { S.filtro = f.dataset.filtro; return renderView(); }
    const ff = t.closest('[data-fbf]');
    if (ff) { S.fbFiltro = ff.dataset.fbf; return renderView(); }
    const m = t.closest('[data-mesa]');
    if (m) {
      S.mesaAberta = +m.dataset.mesa;
      renderMesaSheet(S.mesaAberta);
      return openSheet('sh-mesa');
    }
    const so = t.closest('[data-sess-ok]');
    if (so) return decidir(so.dataset.sessOk, true);
    const sn = t.closest('[data-sess-no]');
    if (sn) return decidir(sn.dataset.sessNo, false);
    const fm = t.closest('[data-fechar]');
    if (fm) return fecharMesa(+fm.dataset.fechar, fm.dataset.id || null);
    const pl = t.closest('[data-placa]');
    if (pl) return abrirVincular(pl.dataset.placa);
    const vm = t.closest('[data-vmesa]');
    if (vm) {
      vincMesa = +vm.dataset.vmesa;
      return renderVincular();
    }
    const vb = t.closest('[data-vinc]');
    if (vb) return vb.dataset.vinc === 'salvar' ? salvarVinculo() : vb.dataset.vinc === 'comanda' ? salvarComanda() : soltarVinculo();
    const vt = t.closest('[data-vtipo]');
    if (vt) {
      vincTipo = vt.dataset.vtipo;
      return renderVincular();
    }
    const aBtn = t.closest('[data-area]');
    if (aBtn) {
      const areas = S.settings.mesas.areas.slice();
      if (aBtn.dataset.area === 'add') {
        const livre = faixaLivre(areas, S.settings.mesas.total);
        if (!livre) return toast('Todas as mesas já estão em alguma área. Diminua uma faixa ou aumente o total de mesas.', { tone: 'error', ms: 4500 });
        areas.push({ nome: 'Nova área', ...livre });
      } else {
        const row = aBtn.closest('[data-area-idx]');
        areas.splice(+row.dataset.areaIdx, 1);
      }
      await saveMesas({ areas });
      return renderView();
    }
    const wBtn = t.closest('[data-w]');
    if (wBtn) {
      const row = wBtn.closest('[data-widx]');
      const i = row ? +row.dataset.widx : null;
      if (wBtn.dataset.w === 'up') return moveWidget(i, -1);
      if (wBtn.dataset.w === 'down') return moveWidget(i, 1);
      if (wBtn.dataset.w === 'del') return deleteWidget(i);
      if (wBtn.dataset.w === 'edit') { S.widgetEdit = i; return renderView(); }
      if (wBtn.dataset.w === 'novo') { S.widgetEdit = 'novo'; return renderView(); }
      if (wBtn.dataset.w === 'cancelar') { S.widgetEdit = null; return renderView(); }
      return;
    }
    const d = t.closest('[data-demo]');
    if (d) return d.dataset.demo === 'simular' ? simular() : simularComentario();
    const fb = t.closest('[data-fb]');
    if (fb) {
      try {
        if (fb.dataset.fb === 'lido') await store.updateFeedback(fb.dataset.id, { lido: true });
        else await Promise.all(S.fb.filter((x) => !x.lido).map((x) => store.updateFeedback(x.id, { lido: true })));
        queueRefresh();
      } catch { toast('Não foi possível salvar. Tente de novo.', { tone: 'error' }); }
      return;
    }
    const tm = t.closest('[data-tema]');
    if (tm) return setTheme(tm.dataset.tema);
    const s = t.closest('button[data-set]');
    if (s) {
      if (s.dataset.set === 'testar') { unlockAudio(); const was = S.som; S.som = true; ding(2); S.som = was; }
      if (s.dataset.set === 'notif') { await Notification.requestPermission(); renderView(); }
      if (s.dataset.set === 'reset' && confirm('Apagar todos os chamados e comentários de demonstração deste navegador?')) {
        await store.reset();
        S.seen.clear(); S.seenFb.clear();
        toast('Dados de demonstração apagados.');
      }
    }
  });

  document.addEventListener('change', (e) => {
    const s = e.target.closest('input[data-set]');
    if (s) {
      if (s.dataset.set === 'som') { S.som = s.checked; set('nfc-som', S.som ? '1' : '0'); unlockAudio(); renderChrome(); }
      if (s.dataset.set === 'lembrete') { S.lembrete = s.checked; set('nfc-lembrete', S.lembrete ? '1' : '0'); }
      if (s.dataset.set === 'tela') { S.telaLigada = s.checked; set('nfc-tela', S.telaLigada ? '1' : '0'); applyWakeLock(); }
    }
    if (e.target.id === 'totalMesas') {
      const pedido = Math.min(300, Math.max(1, parseInt(e.target.value, 10) || S.settings.mesas.total));
      if (pedido > S.settings.plano.mesas) {
        e.target.value = S.settings.mesas.total;
        return toast(`Seu plano tem ${S.settings.plano.mesas} mesas. Para usar mais, aumente as mesas em Ajustes → Plano.`, { tone: 'error', ms: 5000 });
      }
      const n = pedido;
      // Faixas que passavam do novo total são cortadas; as que ficaram inteiras fora, removidas.
      const areas = S.settings.mesas.areas.filter((a) => a.de <= n).map((a) => ({ ...a, ate: Math.min(a.ate, n) }));
      saveMesas({ total: n, areas }).then(renderView);
      return;
    }
    const af = e.target.closest('[data-afield]');
    if (af) {
      const row = af.closest('[data-area-idx]');
      const areas = S.settings.mesas.areas.slice();
      const i = +row.dataset.areaIdx;
      const field = af.dataset.afield;
      if (field === 'nome') {
        areas[i] = { ...areas[i], nome: af.value.trim() || 'Área' };
        saveMesas({ areas });
        return;
      }
      const total = S.settings.mesas.total;
      const nova = { ...areas[i], [field]: parseInt(af.value, 10) };
      const erro = erroDaArea(nova, areas, i, total);
      if (erro) {
        af.value = areas[i][field];
        return toast(erro, { tone: 'error', ms: 4500 });
      }
      areas[i] = nova;
      saveMesas({ areas });
      return;
    }
    const wt = e.target.closest('input[data-w="toggle"]');
    if (wt) {
      const row = wt.closest('[data-widx]');
      const list = S.settings.widgets.slice();
      const i = +row.dataset.widx;
      list[i] = { ...list[i], ativo: wt.checked };
      if (list[i].tipo === 'info' && wt.checked && !infoPreenchida().length) {
        toast('Ligado, mas nada aparece ainda: preencha endereço, telefone, horários ou Instagram na aba Restaurante.', { ms: 6000 });
      }
      saveWidgets(list).then(() => S.view === 'ajustes' && renderView());
    }
  });

  document.addEventListener('submit', (e) => {
    if (e.target.id !== 'placaManual') return;
    e.preventDefault();
    const codigo = normCodigo($('#pmCodigo').value);
    const mesa = parseInt($('#pmMesa').value, 10);
    const comanda = parseInt(($('#pmComanda') || {}).value, 10);
    if (!/^[A-Z0-9]{4,16}$/.test(codigo)) return toast('Digite o código da plaquinha (letras e números).', { tone: 'error' });
    if (comanda && !mesa) {
      vincCodigo = codigo;
      return store.vincularComanda(codigo, comanda, S.user.nome)
        .then(() => { toast(`Plaquinha ligada como comanda ${comanda}.`, { tone: 'ok' }); queueRefresh(); })
        .catch((ex) => toast(ex.message || 'Não foi possível salvar.', { tone: 'error', ms: 4500 }));
    }
    if (!(mesa >= 1 && mesa <= S.settings.mesas.total)) return toast(`Digite uma mesa entre 1 e ${S.settings.mesas.total}.`, { tone: 'error' });
    vincCodigo = codigo;
    vincMesa = mesa;
    salvarVinculo();
  });

  document.addEventListener('submit', (e) => {
    if (e.target.id !== 'widgetForm') return;
    e.preventDefault();
    const label = $('#wLabel').value.trim();
    const url = $('#wUrl').value.trim();
    if (!label || !url) return;
    try {
      new URL(url);
    } catch {
      toast('Digite um link completo, começando com https://', { tone: 'error' });
      return;
    }
    const sub = $('#wSub').value.trim();
    const icone = $('#wIcone').value;
    const list = S.settings.widgets.slice();
    if (typeof S.widgetEdit === 'number') list[S.widgetEdit] = { ...list[S.widgetEdit], label, sub: sub || null, url, icone };
    else list.push({ id: uid(), tipo: 'link', label, sub: sub || null, url, icone, ativo: true, embutido: false });
    S.widgetEdit = null;
    saveWidgets(list).then(renderView);
  });

  /* Relógio: atualiza cronômetros e urgência sem redesenhar a tela. */
  let lastNag = 0;
  function tick() {
    $$('[data-since]').forEach((el) => (el.textContent = clock(el.dataset.since)));
    $$('.ccard[data-status="aberto"]').forEach((card) => {
      const c = S.calls.find((x) => x.id === card.dataset.id);
      if (c) card.dataset.urg = urgency(c);
    });
    const late = S.calls.some((c) => urgency(c) === 'late');
    if (late && S.lembrete && Date.now() - lastNag > 90e3) {
      if (lastNag) ding(1);
      lastNag = Date.now();
    }
    if (!late) lastNag = 0;
  }

  /* ============================== Início ============================== */
  let started = false;
  function startApp() {
    $('#login').hidden = true;
    $('#shell').hidden = false;
    $$('.sheet [data-close].icon-btn').forEach((b) => (b.innerHTML = icon('x')));
    if (started) return;
    started = true;
    // Domínio próprio no ar: os links públicos (QR das mesas, clube, delivery) passam a usar ele.
    if (store.dominio) store.dominio().then((d) => { if (d && d.status === 'ativo' && d.dominio) window.VTX_ORIGEM = `https://${d.dominio}`; }).catch(() => {});
    if (window.FidPainel) FidPainel.iniciar({ store, S, rerender: renderView, chrome: renderChrome, ding, isDemo, prepararImagem });
    if (window.DelPainel) DelPainel.iniciar({ store, S, rerender: renderView, chrome: renderChrome, ding });
    if (window.HHPainel) HHPainel.iniciar({ store, S, rerender: renderView, chrome: renderChrome });
    route();
    window.addEventListener('hashchange', route);
    store.subscribe(queueRefresh);
    // Cliente novo no clube: aviso na hora para a equipe.
    if (store.onNovoCliente) store.onNovoCliente((c) => {
      if (!temFid()) return;
      const nome = firstName(c.nome) || 'Alguém';
      toast(`${nome} entrou no clube.`, { tone: 'ok', ms: 5000, action: S.view !== 'fidelidade' ? { label: 'Ver', run: () => go('fidelidade') } : null });
      notify({ id: 'cli-' + Date.now(), titulo: 'Novo cliente no clube', corpo: `${c.nome || nome} acabou de entrar no clube.` });
    });
    refresh();
    setInterval(tick, 1000);
    // Rede de segurança caso o tempo real caia.
    setInterval(refresh, isDemo ? 30e3 : 20e3);
    applyWakeLock();
    setTimeout(avisoApp, 1500);
    if (S.vincular) {
      const codigo = S.vincular;
      S.vincular = null;
      history.replaceState(null, '', location.pathname + location.hash);
      if (/^[A-Z0-9]{4,16}$/.test(codigo)) setTimeout(() => abrirVincular(codigo), 300);
    }
    if (S.chopp) {
      // Tira o ?chopp=1 do endereço: recarregar a página não soma de novo.
      S.chopp = false;
      history.replaceState(null, '', location.pathname + location.hash);
      if (temHH()) HHPainel.choppDoQr();
      else toast('A Prorrogação não está no plano deste restaurante.', { tone: 'error' });
    }
  }

  store
    .init({ realtimeAll: true })
    .then(async () => {
      try { S.settings = await store.getSettings(); } catch (e) { console.error(e); }
      const sess = await store.auth.sessao().catch(() => null);
      if (sess) {
        S.user = { nome: sess.nome, admin: !!sess.admin };
        return startApp();
      }
      try {
        const est = await store.auth.estado();
        temSenhaEquipe = est.temSenha;
        temEquipe = !!est.temEquipe;
      } catch {}
      // Demonstração: a primeira conta define a senha. Produção: a senha vem da central.
      if (!temSenhaEquipe && isDemo) S.loginModo = 'criar';
      showLogin(temSenhaEquipe || isDemo ? '' : 'A senha da equipe deste restaurante ainda não foi definida. Fale com a Vortex.');
    })
    .catch((e) => {
      console.error(e);
      if (e.code === 'SEM_RESTAURANTE') return UI.semRestaurante();
      showLogin('Não foi possível conectar ao servidor. Verifique a internet e recarregue.');
      // Sem o restaurante carregado não dá para entrar: troca o botão por "Recarregar".
      const b = $('#loginForm [type=submit]');
      if (b) { b.type = 'button'; b.textContent = 'Recarregar'; b.onclick = () => location.reload(); }
    });
})();
