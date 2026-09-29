/* Página da mesa — tudo o que o cliente vê depois de encostar o celular na plaquinha. */
(function () {
  const cfg = window.NFC_CONFIG;
  const { $, $$, esc, brl, pad, norm, icon, toast, copyText, qrSvg, clock, openSheet, closeSheet, closeAllSheets,
    instagramHandle, instagramUrl, mapsUrl, googleReviewUrl, initials, safeUrl } = UI;
  const store = Store.create();

  const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const safeSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };

  /* ---------------- Dados do restaurante: vêm do painel da equipe ---------------- */
  // Valor provisório até carregar; boot() reaplica tudo com os dados salvos.
  let live = { restaurante: cfg.restaurante, wifi: cfg.wifi, cardapio: cfg.cardapio, mesas: cfg.mesasPadrao, widgets: cfg.widgetsPadrao };
  let R = live.restaurante;

  const readMesaBruta = () => {
    const p = new URLSearchParams(location.search);
    const n = parseInt(p.get('mesa') || p.get('m') || '', 10);
    return n >= 1 ? n : null;
  };
  // Plaquinha: /?tag=CODIGO (vindo do redirecionador central) ou /t/CODIGO.
  const readTag = () => {
    const p = new URLSearchParams(location.search);
    const raw = p.get('tag') || (location.pathname.match(/^\/t\/([A-Za-z0-9-]+)/) || [])[1] || '';
    const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return c.length >= 4 ? c : null;
  };
  const tag = readTag();
  let tagNova = false;
  let mesa = tag ? null : readMesaBruta();
  const areaDe = (n) => (live.mesas.areas.find((a) => n >= a.de && n <= a.ate) || {}).nome || '';
  const motivo = (id) => cfg.motivos.find((m) => m.id === id) || { label: id, curto: id };

  /* ---------------- Tema claro/escuro ---------------- */
  const themeBtn = $('#themeToggle');
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    themeBtn.innerHTML = icon(t === 'dark' ? 'sun' : 'moon');
    themeBtn.setAttribute('aria-label', t === 'dark' ? 'Mudar para modo claro' : 'Mudar para modo escuro');
  }
  applyTheme(safeGet('nfc-tema') || 'light');
  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    safeSet('nfc-tema', next);
    applyTheme(next);
  });

  /* ---------------- Topo ---------------- */
  function renderTop() {
    UI.aplicarCor(R.cor);
    $('#brandName').textContent = R.nome;
    $('#brandDesc').textContent = R.descricao || '';
    document.title = mesa ? `Mesa ${mesa} · ${R.nome}` : R.nome;
    const logo = $('#heroLogo');
    const logoUrl = safeUrl(R.logo);
    logo.classList.toggle('is-initials', !logoUrl);
    logo.innerHTML = logoUrl ? `<img src="${esc(logoUrl)}" alt="Logo ${esc(R.nome)}">` : `<span aria-hidden="true">${esc(initials(R.nome))}</span>`;
    const cover = $('#heroCover');
    const capaUrl = safeUrl(R.capa);
    cover.classList.toggle('has-img', !!capaUrl);
    cover.style.backgroundImage = capaUrl ? `url("${capaUrl.replace(/"/g, '%22')}")` : '';
    const h = new Date().getHours();
    $('#greeting').textContent = h < 5 ? 'Boa noite' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
    const st = openState();
    const pill = $('#openPill');
    pill.textContent = st.open ? `Aberto até ${st.until}` : 'Fechado agora';
    pill.classList.toggle('is-open', st.open);
  }

  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  function openState(now = new Date()) {
    const d = now.getDay();
    const cur = now.getHours() * 60 + now.getMinutes();
    for (const off of [0, 1]) {
      const day = (d - off + 7) % 7;
      for (const h of R.horarios) {
        if (!h.dias.includes(day)) continue;
        const a = toMin(h.abre);
        let f = toMin(h.fecha);
        if (f <= a) f += 1440;
        const c = cur + off * 1440;
        if (c >= a && c < f) return { open: true, until: h.fecha.replace(':00', 'h').replace(':', 'h') };
      }
    }
    return { open: false };
  }

  /* ---------------- Placa ---------------- */
  function renderPlate() {
    const el = $('#plate');
    el.classList.toggle('plate--empty', !mesa);
    const area = mesa ? areaDe(mesa) : '';
    el.setAttribute('aria-label', mesa ? `Mesa ${mesa}${area ? `, ${area}` : ''}` : 'Mesa não identificada');
    el.title = area;
    el.innerHTML = `<span class="rivet r1"></span><span class="rivet r2"></span>
      <span class="plate-label" aria-hidden="true">Mesa</span>
      <span class="plate-num" aria-hidden="true">${mesa ? pad(mesa) : '?'}</span>`;
    $('#tablePicker').hidden = !!mesa || !!tag;
    $('#menuMesa').textContent = mesa ? `Mesa ${pad(mesa)}` : '';
    const nova = $('#tagNova');
    nova.hidden = !tagNova;
    if (tagNova) {
      nova.innerHTML = `<span class="tag-nova-ico">${icon('nfc')}</span>
        <div><h2>Plaquinha nova</h2>
          <p>Esta plaquinha ainda não foi ligada a uma mesa. Chame alguém da equipe para configurar.</p></div>
        <a class="btn btn-cobalt btn-block" href="/admin/?vincular=${encodeURIComponent(tag)}">${icon('lock')} Sou da equipe · configurar</a>
        <small class="mono">Código ${esc(tag)}</small>`;
    } else if (tag && !mesa) {
      nova.hidden = false;
      nova.innerHTML = `<div><h2>Sem conexão</h2><p>Não foi possível identificar a mesa desta plaquinha. Confira a internet e encoste o celular de novo.</p></div>`;
    }
  }

  $('#tablePicker').addEventListener('submit', (e) => {
    e.preventDefault();
    const n = parseInt($('#tableInput').value, 10);
    if (!(n >= 1 && n <= live.mesas.total)) {
      toast(`Digite um número entre 1 e ${live.mesas.total}.`, { tone: 'error' });
      return;
    }
    const url = new URL(location.href);
    url.searchParams.set('mesa', n);
    history.replaceState(null, '', url);
    mesa = n;
    boot();
  });

  /* ---------------- Sino liberado pela equipe ----------------
     Cada celular pede para usar o sino com o nome da pessoa. A equipe libera
     (ou quem já está liberado passa o código da mesa). Assim, quem abre o
     link fora do restaurante não consegue chamar ninguém. */
  const sessKey = () => `nfc-sessao-${mesa}`;
  let sess = null; // { token, status, mesa, nome, codigo }
  let sessPoll = 0;
  const liberado = () => !!(sess && sess.status === 'liberada');

  function pollSessao() {
    clearTimeout(sessPoll);
    if (!sess || !sess.token || !['pendente', 'liberada'].includes(sess.status)) return;
    sessPoll = setTimeout(atualizarSessao, sess.status === 'pendente' ? 4000 : 30000);
  }
  async function atualizarSessao() {
    const token = mesa && safeGet(sessKey());
    if (!token) {
      sess = null;
      return renderGate();
    }
    try {
      const st = await store.sessaoStatus(token);
      if (st.status === 'inexistente') {
        safeSet(sessKey(), null);
        sess = null;
      } else {
        if (sess && sess.status === 'pendente' && st.status === 'liberada') {
          navigator.vibrate && navigator.vibrate([30, 50, 30]);
          toast('Sino liberado. Agora é só segurar o sino para chamar.', { tone: 'ok', ms: 4000 });
        }
        sess = { ...st, token };
        if (st.status === 'encerrada' || st.status === 'recusada') safeSet(sessKey(), null);
      }
    } catch (e) {
      console.error(e);
    }
    renderGate();
    pollSessao();
  }
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && mesa && atualizarSessao());

  function formGate(msg = '') {
    const aviso = sess && sess.status === 'recusada'
      ? 'O pedido anterior não foi aprovado. Se você está na mesa, chame o garçom com um aceno.'
      : sess && sess.status === 'encerrada'
        ? 'A mesa foi fechada ou a liberação venceu. Para chamar de novo, peça a liberação.'
        : msg;
    return `<div class="call-head">
        <h2>Chamar o garçom</h2>
        <p class="muted">Para o sino tocar só para quem está no restaurante, a equipe libera o seu celular uma única vez. Depois é só segurar o sino.</p>
      </div>
      ${aviso ? `<p class="note">${icon('msg')}<span>${esc(aviso)}</span></p>` : ''}
      <form class="gate-form" id="gateForm" novalidate>
        <label class="field"><span>Seu nome</span>
          <input class="input" id="gateNome" maxlength="40" autocomplete="given-name" enterkeyhint="send" placeholder="Como o garçom vai te chamar" value="${esc(safeGet('nfc-nome') || '')}"></label>
        <details class="gate-cod" id="gateCod">
          <summary>Tenho o código da mesa</summary>
          <label class="field"><span>Código da mesa</span>
            <input class="input mono" id="gateCodigo" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="0000"></label>
          <small class="muted">Quem já está liberado na sua mesa vê esse código na tela do celular.</small>
        </details>
        <p class="form-error" id="gateErr" role="alert"></p>
        <button class="btn btn-cobalt btn-block" type="submit">${icon('bell')} Liberar o sino</button>
      </form>`;
  }

  function renderGate() {
    const gate = $('#callGate');
    $('#call').hidden = !mesa;
    if (!mesa) return;
    const pend = sess && sess.status === 'pendente';
    gate.hidden = liberado();
    if (!liberado()) {
      const aberto = document.activeElement && gate.contains(document.activeElement);
      if (pend) {
        gate.innerHTML = `<div class="cs-top">
            <span class="cs-dot">${icon('clock')}</span>
            <div><h2 class="cs-title">Aguardando a equipe</h2>
              <p class="cs-sub">Mesa ${pad(mesa)} · ${esc(sess.nome)}. Um garçom vai confirmar que você está na mesa.</p></div>
          </div>
          <p class="note">${icon('book')}<span>Enquanto isso, veja o cardápio e monte sua lista. Se alguém da sua mesa já foi liberado, peça o código da mesa.</span></p>
          <form class="gate-form gate-form--row" id="gateCodForm" novalidate>
            <label class="sr-only" for="gateCodigo2">Código da mesa</label>
            <input class="input mono" id="gateCodigo2" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="Código da mesa">
            <button class="btn btn-quiet" type="submit">Usar código</button>
          </form>
          <p class="form-error" id="gateErr" role="alert"></p>
          <div class="cs-actions"><button type="button" class="btn btn-line btn-sm" data-gate="cancelar">Cancelar pedido</button></div>`;
      } else if (!aberto || !$('#gateForm')) {
        gate.innerHTML = formGate();
      }
    }
    const who = $('#callWho');
    who.hidden = !liberado();
    if (liberado()) {
      who.innerHTML = `${icon('check')}<span>Sino liberado para <b>${esc(sess.nome)}</b>${sess.codigo ? ` · código da mesa <b class="mono">${esc(sess.codigo)}</b> <small>passe para quem está com você</small>` : ''}</span>`;
    }
    layoutCall();
  }

  function layoutCall() {
    $('#callPanel').hidden = !liberado() || !!current;
    $('#callStatus').hidden = !current;
  }

  async function pedirSino(nome, codigo) {
    const err = $('#gateErr');
    try {
      const r = await store.sessaoAbrir({ mesa, nome, codigo });
      const antigo = safeGet(sessKey());
      if (antigo && antigo !== r.token) store.sessaoSair(antigo).catch(() => {});
      safeSet(sessKey(), r.token);
      safeSet('nfc-nome', nome);
      sess = { ...r };
      if (r.status === 'liberada') toast('Sino liberado. Agora é só segurar o sino para chamar.', { tone: 'ok', ms: 4000 });
      renderGate();
      pollSessao();
      if (r.status === 'liberada') $('#call').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    } catch (e) {
      console.error(e);
      if (err) err.textContent = e.message && !/fetch|network/i.test(e.message) ? e.message : 'Sem conexão. Confira a internet e tente de novo.';
      return false;
    }
  }

  $('#callGate').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    if (e.target.id === 'gateForm') {
      const nome = $('#gateNome').value.replace(/\s+/g, ' ').trim();
      const codigo = ($('#gateCodigo').value || '').trim();
      if (!nome) {
        $('#gateErr').textContent = 'Informe seu nome.';
        return $('#gateNome').focus();
      }
      if (codigo && !/^\d{4}$/.test(codigo)) {
        $('#gateErr').textContent = 'O código da mesa tem 4 números.';
        return $('#gateCodigo').focus();
      }
      btn.disabled = true;
      if (!(await pedirSino(nome, codigo))) btn.disabled = false;
    } else if (e.target.id === 'gateCodForm') {
      const codigo = $('#gateCodigo2').value.trim();
      if (!/^\d{4}$/.test(codigo)) {
        $('#gateErr').textContent = 'O código da mesa tem 4 números.';
        return $('#gateCodigo2').focus();
      }
      btn.disabled = true;
      if (!(await pedirSino(sess.nome, codigo))) btn.disabled = false;
    }
  });
  $('#callGate').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-gate="cancelar"]');
    if (!b) return;
    b.disabled = true;
    const token = safeGet(sessKey());
    try { token && (await store.sessaoSair(token)); } catch {}
    safeSet(sessKey(), null);
    sess = null;
    renderGate();
  });

  function irParaGate() {
    closeAllSheets();
    setTimeout(() => {
      $('#call').scrollIntoView({ behavior: 'smooth', block: 'start' });
      const n = $('#gateNome');
      n && n.focus({ preventScroll: true });
    }, 350);
  }

  /* ---------------- Chamar garçom ---------------- */
  const state = { motivo: 'atendimento', pagamento: cfg.pagamentos[0], nota: '' };

  function renderReasons() {
    $('#reasons').innerHTML = cfg.motivos
      .map((m) => `<button type="button" class="chip" role="radio" aria-checked="${m.id === state.motivo}" data-motivo="${m.id}">${esc(m.label)}</button>`)
      .join('');
    const extra = $('#reasonExtra');
    if (state.motivo === 'conta') {
      extra.innerHTML = `<div class="field"><span id="payLbl">Como você vai pagar?</span>
        <div class="seg" role="radiogroup" aria-labelledby="payLbl">
          ${cfg.pagamentos.map((p) => `<button type="button" role="radio" aria-checked="${p === state.pagamento}" data-pay="${esc(p)}">${esc(p)}</button>`).join('')}
        </div></div>`;
    } else if (state.motivo === 'outro') {
      extra.innerHTML = `<label class="field"><span>Do que você precisa?</span>
        <input class="input" id="noteInput" maxlength="80" placeholder="Ex.: cadeira para criança" value="${esc(state.nota)}"></label>`;
    } else {
      extra.innerHTML = '';
    }
    $('#bellText').textContent = state.motivo === 'conta' ? 'Pedir a conta' : 'Chamar garçom';
  }

  $('#reasons').addEventListener('click', (e) => {
    const b = e.target.closest('[data-motivo]');
    if (!b) return;
    state.motivo = b.dataset.motivo;
    renderReasons();
    if (state.motivo === 'outro') $('#noteInput').focus();
  });
  $('#reasonExtra').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pay]');
    if (!b) return;
    state.pagamento = b.dataset.pay;
    renderReasons();
  });
  $('#reasonExtra').addEventListener('input', (e) => {
    if (e.target.id === 'noteInput') state.nota = e.target.value;
  });

  // Segurar para chamar: evita chamados por toque acidental.
  const HOLD_MS = 900;
  const bell = $('#bell');
  const prog = $('#bellProg');
  $('.bell-face').innerHTML = icon('bell');
  let holding = false, t0 = 0, raf = 0, sending = false;

  const setProg = (p) => (prog.style.strokeDashoffset = String(100 - p * 100));

  function startHold() {
    if (holding || sending) return;
    if (!mesa) {
      nudge('Informe o número da mesa primeiro');
      $('#tableInput').focus();
      return;
    }
    if (!liberado()) return irParaGate();
    holding = true;
    t0 = performance.now();
    bell.classList.add('is-holding');
    navigator.vibrate && navigator.vibrate(8);
    const step = (now) => {
      if (!holding) return;
      const p = Math.min(1, (now - t0) / HOLD_MS);
      setProg(p);
      if (p >= 1) {
        holding = false;
        bell.classList.remove('is-holding');
        sendCall();
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  function endHold() {
    if (!holding) return;
    holding = false;
    cancelAnimationFrame(raf);
    bell.classList.remove('is-holding');
    const early = performance.now() - t0 < HOLD_MS * 0.6;
    prog.style.transition = 'stroke-dashoffset .3s ease';
    setProg(0);
    setTimeout(() => (prog.style.transition = ''), 300);
    if (early) nudge('Segure um pouco mais');
  }
  function nudge(msg) {
    const hint = $('#bellHint');
    hint.textContent = msg;
    bell.classList.remove('is-nudge');
    void bell.offsetWidth;
    bell.classList.add('is-nudge');
    clearTimeout(nudge.t);
    nudge.t = setTimeout(() => (hint.textContent = 'Segure o sino por 1 segundo'), 2200);
  }

  bell.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { bell.setPointerCapture(e.pointerId); } catch {}
    startHold();
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => bell.addEventListener(ev, endHold));
  bell.addEventListener('contextmenu', (e) => e.preventDefault());
  bell.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      e.preventDefault();
      startHold();
    }
  });
  bell.addEventListener('keyup', (e) => (e.key === ' ' || e.key === 'Enter') && endHold());

  async function sendCall(extra = {}) {
    if (sending) return;
    sending = true;
    const payload = { tipo: state.motivo, ...extra };
    if (payload.tipo === 'conta') payload.pagamento = state.pagamento;
    if (payload.tipo === 'outro' && state.nota.trim()) payload.nota = state.nota.trim().slice(0, 80);
    try {
      const call = await store.chamar(sess.token, payload);
      navigator.vibrate && navigator.vibrate([30, 50, 30]);
      bell.classList.add('is-ringing');
      setTimeout(() => bell.classList.remove('is-ringing'), 1200);
      setTimeout(() => setProg(0), 400);
      safeSet(activeKey(), call.id);
      state.nota = '';
      watchActive(call.id, call);
      return true;
    } catch (err) {
      console.error(err);
      setProg(0);
      if (err.code === 'BLOQUEADO') {
        // A mesa foi fechada ou a liberação venceu: pede de novo.
        await atualizarSessao();
        toast('O sino não está mais liberado para este celular. Peça a liberação de novo.', { tone: 'error', ms: 4500 });
        return false;
      }
      toast(/Muitos chamados/.test(err.message || '') ? err.message : 'O chamado não foi enviado. Confira sua conexão e tente de novo.', { tone: 'error', ms: 4200 });
      return false;
    } finally {
      sending = false;
    }
  }

  /* Status do chamado em tempo real */
  const activeKey = () => `nfc-ativo-${mesa}`;
  let unwatch = null;
  let timerInt = 0;
  let current = null;

  function watchActive(id, initial) {
    unwatch && unwatch();
    if (initial) showStatus(initial);
    unwatch = store.watchCall(id, (c) => {
      if (!c) return showStatus(initial || null);
      showStatus(c);
    });
  }

  function showStatus(c) {
    const box = $('#callStatus');
    clearInterval(timerInt);
    const recent = c && Date.now() - new Date(c.criado_em).getTime() < 3 * 3600e3;
    if (!c || !recent || c.status === 'cancelado') {
      current = null;
      layoutCall();
      safeSet(activeKey(), null);
      return;
    }
    current = c;
    layoutCall();
    box.dataset.state = c.status;
    const m = motivo(c.tipo);
    const who = c.atendente ? esc(c.atendente.split(' ')[0]) : 'Alguém da equipe';

    const copy = {
      aberto: { t: 'Chamado enviado', s: `${esc(m.label)} · a equipe já foi avisada`, ic: 'bell' },
      a_caminho: { t: `${who} está a caminho`, s: `${esc(m.label)} · só um instante`, ic: 'arrow' },
      resolvido: { t: 'Atendido', s: 'Se precisar de algo mais, é só chamar.', ic: 'check' },
    }[c.status] || { t: 'Chamado enviado', s: '', ic: 'bell' };

    const steps = ['Enviado', 'A caminho', 'Atendido'];
    const idx = { aberto: 0, a_caminho: 1, resolvido: 2 }[c.status] ?? 0;
    const itens = Array.isArray(c.itens) && c.itens.length
      ? `<ul class="cs-items">${c.itens.map((i) => `<li>${i.qtd}× ${esc(i.nome)}</li>`).join('')}</ul>`
      : '';

    box.innerHTML = `
      <div class="cs-top">
        <span class="cs-dot">${icon(copy.ic)}</span>
        <div><h2 class="cs-title">${copy.t}</h2><p class="cs-sub">${copy.s}${c.pagamento ? ` · ${esc(c.pagamento)}` : ''}</p></div>
        ${c.status !== 'resolvido' ? `<time class="cs-timer" data-since="${c.criado_em}">${clock(c.criado_em)}</time>` : ''}
      </div>
      <ol class="cs-steps" aria-label="Andamento">
        ${steps.map((s, i) => `<li class="${i <= idx ? 'is-done' : i === idx + 1 ? 'is-now' : ''}">${s}</li>`).join('')}
      </ol>
      ${itens}
      <div class="cs-actions">
        ${c.status === 'aberto' ? '<button type="button" class="btn btn-line btn-sm" data-cs="cancel">Cancelar chamado</button>' : ''}
        ${c.status === 'resolvido' ? '<button type="button" class="btn btn-primary btn-sm" data-cs="new">Fazer outro chamado</button>' : ''}
      </div>`;

    if (c.status !== 'resolvido') {
      timerInt = setInterval(() => {
        const t = box.querySelector('[data-since]');
        t && (t.textContent = clock(t.dataset.since));
      }, 1000);
    } else {
      navigator.vibrate && navigator.vibrate(20);
      clearTimeout(showStatus.t);
      showStatus.t = setTimeout(() => current && current.id === c.id && showStatus(null), 12000);
    }
  }

  $('#callStatus').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-cs]');
    if (!b || !current) return;
    if (b.dataset.cs === 'cancel') {
      b.disabled = true;
      try {
        await store.cancelarChamado(safeGet(sessKey()), current.id);
        unwatch && unwatch();
        showStatus(null);
        toast('Chamado cancelado.');
      } catch {
        b.disabled = false;
        toast('Não foi possível cancelar agora. Tente de novo.', { tone: 'error' });
      }
    } else if (b.dataset.cs === 'new') {
      unwatch && unwatch();
      showStatus(null);
    }
  });

  /* ---------------- Atalhos ---------------- */
  const menuCount = () => live.cardapio.reduce((n, c) => n + c.itens.length, 0);
  const googleUrl = () => googleReviewUrl(R);

  const TONES = ['cobalt', 'brass', 'leaf', 'pepper'];
  function widgetTile(w, i) {
    const tone = TONES[i % TONES.length];
    switch (w.tipo) {
      case 'cardapio': {
        const cats = live.cardapio.map((c) => c.nome).join(' · ');
        return `<button type="button" class="tile tile--menu" data-open="sh-menu">
          <span class="tile-menu-count">${icon('book')} ${menuCount()} itens</span>
          <div><h3>Cardápio</h3><p>${esc(cats)}</p></div>
          <span class="tile-go">${icon('arrow')}</span>
        </button>`;
      }
      case 'wifi':
        return `<button type="button" class="tile" data-open="sh-wifi">
          <span class="tile-ico ico-${tone}">${icon('wifi')}</span>
          <div><h3>Wi-Fi</h3><p>${esc(live.wifi.rede)}</p></div>
        </button>`;
      case 'dividir':
        return `<button type="button" class="tile" data-open="sh-split">
          <span class="tile-ico ico-${tone}">${icon('users')}</span>
          <div><h3>Dividir a conta</h3><p>Por pessoa, com serviço</p></div>
        </button>`;
      case 'google':
        return `<a class="tile" href="${esc(googleUrl())}" target="_blank" rel="noopener">
          <span class="tile-ico ico-${tone}">${icon('star')}</span>
          <span class="tile-go">${icon('external')}</span>
          <div><h3>Avaliar no Google</h3><p>Leva um minuto</p></div>
        </a>`;
      case 'comentario':
        return `<button type="button" class="tile" data-open="sh-feedback">
          <span class="tile-ico ico-${tone}">${icon('msg')}</span>
          <div><h3>Comentário anônimo</h3><p>Direto para a gerência</p></div>
        </button>`;
      case 'link':
        return `<a class="tile" href="${esc(w.url || '#')}" target="_blank" rel="noopener">
          <span class="tile-ico ico-${tone}">${icon(w.icone || 'link')}</span>
          <span class="tile-go">${icon('external')}</span>
          <div><h3>${esc(w.label || 'Link')}</h3>${w.sub ? `<p>${esc(w.sub)}</p>` : ''}</div>
        </a>`;
      default:
        return '';
    }
  }
  // Grade dinâmica: os atalhos pequenos andam em pares; quando sobra um
  // (3, 5… ligados), o último ocupa a linha inteira para não deixar buraco.
  function renderTiles() {
    const html = live.widgets.filter((w) => w.ativo !== false).map(widgetTile).filter(Boolean);
    let seguidos = 0;
    const marcar = (fim) => {
      if (seguidos % 2) html[fim - 1] = html[fim - 1].replace('class="tile"', 'class="tile tile--full"');
      seguidos = 0;
    };
    html.forEach((t, i) => (t.includes('tile--menu') ? marcar(i) : seguidos++));
    marcar(html.length);
    const insta = instagramHandle(R.instagram);
    if (insta) {
      html.push(`<a class="tile tile--insta" href="${esc(instagramUrl(R.instagram))}" target="_blank" rel="noopener">
        ${icon('instagram')}<span><b>Siga no Instagram</b><small>@${esc(insta)}</small></span>${icon('arrow')}
      </a>`);
    }
    $('#tiles').innerHTML = html.join('');
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-open]');
    if (b) openSheet(b.dataset.open);
  });

  /* ---------------- Rodapé ---------------- */
  function renderInfo() {
    const dias = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
    const today = new Date().getDay();
    const hoursOf = (d) => {
      const h = R.horarios.find((x) => x.dias.includes(d));
      return h ? `${h.abre} – ${h.fecha}` : 'Fechado';
    };
    $('#info').innerHTML = `
      ${R.endereco ? `<a class="info-row" href="${esc(mapsUrl(R))}" target="_blank" rel="noopener">${icon('pin')}<span>${esc(R.endereco)}</span></a>` : ''}
      <details class="info-row-wrap">
        <summary class="info-row">${icon('clock')}<span>Hoje: ${hoursOf(today)} · ver semana</span></summary>
        <div class="hours">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<span class="${d === today ? 'is-today' : ''}">${dias[d]}</span><span class="${d === today ? 'is-today' : ''}">${hoursOf(d)}</span>`).join('')}</div>
      </details>
      <p class="info-foot">Nenhum cadastro é necessário para usar esta página.</p>`;
  }

  /* ---------------- Cardápio ---------------- */
  const selKey = () => `nfc-lista-${mesa || 0}`;
  let sel = {};
  const loadSel = () => { try { sel = JSON.parse(safeGet(selKey())) || {}; } catch { sel = {}; } };
  const saveSel = () => safeSet(selKey(), JSON.stringify(sel));
  const allItems = () => live.cardapio.flatMap((c) => c.itens);
  const itemById = (id) => allItems().find((i) => i.id === id);
  const selLines = () => Object.entries(sel).filter(([, q]) => q > 0).map(([id, q]) => ({ item: itemById(id), q })).filter((l) => l.item);
  const selTotal = () => selLines().reduce((s, l) => s + l.item.preco * l.q, 0);
  const selCount = () => selLines().reduce((s, l) => s + l.q, 0);

  const qtyHtml = (id) => {
    const q = sel[id] || 0;
    const it = itemById(id);
    return q
      ? `<div class="qty has" data-qty="${id}"><button type="button" class="q-sub" aria-label="Remover um ${esc(it.nome)}">${icon('minus')}</button><output aria-live="polite">${q}</output><button type="button" class="q-add" aria-label="Adicionar mais um ${esc(it.nome)}">${icon('plus')}</button></div>`
      : `<div class="qty" data-qty="${id}"><button type="button" class="q-add" aria-label="Adicionar ${esc(it.nome)} à lista">${icon('plus')}</button></div>`;
  };

  function renderMenu() {
    const q = norm($('#menuSearch').value.trim());
    const cats = live.cardapio
      .map((c) => ({ ...c, itens: c.itens.filter((i) => !q || norm(`${i.nome} ${i.desc || ''}`).includes(q)) }))
      .filter((c) => c.itens.length);

    $('#catTabs').innerHTML = cats
      .map((c, i) => `<button type="button" class="chip" role="tab" aria-selected="${i === 0}" data-cat="${c.id}">${esc(c.nome)}</button>`)
      .join('');
    $$('#catTabs .chip').forEach((b, i) => b.classList.toggle('is-on', i === 0));

    if (!cats.length) {
      $('#menuBody').innerHTML = `<p class="menu-empty">Nada encontrado para “${esc($('#menuSearch').value)}”.<br>Tente outro nome ou limpe a busca.</p>`;
      return;
    }
    $('#menuBody').innerHTML = cats
      .map(
        (c) => `<section class="cat-sec" id="cat-${c.id}" aria-labelledby="h-${c.id}">
          <h3 class="cat-title" id="h-${c.id}">${esc(c.nome)} <small>${c.itens.length} ${c.itens.length === 1 ? 'item' : 'itens'}</small></h3>
          ${c.itens
            .map(
              (i) => `<article class="dish">
                <div class="dish-top"><h4 class="dish-name">${esc(i.nome)}</h4><span class="leader" aria-hidden="true"></span><span class="price">${brl(i.preco)}</span></div>
                ${i.desc ? `<p class="dish-desc">${esc(i.desc)}</p>` : ''}
                <div class="dish-foot">
                  <div class="tags">${i.destaque ? '<span class="tag tag--casa">Da casa</span>' : ''}${(i.tags || []).map((t) => `<span class="tag tag--${t}">${esc(cfg.tags[t] || t)}</span>`).join('')}</div>
                  ${qtyHtml(i.id)}
                </div>
              </article>`
            )
            .join('')}
        </section>`
      )
      .join('');
    observeCats();
  }

  let catObserver;
  function observeCats() {
    catObserver && catObserver.disconnect();
    const body = $('#menuBody');
    catObserver = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (!vis) return;
        const id = vis.target.id.replace('cat-', '');
        $$('#catTabs .chip').forEach((b) => {
          const on = b.dataset.cat === id;
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-selected', on);
          if (on) b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
        });
      },
      { root: body, rootMargin: '0px 0px -70% 0px' }
    );
    $$('.cat-sec', body).forEach((s) => catObserver.observe(s));
  }

  $('#catTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    const sec = document.getElementById('cat-' + b.dataset.cat);
    const body = $('#menuBody');
    body.scrollTo({ top: sec.offsetTop - body.offsetTop - 4, behavior: 'smooth' });
  });

  let searchT;
  $('#menuSearch').addEventListener('input', () => {
    clearTimeout(searchT);
    searchT = setTimeout(renderMenu, 120);
  });

  function changeQty(id, d) {
    sel[id] = Math.max(0, Math.min(20, (sel[id] || 0) + d));
    if (!sel[id]) delete sel[id];
    saveSel();
    navigator.vibrate && navigator.vibrate(6);
    $$(`[data-qty="${id}"]`).forEach((el) => (el.outerHTML = qtyHtml(id)));
    renderSelBar();
    if (!$('#sh-sel').hidden) renderSelSheet();
  }
  document.addEventListener('click', (e) => {
    const box = e.target.closest('[data-qty]');
    if (!box) return;
    if (e.target.closest('.q-add')) changeQty(box.dataset.qty, 1);
    else if (e.target.closest('.q-sub')) changeQty(box.dataset.qty, -1);
  });

  function renderSelBar() {
    const n = selCount();
    const bar = $('#selBar');
    bar.hidden = !n;
    if (!n) return;
    bar.innerHTML = `<div><b>${n} ${n === 1 ? 'item' : 'itens'} na lista</b><span>${brl(selTotal())}</span></div>
      <button type="button" class="btn" data-open="sh-sel">${icon('list')} Ver lista</button>`;
  }

  function renderSelSheet() {
    const lines = selLines();
    const body = $('#selBody');
    if (!lines.length) {
      body.innerHTML = `<div class="stack"><p class="muted">Sua lista está vazia. Toque em + nos pratos do cardápio para montar o pedido.</p>
        <button type="button" class="btn btn-quiet btn-block" data-close>Voltar ao cardápio</button></div>`;
      return;
    }
    body.innerHTML = `<div class="stack">
      <ul class="sel-list">${lines.map((l) => `<li><strong>${esc(l.item.nome)}</strong><span class="price">${brl(l.item.preco * l.q)}</span>${qtyHtml(l.item.id)}</li>`).join('')}</ul>
      <div class="sel-total"><span>Total estimado</span><span class="price">${brl(selTotal())}</span></div>
      <p class="note">${icon('msg')}<span>A lista é um lembrete: o garçom vem até a mesa e confirma o pedido com você.</span></p>
      ${liberado()
        ? `<button type="button" class="btn btn-cobalt btn-block" id="sendList">${icon('bell')} Chamar garçom com esta lista</button>`
        : `<button type="button" class="btn btn-cobalt btn-block" id="gateList" ${mesa ? '' : 'disabled'}>${icon('bell')} Liberar o sino para enviar a lista</button>`}
      <button type="button" class="btn btn-quiet btn-block" id="clearList">Limpar lista</button>
    </div>`;
  }
  $('#sh-sel').addEventListener('sheet:open', renderSelSheet);
  $('#selBody').addEventListener('click', async (e) => {
    if (e.target.closest('#clearList')) {
      sel = {};
      saveSel();
      renderMenu();
      renderSelBar();
      renderSelSheet();
    }
    if (e.target.closest('#gateList')) return irParaGate();
    const send = e.target.closest('#sendList');
    if (send) {
      send.disabled = true;
      const itens = selLines().map((l) => ({ id: l.item.id, nome: l.item.nome, qtd: l.q, preco: l.item.preco }));
      const ok = await sendCall({ tipo: 'pedido', itens });
      if (ok) {
        sel = {};
        saveSel();
        renderMenu();
        renderSelBar();
        closeAllSheets();
        toast('Lista enviada. O garçom vem confirmar com você.', { tone: 'ok' });
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else send.disabled = false;
    }
  });

  $('#sh-menu').addEventListener('sheet:open', () => {
    $('#menuBody').scrollTop = 0;
  });

  /* ---------------- Wi-Fi ---------------- */
  function renderWifi() {
    const w = live.wifi;
    const open = w.seguranca === 'nopass' || !w.senha;
    const escWifi = (s) => String(s).replace(/([\\;,:"])/g, '\\$1');
    const qrData = `WIFI:T:${open ? 'nopass' : w.seguranca};S:${escWifi(w.rede)};${open ? '' : `P:${escWifi(w.senha)};`};`;
    $('#wifiBody').innerHTML = `<div class="stack-lg">
      <div class="plate wifi-card">
        <span class="rivet r1"></span><span class="rivet r2"></span>
        <div class="wifi-row"><small>Rede</small><b>${esc(w.rede)}</b></div>
        <div class="wifi-row"><small>Senha</small>
          ${open ? '<b>Rede aberta, sem senha</b>' : `<div class="wifi-pass"><code>${esc(w.senha)}</code><button type="button" class="icon-btn" id="copyPass" aria-label="Copiar senha">${icon('copy')}</button></div>`}
        </div>
      </div>
      ${open ? '' : `<button type="button" class="btn btn-primary btn-block" id="copyPass2">${icon('copy')} Copiar senha</button>`}
      <ol class="steps">
        ${open ? '' : '<li>Copie a senha.</li>'}
        <li>Abra <strong>Ajustes › Wi-Fi</strong> no iPhone ou <strong>Configurações › Wi-Fi</strong> no Android.</li>
        <li>Escolha <strong>${esc(w.rede)}</strong>${open ? '' : ' e cole a senha'}.</li>
      </ol>
      <div class="qr-box"><div class="qr">${qrSvg(qrData, { cell: 4, margin: 1 })}</div>
        <p><strong>Conectar outro celular:</strong> aponte a câmera para este código e toque na notificação.</p></div>
    </div>`;
  }
  $('#sh-wifi').addEventListener('sheet:open', renderWifi);
  $('#wifiBody').addEventListener('click', async (e) => {
    if (e.target.closest('#copyPass, #copyPass2')) {
      const ok = await copyText(live.wifi.senha);
      toast(ok ? 'Senha copiada.' : 'Não foi possível copiar. Selecione a senha e copie manualmente.', { tone: ok ? 'ok' : 'error' });
    }
  });

  /* ---------------- Dividir a conta ---------------- */
  const split = { total: '', pessoas: 2, servico: true };
  function renderSplit() {
    const listTotal = selTotal();
    $('#splitBody').innerHTML = `<div class="stack-lg">
      <div class="stack">
        <label class="field"><span>Valor da conta</span>
          <div class="money"><span>R$</span><input class="input" id="splitTotal" inputmode="decimal" placeholder="0,00" value="${esc(split.total)}" autocomplete="off"></div>
        </label>
        ${listTotal ? `<button type="button" class="link-btn" id="useList">Usar o total da sua lista (${brl(listTotal)})</button>` : ''}
      </div>
      <div class="field"><span>Quantas pessoas?</span>
        <div class="stepper">
          <button type="button" id="pMinus" aria-label="Menos uma pessoa">${icon('minus')}</button>
          <output id="pOut" aria-live="polite"></output>
          <button type="button" id="pPlus" aria-label="Mais uma pessoa">${icon('plus')}</button>
        </div>
      </div>
      <label class="switch-row"><span>Incluir ${R.taxaServico}% de serviço</span>
        <span class="switch"><input type="checkbox" id="svc" ${split.servico ? 'checked' : ''}><span></span></span></label>
      <div class="result" id="splitResult" aria-live="polite"></div>
    </div>`;
    updateSplit();
  }
  const parseMoney = (s) => {
    const clean = String(s).replace(/[^\d,.]/g, '');
    const n = clean.includes(',') ? clean.replace(/\./g, '').replace(',', '.') : clean;
    return parseFloat(n) || 0;
  };
  function updateSplit() {
    const total = parseMoney(split.total);
    const svc = split.servico ? total * (R.taxaServico / 100) : 0;
    const each = (total + svc) / split.pessoas;
    $('#pOut').innerHTML = `<b>${split.pessoas}</b>${split.pessoas === 1 ? 'pessoa' : 'pessoas'}`;
    $('#splitResult').innerHTML = `<small>Cada pessoa paga</small><strong>${brl(each)}</strong>
      <dl><dt>Consumo</dt><dd>${brl(total)}</dd>
      <dt>Serviço (${split.servico ? R.taxaServico : 0}%)</dt><dd>${brl(svc)}</dd>
      <dt>Total</dt><dd>${brl(total + svc)}</dd></dl>`;
  }
  $('#sh-split').addEventListener('sheet:open', renderSplit);
  $('#splitBody').addEventListener('input', (e) => {
    if (e.target.id === 'splitTotal') split.total = e.target.value;
    if (e.target.id === 'svc') split.servico = e.target.checked;
    updateSplit();
  });
  $('#splitBody').addEventListener('click', (e) => {
    if (e.target.closest('#pMinus')) split.pessoas = Math.max(1, split.pessoas - 1);
    else if (e.target.closest('#pPlus')) split.pessoas = Math.min(30, split.pessoas + 1);
    else if (e.target.closest('#useList')) {
      split.total = selTotal().toFixed(2).replace('.', ',');
      $('#splitTotal').value = split.total;
    } else return;
    updateSplit();
  });

  /* ---------------- Comentário anônimo ---------------- */
  const TAGS_FB = ['Comida', 'Atendimento', 'Tempo de espera', 'Ambiente', 'Preço', 'Limpeza'];
  const STAR_TXT = ['', 'Ruim', 'Pode melhorar', 'Boa', 'Muito boa', 'Excelente'];
  const fb = { estrelas: 0, tags: [], texto: '', incluirMesa: false };
  const FB_WAIT = 10 * 60e3;

  function renderFeedback() {
    const last = Number(safeGet('nfc-fb-enviado') || 0);
    if (Date.now() - last < FB_WAIT) return renderFbDone(true);
    $('#fbBody').innerHTML = `<form class="stack-lg" id="fbForm" novalidate>
      <div class="stack">
        <span class="label" id="starsLbl">Como foi sua experiência?</span>
        <div class="stars" role="radiogroup" aria-labelledby="starsLbl">
          ${[1, 2, 3, 4, 5].map((n) => `<button type="button" role="radio" aria-checked="${fb.estrelas === n}" aria-label="${n} de 5 — ${STAR_TXT[n]}" data-star="${n}" class="${n <= fb.estrelas ? 'is-on' : ''}">${icon('star')}</button>`).join('')}
        </div>
        <p class="star-label" id="starTxt">${STAR_TXT[fb.estrelas] || '&nbsp;'}</p>
      </div>
      <div class="stack"><span class="label">O que marcou sua visita?</span>
        <div class="chips-wrap">${TAGS_FB.map((t) => `<button type="button" class="chip" aria-pressed="${fb.tags.includes(t)}" data-tag="${t}">${t}</button>`).join('')}</div>
      </div>
      <label class="field"><span>Conte para a gente (opcional)</span>
        <textarea class="textarea" id="fbText" maxlength="500" placeholder="Elogio, sugestão ou algo que não foi bem">${esc(fb.texto)}</textarea>
        <span class="counter" id="fbCount">${fb.texto.length}/500</span>
      </label>
      ${mesa ? `<label class="check-row"><input type="checkbox" id="fbMesa" ${fb.incluirMesa ? 'checked' : ''}> Incluir o número da mesa (${mesa})</label>` : ''}
      <p class="note">${icon('lock')}<span>Não pedimos nome, e-mail nem telefone. A gerência lê cada comentário.</span></p>
      <button type="submit" class="btn btn-cobalt btn-block" id="fbSend">Enviar comentário</button>
    </form>`;
  }
  function renderFbDone(recent) {
    $('#fbBody').innerHTML = `<div class="done">
      <span class="done-mark">${icon('check')}</span>
      <h3>Recebido</h3>
      <p class="muted">${recent ? 'Você já enviou um comentário há pouco. Obrigado por contar como foi.' : 'Obrigado por contar como foi. Seu comentário chegou à gerência.'}</p>
      <a class="btn btn-line" href="${esc(googleUrl())}" target="_blank" rel="noopener">${icon('star')} Avaliar também no Google</a>
      <button type="button" class="btn btn-quiet" data-close>Fechar</button>
    </div>`;
  }
  $('#sh-feedback').addEventListener('sheet:open', renderFeedback);
  $('#fbBody').addEventListener('click', (e) => {
    const s = e.target.closest('[data-star]');
    if (s) {
      fb.estrelas = +s.dataset.star;
      $$('[data-star]').forEach((b) => {
        const n = +b.dataset.star;
        b.classList.toggle('is-on', n <= fb.estrelas);
        b.setAttribute('aria-checked', n === fb.estrelas);
      });
      $('#starTxt').textContent = STAR_TXT[fb.estrelas];
      navigator.vibrate && navigator.vibrate(6);
    }
    const t = e.target.closest('[data-tag]');
    if (t) {
      const tag = t.dataset.tag;
      fb.tags = fb.tags.includes(tag) ? fb.tags.filter((x) => x !== tag) : [...fb.tags, tag];
      t.setAttribute('aria-pressed', fb.tags.includes(tag));
    }
  });
  $('#fbBody').addEventListener('input', (e) => {
    if (e.target.id === 'fbText') {
      fb.texto = e.target.value;
      $('#fbCount').textContent = `${fb.texto.length}/500`;
    }
    if (e.target.id === 'fbMesa') fb.incluirMesa = e.target.checked;
  });
  $('#fbBody').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!fb.estrelas) {
      toast('Escolha de 1 a 5 estrelas para enviar.', { tone: 'error' });
      $('[data-star]').focus();
      return;
    }
    const btn = $('#fbSend');
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      await store.createFeedback({
        estrelas: fb.estrelas,
        tags: fb.tags,
        texto: fb.texto.trim().slice(0, 500) || null,
        mesa: fb.incluirMesa && mesa ? mesa : null,
      });
      safeSet('nfc-fb-enviado', String(Date.now()));
      Object.assign(fb, { estrelas: 0, tags: [], texto: '', incluirMesa: false });
      renderFbDone(false);
    } catch {
      btn.disabled = false;
      btn.textContent = 'Enviar comentário';
      toast('O comentário não foi enviado. Confira sua conexão e tente de novo.', { tone: 'error', ms: 4200 });
    }
  });

  /* ---------------- Ícones estáticos ---------------- */
  $$('[data-close].icon-btn').forEach((b) => (b.innerHTML = icon(b.closest('.menu-bar') ? 'left' : 'x')));
  $('.menu-search-icon').innerHTML = icon('search');

  /* ---------------- Início ---------------- */
  function boot() {
    if (mesa && !(mesa >= 1 && mesa <= live.mesas.total)) mesa = null;
    renderTop();
    renderPlate();
    renderReasons();
    loadSel();
    renderMenu();
    renderSelBar();
    const id = mesa && safeGet(activeKey());
    if (id) watchActive(id);
    else showStatus(null);
    sess = null;
    renderGate();
    if (mesa) atualizarSessao();
  }

  async function resolverTag() {
    if (!tag) return;
    try {
      mesa = await store.mesaDaEtiqueta(tag);
      tagNova = !mesa;
    } catch (e) {
      console.error(e);
      mesa = null;
    }
  }

  store
    .init()
    .catch((err) => {
      console.error(err);
      if (err.code === 'SEM_RESTAURANTE') {
        UI.semRestaurante();
        return new Promise(() => {}); // para aqui
      }
      toast('Sem conexão com o restaurante. Algumas funções podem não responder.', { tone: 'error', ms: 5000 });
    })
    .then(() => store.getSettings().catch(() => live))
    .then((s) => {
      if (s) live = s;
      R = live.restaurante;
    })
    .then(resolverTag)
    .finally(() => {
      boot();
      renderTiles();
      renderInfo();
      setInterval(renderTop, 60e3);
    });
})();
