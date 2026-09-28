/* Painel da equipe — recebe os chamados das mesas em tempo real. */
(function () {
  const cfg = window.NFC_CONFIG;
  const { $, $$, esc, brl, pad, icon, toast, copyText, qrSvg, clock, ago, hhmm, secondsSince, openSheet, closeSheet,
    instagramHandle, initials, safeUrl } = UI;
  const store = Store.create();
  const isDemo = store.mode === 'local';

  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const set = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
  const uid = () => (crypto.randomUUID && crypto.randomUUID()) || Date.now().toString(36) + Math.random().toString(36).slice(2);

  const S = {
    user: null,
    settings: {
      restaurante: cfg.restaurante,
      wifi: cfg.wifi,
      cardapio: cfg.cardapio,
      mesas: cfg.mesasPadrao,
      widgets: cfg.widgetsPadrao,
      equipe: { pin: cfg.equipe.pin },
    },
    widgetEdit: null,
    itemEdit: null,
    ajTab: 'restaurante',
    view: 'chamados',
    filtro: 'abertos',
    fbFiltro: 'todos',
    calls: [],
    fb: [],
    seen: new Set(),
    seenFb: new Set(),
    fresh: new Map(),
    ready: false,
    online: true,
    mesaAberta: null,
    som: get('nfc-som') !== '0',
    lembrete: get('nfc-lembrete') !== '0',
    telaLigada: get('nfc-tela') === '1',
  };

  const VIEWS = [
    { id: 'chamados', label: 'Chamados', icon: 'bell' },
    { id: 'salao', label: 'Salão', icon: 'grid' },
    { id: 'comentarios', label: 'Comentários', icon: 'msg' },
    { id: 'plaquinhas', label: 'Mesas', icon: 'nfc' },
    { id: 'ajustes', label: 'Ajustes', icon: 'sliders' },
  ];

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
  const pinEquipe = () => String((S.settings.equipe && S.settings.equipe.pin) || cfg.equipe.pin);

  /* ============================== Entrada ============================== */
  function showLogin(msg = '') {
    $('#shell').hidden = true;
    $('#login').hidden = false;
    $('#loginBrand').textContent = nomeRest();
    const nome = get('nfc-equipe-nome') || '';
    $('#loginForm').innerHTML = isDemo
      ? `<label class="field"><span>Seu nome</span><input class="input" id="lgNome" autocomplete="name" required value="${esc(nome)}" placeholder="Como a mesa vai ver você"></label>
         <label class="field"><span>PIN da equipe</span><input class="input pin-input" id="lgPin" inputmode="numeric" type="password" maxlength="8" autocomplete="off" required></label>
         <p class="form-error" id="lgErr" role="alert">${esc(msg)}</p>
         <button class="btn btn-cobalt btn-block" type="submit">Entrar no painel</button>
         ${pinEquipe() === String(cfg.equipe.pin) ? `<p class="login-hint">Modo demonstração · PIN inicial ${esc(cfg.equipe.pin)}</p>` : ''}`
      : `<label class="field"><span>Seu nome</span><input class="input" id="lgNome" autocomplete="name" required value="${esc(nome)}" placeholder="Como a mesa vai ver você"></label>
         <label class="field"><span>E-mail</span><input class="input" id="lgEmail" type="email" autocomplete="username" required></label>
         <label class="field"><span>Senha</span><input class="input" id="lgSenha" type="password" autocomplete="current-password" required></label>
         <p class="form-error" id="lgErr" role="alert">${esc(msg)}</p>
         <button class="btn btn-cobalt btn-block" type="submit">Entrar no painel</button>`;
    setTimeout(() => (nome ? $('#lgPin, #lgEmail') : $('#lgNome')).focus(), 50);
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nome = $('#lgNome').value.trim();
    const err = $('#lgErr');
    if (!nome) {
      err.textContent = 'Informe seu nome. Ele aparece para a mesa quando você estiver a caminho.';
      return $('#lgNome').focus();
    }
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      if (isDemo) {
        if ($('#lgPin').value !== pinEquipe()) throw new Error('PIN incorreto. Confira com a gerência.');
        set('nfc-equipe', JSON.stringify({ nome, exp: Date.now() + 12 * 3600e3 }));
      } else {
        await store.auth.signIn($('#lgEmail').value.trim(), $('#lgSenha').value);
      }
      set('nfc-equipe-nome', nome);
      S.user = { nome };
      unlockAudio();
      startApp();
    } catch (ex) {
      err.textContent = ex.message === 'Invalid login credentials' ? 'E-mail ou senha incorretos.' : ex.message;
      btn.disabled = false;
    }
  });

  async function logout() {
    set('nfc-equipe', null);
    if (store.auth) await store.auth.signOut();
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

  function notify(c) {
    if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
    try {
      const n = new Notification(`Mesa ${c.mesa} · ${motivo(c.tipo).label}`, {
        body: c.nota || (c.pagamento ? `Pagamento: ${c.pagamento}` : 'Toque para abrir o painel'),
        tag: c.id,
        icon: 'assets/img/icon.svg',
      });
      n.onclick = () => { window.focus(); n.close(); };
    } catch {}
  }

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
      const [calls, fb] = await Promise.all([store.listCalls({ desde: desde() }), store.listFeedback()]);
      S.calls = calls || [];
      S.fb = fb || [];
      S.online = true;
    } catch (e) {
      console.error(e);
      S.online = false;
    }
    detectNew();
    renderChrome();
    if (['chamados', 'salao', 'comentarios'].includes(S.view)) renderView();
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
    if (novosFb) toast(novosFb === 1 ? 'Novo comentário anônimo recebido.' : `${novosFb} comentários novos.`, {
      action: S.view !== 'comentarios' ? { label: 'Ler', run: () => go('comentarios') } : null,
    });
    const abertos = S.calls.filter((c) => c.status === 'aberto').length;
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
      abertos: S.calls.filter((c) => c.status === 'aberto').length,
      caminho: S.calls.filter((c) => c.status === 'a_caminho').length,
      naoLidos: S.fb.filter((f) => !f.lido).length,
    };
  }
  const badgeFor = (id, n) => {
    if (id === 'chamados' && n.abertos) return `<span class="badge">${n.abertos}</span>`;
    if (id === 'comentarios' && n.naoLidos) return `<span class="badge badge--soft">${n.naoLidos}</span>`;
    return '';
  };

  function renderChrome() {
    const n = counts();
    $('#sideBrand').textContent = nomeRest();
    const logo = safeUrl(S.settings.restaurante.logo);
    const mark = $('.side-mark');
    mark.classList.toggle('has-logo', !!logo);
    mark.innerHTML = logo ? `<img src="${esc(logo)}" alt="">` : '';
    $('#sideNav').innerHTML = VIEWS.map(
      (v) => `<a class="nav-item" href="#${v.id}" ${S.view === v.id ? 'aria-current="page"' : ''}>${icon(v.icon)}<span>${v.label}</span>${badgeFor(v.id, n)}</a>`
    ).join('');
    $('#tabbar').innerHTML = VIEWS.map(
      (v) => `<a class="tab" href="#${v.id}" ${S.view === v.id ? 'aria-current="page"' : ''}>${icon(v.icon)}<span>${v.label}</span>${badgeFor(v.id, n)}</a>`
    ).join('');
    $('#sideFoot').innerHTML = `
      <span class="live ${S.online ? '' : 'is-off'}">${S.online ? (isDemo ? 'Ao vivo · modo demonstração' : 'Ao vivo') : 'Sem conexão'}</span>
      <div class="side-user"><span class="avatar">${esc(firstName(S.user.nome)[0] || '?').toUpperCase()}</span>
        <div>${esc(S.user.nome)}<small>Em serviço</small></div></div>
      <div class="side-tools">
        <button class="icon-btn" type="button" data-tool="som" aria-pressed="${S.som}" aria-label="${S.som ? 'Silenciar alertas' : 'Ativar som dos alertas'}" title="Som dos alertas">${icon(S.som ? 'volume' : 'mute')}</button>
        <button class="icon-btn" type="button" data-tool="tema" aria-label="Alternar tema claro/escuro" title="Tema">${icon(isDark() ? 'sun' : 'moon')}</button>
        <button class="icon-btn" type="button" data-tool="sair" aria-label="Sair" title="Sair">${icon('logout')}</button>
      </div>`;
    $('#mtopTitle').textContent = VIEWS.find((v) => v.id === S.view).label;
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

  function go(view) {
    location.hash = view;
  }
  function route() {
    const v = location.hash.replace('#', '');
    S.view = VIEWS.some((x) => x.id === v) ? v : 'chamados';
    renderChrome();
    renderView();
    $('#main').scrollTop = 0;
    window.scrollTo(0, 0);
  }

  /* ============================== Telas ============================== */
  function renderView() {
    const main = $('#main');
    main.dataset.view = S.view;
    main.innerHTML = { chamados: vChamados, salao: vSalao, comentarios: vComentarios, plaquinhas: vPlaquinhas, ajustes: vAjustes }[S.view]();
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
        <p class="ccard-meta">${esc(areaDe(c.mesa))} · ${hhmm(c.criado_em)}${done && c.atendente ? ` · ${esc(firstName(c.atendente))}` : ''}</p>
        ${c.pagamento ? `<span class="ccard-pay">Pagamento: ${esc(c.pagamento)}</span>` : ''}
        ${c.nota ? `<p class="ccard-note">“${esc(c.nota)}”</p>` : ''}
        ${itens}
        ${c.status === 'a_caminho' ? `<p class="ccard-who">${icon('arrow')} ${esc(firstName(c.atendente))} a caminho · ${ago(c.visto_em || c.atualizado_em)}</p>` : ''}
        ${done ? '' : `<div class="ccard-actions">
          ${c.status === 'aberto' ? `<button type="button" class="btn btn-cobalt" data-act="ir" data-id="${c.id}">Estou indo</button>` : ''}
          <button type="button" class="btn ${c.status === 'a_caminho' ? 'btn-primary' : 'btn-quiet'}" data-act="ok" data-id="${c.id}">${icon('check')} Resolvido</button>
        </div>`}
      </div>
    </article>`;
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
        <div class="${abertos.length ? 'is-alert' : ''}"><dt>Aguardando</dt><dd>${abertos.length}</dd></div>
        <div><dt>A caminho</dt><dd>${caminho.length}</dd></div>
        <div class="${atrasados ? 'is-alert' : ''}"><dt>Mais de ${LATE} min</dt><dd>${atrasados}</dd></div>
        <div><dt>Resposta média</dt><dd>${resp ? `${resp.v}<small>${resp.u}</small>` : '—'}</dd></div>
      </dl>
      <div class="board">
        <div>
          <div class="toolbar">
            <div class="seg" role="radiogroup" aria-label="Filtrar chamados">
              <button type="button" role="radio" aria-checked="${S.filtro === 'abertos'}" data-filtro="abertos">Em aberto (${abertos.length + caminho.length})</button>
              <button type="button" role="radio" aria-checked="${S.filtro === 'feitos'}" data-filtro="feitos">Concluídos (${feitos.length})</button>
            </div>
          </div>
          ${list.length ? `<div class="calls">${list.map(callCard).join('')}</div>` : empty}
        </div>
        <aside class="rail" aria-label="Mesas agora"><h2>Mesas agora</h2>${mesasGrid(1, S.settings.mesas.total)}
          <div class="legend"><span><i class="l-call"></i>Chamando</span><span><i class="l-go"></i>A caminho</span></div></aside>
      </div>`;
  }

  /* ---------- Salão ---------- */
  function mesaState(n) {
    const ativos = S.calls.filter((c) => c.mesa === n && (c.status === 'aberto' || c.status === 'a_caminho'));
    const aberto = ativos.find((c) => c.status === 'aberto');
    return { st: aberto ? 'aberto' : ativos.length ? 'a_caminho' : 'livre', call: aberto || ativos[0], hoje: S.calls.filter((c) => c.mesa === n).length };
  }
  function mesasGrid(de, ate) {
    let h = '<div class="mesas">';
    for (let n = de; n <= ate; n++) {
      const s = mesaState(n);
      const label = s.st === 'aberto' ? `Chamando · <span data-since="${s.call.criado_em}">${clock(s.call.criado_em)}</span>`
        : s.st === 'a_caminho' ? `${esc(firstName(s.call.atendente))} a caminho`
        : s.hoje ? `${s.hoje} ${s.hoje === 1 ? 'chamado' : 'chamados'} hoje` : 'Sem chamados';
      h += `<button type="button" class="mesa" data-mesa="${n}" data-st="${s.st}" aria-label="Mesa ${n}"><span class="mesa-n">${pad(n)}</span><span class="mesa-st">${label}</span></button>`;
    }
    return h + '</div>';
  }
  function vSalao() {
    return `<div class="vhead"><div><h1>Salão</h1><p>Toque em uma mesa para ver os chamados de hoje e o link da plaquinha.</p></div>
        <div class="legend"><span><i class="l-call"></i>Chamando</span><span><i class="l-go"></i>A caminho</span><span><i></i>Sem chamado aberto</span></div></div>
      ${S.settings.mesas.areas.map((a) => {
        let n = 0;
        for (let i = a.de; i <= a.ate; i++) if (mesaState(i).st === 'aberto') n++;
        return `<section class="area"><h2>${esc(a.nome)} <small>Mesas ${a.de}–${a.ate}${n ? ` · ${n} chamando` : ''}</small></h2>${mesasGrid(a.de, a.ate)}</section>`;
      }).join('')}`;
  }

  function renderMesaSheet(n) {
    $('#mesaTitle').textContent = `Mesa ${pad(n)}`;
    const calls = S.calls.filter((c) => c.mesa === n).sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em));
    $('#mesaBody').innerHTML = `<div class="stack">
      <p class="muted">${esc(areaDe(n))} · ${calls.length} ${calls.length === 1 ? 'chamado' : 'chamados'} nas últimas 16 horas</p>
      ${calls.length ? `<div class="calls">${calls.map(callCard).join('')}</div>` : '<p class="note">Esta mesa ainda não fez chamados hoje.</p>'}
      <div class="vhead-actions">
        <a class="btn btn-line btn-sm" href="${esc(tableUrl(n))}" target="_blank" rel="noopener">${icon('external')} Abrir página da mesa</a>
        <button type="button" class="btn btn-quiet btn-sm" data-qr="${n}">${icon('qr')} QR da mesa</button>
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

  /* ---------- Plaquinhas ---------- */
  // Página da mesa (cliente) fica na raiz do site, sem extensão na URL —
  // não em 'index.html' relativo, pois o painel agora mora em /admin/.
  const defaultBase = () => new URL('/', location.origin).href;
  const baseUrl = () => get('nfc-base-url') || defaultBase();
  const tableUrl = (n) => {
    const u = new URL(baseUrl(), location.href);
    u.searchParams.set('mesa', n);
    return u.href;
  };
  const canNfc = 'NDEFReader' in window;

  function vPlaquinhas() {
    let cards = '';
    for (let n = 1; n <= S.settings.mesas.total; n++) {
      cards += `<article class="tagcard">
        <div class="mini-plate"><small>Mesa</small><b>${pad(n)}</b></div>
        <div style="min-width:0"><div class="tagcard-area">${esc(areaDe(n))}</div><div class="tagcard-url" title="${esc(tableUrl(n))}">${esc(tableUrl(n).replace(/^https?:\/\//, ''))}</div></div>
        <div class="tagcard-actions">
          ${canNfc ? `<button type="button" class="btn btn-cobalt" data-nfc="${n}">${icon('nfc')} Gravar</button>` : ''}
          <button type="button" class="btn btn-quiet" data-copy="${n}">${icon('copy')} Copiar link</button>
          <button type="button" class="btn btn-quiet" data-qr="${n}">${icon('qr')} QR</button>
          <a class="btn btn-quiet" href="${esc(tableUrl(n))}" target="_blank" rel="noopener" aria-label="Testar mesa ${n}">${icon('external')}</a>
        </div></article>`;
    }
    const areas = S.settings.mesas.areas;
    const mesasCfg = `<div class="panel stack" id="mesasCfg">
        <h2>Quantidade de mesas</h2>
        <label class="field" style="max-width:220px"><span>Total no restaurante</span>
          <input class="input mono" id="totalMesas" type="number" min="1" max="300" value="${S.settings.mesas.total}"></label>
        <h2 style="margin-top:6px">Áreas do salão</h2>
        <p class="muted" style="font-size:13px">Dê nome aos grupos de mesa (salão, varanda, mezanino…). Uma mesa fora de qualquer faixa aparece sem área.</p>
        <div class="arows">${areas.map((a, i) => `<div class="arow" data-area-idx="${i}">
            <input class="input" data-afield="nome" value="${esc(a.nome)}" placeholder="Nome da área" aria-label="Nome da área">
            <input class="input mono" data-afield="de" type="number" min="1" value="${a.de}" aria-label="Primeira mesa da área">
            <span class="arow-sep">–</span>
            <input class="input mono" data-afield="ate" type="number" min="1" value="${a.ate}" aria-label="Última mesa da área">
            <button type="button" class="icon-btn" data-area="del" aria-label="Remover área">${icon('trash')}</button>
          </div>`).join('') || '<p class="muted">Nenhuma área cadastrada — todas as mesas aparecem sem nome.</p>'}</div>
        <button type="button" class="btn btn-line btn-sm" data-area="add">${icon('plus')} Adicionar área</button>
      </div>`;
    return `<div class="vhead"><div><h1>Mesas</h1><p>Quantidade de mesas, áreas do salão e a plaquinha de cada uma.</p></div>
        <div class="vhead-actions"><button type="button" class="btn btn-line btn-sm" id="printAll">${icon('printer')} Imprimir QR de todas</button></div></div>
      ${mesasCfg}
      <div class="howto">
        <div class="panel stack"><h2>Como gravar uma plaquinha</h2>
          <ol>
            <li>Use etiquetas NFC <strong>NTAG213</strong> ou <strong>NTAG215</strong> (adesivo ou moeda).</li>
            ${canNfc
              ? '<li>Toque em <strong>Gravar</strong> na mesa desejada e encoste a etiqueta atrás deste celular.</li>'
              : '<li>Neste aparelho, use o app gratuito <strong>NFC Tools</strong>: Escrever › Adicionar registro › URL, e cole o link copiado.</li><li>No Android com Chrome, este painel grava a etiqueta direto pelo botão “Gravar”.</li>'}
            <li>Teste encostando outro celular: a página da mesa certa deve abrir.</li>
            <li>Depois de testar, bloqueie a etiqueta (no NFC Tools: Outros › Bloquear) para ninguém regravar.</li>
          </ol></div>
        <div class="panel stack"><h2>Endereço da página da mesa</h2>
          <label class="field"><span>Link base publicado</span><input class="input mono" id="baseUrl" value="${esc(baseUrl())}" spellcheck="false" autocomplete="off"></label>
          <p class="muted" style="font-size:13px">O número da mesa é adicionado ao final (<code>?mesa=12</code>). Altere se publicar a página em outro domínio.</p>
        </div>
      </div>
      <div class="tags-grid">${cards}</div>`;
  }

  const saveMesas = (patch) => saveSettings({ mesas: { ...S.settings.mesas, ...patch } });


  async function gravarNfc(n, btn) {
    const label = btn.innerHTML;
    try {
      btn.disabled = true;
      btn.textContent = 'Encoste a etiqueta…';
      const nd = new NDEFReader();
      await nd.write({ records: [{ recordType: 'url', data: tableUrl(n) }] });
      toast(`Plaquinha da mesa ${n} gravada.`, { tone: 'ok' });
    } catch (e) {
      toast(e.name === 'NotAllowedError' ? 'Permita o uso de NFC para gravar.' : `Não foi possível gravar: ${e.message}`, { tone: 'error', ms: 4500 });
    } finally {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  }

  function openQr(n) {
    $('#qrTitle').textContent = `QR · Mesa ${pad(n)}`;
    $('#qrBody').innerHTML = `<div class="qr-big">
      <div class="qr">${qrSvg(tableUrl(n), { cell: 8, margin: 1 })}</div>
      <code>${esc(tableUrl(n))}</code>
      <div class="vhead-actions"><button type="button" class="btn btn-quiet btn-sm" data-copy="${n}">${icon('copy')} Copiar link</button>
      <button type="button" class="btn btn-line btn-sm" data-print="${n}">${icon('printer')} Imprimir</button></div></div>`;
    openSheet('sh-qr');
  }

  function printQrs(list) {
    $('#printArea').innerHTML = list.map((n) => `<div class="print-card"><small>Mesa</small><b>${pad(n)}</b>
      <div class="qr">${qrSvg(tableUrl(n), { cell: 4, margin: 0 })}</div>
      <p>Encoste o celular na plaquinha ou aponte a câmera para o código</p></div>`).join('');
    setTimeout(() => window.print(), 50);
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
      toast(/espaço/i.test(e.message || '') ? e.message : 'Não foi possível salvar. Confira a conexão e tente de novo.', { tone: 'error', ms: 4500 });
      return false;
    }
  }
  const saveRestaurante = (patch) => saveSettings({ restaurante: { ...S.settings.restaurante, ...patch } });

  /* ---------- Widgets do cliente ---------- */
  const WIDGET_ICON = { cardapio: 'book', wifi: 'wifi', dividir: 'users', google: 'star', comentario: 'msg' };
  const WIDGET_LABEL = { cardapio: 'Cardápio', wifi: 'Wi-Fi', dividir: 'Dividir a conta', google: 'Avaliar no Google', comentario: 'Comentário anônimo' };
  const WIDGET_ICONS = [
    ['link', 'Link'], ['book', 'Livro'], ['star', 'Estrela'], ['msg', 'Mensagem'], ['wifi', 'Wi-Fi'],
    ['users', 'Pessoas'], ['printer', 'Impressora'], ['qr', 'QR'], ['sparkle', 'Destaque'],
    ['pin', 'Local'], ['clock', 'Horário'], ['instagram', 'Instagram'],
  ];
  function builtinSub(tipo) {
    const r = S.settings.restaurante;
    if (tipo === 'cardapio') {
      const n = S.settings.cardapio.reduce((s, c) => s + c.itens.length, 0);
      return `${n} ${n === 1 ? 'item' : 'itens'} · edite na aba Cardápio`;
    }
    if (tipo === 'wifi') return S.settings.wifi.rede ? `Rede ${S.settings.wifi.rede} · edite na aba Restaurante` : 'Rede não informada · edite na aba Restaurante';
    if (tipo === 'google') return r.googleUrl ? 'Link de avaliação configurado' : 'Sem link: abre a busca do Google pelo nome';
    if (tipo === 'dividir') return `Serviço de ${Number(r.taxaServico) || 0}%`;
    if (tipo === 'comentario') return 'Chega na aba Comentários';
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
  ];
  const DIAS = [[1, 'Segunda'], [2, 'Terça'], [3, 'Quarta'], [4, 'Quinta'], [5, 'Sexta'], [6, 'Sábado'], [0, 'Domingo']];

  function vAjustes() {
    const tab = AJ_TABS.find((t) => t.id === S.ajTab) || AJ_TABS[0];
    const body = { restaurante: ajRestaurante, cardapio: ajCardapio, widgets: ajWidgets, aparelho: ajAparelho }[tab.id]();
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
    const pinAtual = (S.settings.equipe && S.settings.equipe.pin) || cfg.equipe.pin;

    return `<div class="aj-grid">
      <section class="panel stack aj-brand" aria-labelledby="hMarca">
        <h2 id="hMarca">Logo e foto de capa</h2>
        <div class="brand-preview" id="brandPreview">${brandPreview()}</div>
        <div class="img-slots">
          <div class="img-slot"><div><b>Foto de capa</b><small>Foto horizontal do salão ou de um prato. A imagem é ajustada sozinha.</small></div>
            <div class="vhead-actions">${fileBtn('capa', capa)}</div></div>
          <div class="img-slot"><div><b>Logo</b><small>Imagem quadrada; aparece dentro do círculo.</small></div>
            <div class="vhead-actions">${fileBtn('logo', logo)}</div></div>
        </div>
      </section>

      <section class="panel stack" aria-labelledby="hInfo">
        <h2 id="hInfo">Informações</h2>
        <label class="field"><span>Nome do restaurante</span><input class="input" data-r="nome" required maxlength="40" value="${esc(r.nome)}" autocomplete="organization"></label>
        <label class="field"><span>Frase curta (opcional)</span><input class="input" data-r="descricao" maxlength="60" value="${esc(r.descricao || '')}" placeholder="Ex.: Cozinha de brasa e horta"></label>
        <label class="field"><span>Endereço</span><input class="input" data-r="endereco" maxlength="120" value="${esc(r.endereco || '')}" placeholder="Rua, número — bairro, cidade" autocomplete="street-address"></label>
        <label class="field"><span>Instagram</span><input class="input" data-r="instagram" maxlength="80" value="${esc(instagramHandle(r.instagram) ? '@' + instagramHandle(r.instagram) : '')}" placeholder="@seurestaurante" autocapitalize="off" spellcheck="false"></label>
        <label class="field"><span>Link de avaliação do Google</span><input class="input" data-r="googleUrl" type="url" value="${esc(r.googleUrl || '')}" placeholder="https://g.page/r/…/review" spellcheck="false">
          <small class="help">No Perfil da Empresa no Google, toque em “Pedir avaliações” e cole o link aqui. Sem link, o botão abre a busca do Google pelo nome do restaurante.</small></label>
        <label class="field field-narrow"><span>Taxa de serviço (%)</span><input class="input mono" data-r="taxaServico" type="number" min="0" max="30" step="1" inputmode="numeric" value="${Number(r.taxaServico) || 0}">
          <small class="help">Usada na calculadora “Dividir a conta”.</small></label>
      </section>

      <section class="panel stack" aria-labelledby="hWifi">
        <h2 id="hWifi">Wi-Fi dos clientes</h2>
        <label class="field"><span>Nome da rede</span><input class="input" data-wf="rede" maxlength="32" value="${esc(w.rede || '')}" autocapitalize="off" spellcheck="false"></label>
        <label class="field"><span>Senha</span><input class="input mono" data-wf="senha" maxlength="63" value="${esc(aberta ? '' : w.senha || '')}" ${aberta ? 'disabled placeholder="Rede sem senha"' : ''} autocapitalize="off" autocomplete="off" spellcheck="false"></label>
        <label class="set-inline"><span>Rede aberta, sem senha</span><span class="switch"><input type="checkbox" data-wf="aberta" ${aberta ? 'checked' : ''}><span></span></span></label>
      </section>

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

      ${isDemo ? `<section class="panel stack" aria-labelledby="hPin">
        <h2 id="hPin">Acesso da equipe</h2>
        <label class="field field-narrow"><span>PIN para entrar no painel</span><input class="input pin-input" data-pin inputmode="numeric" maxlength="8" pattern="[0-9]{4,8}" value="${esc(pinAtual)}" autocomplete="off"></label>
        <small class="help">De 4 a 8 números. Quem já está conectado continua entrando normalmente.</small>
      </section>` : ''}

      <a class="btn btn-line aj-view" href="/?mesa=1" target="_blank" rel="noopener">${icon('external')} Ver a página da mesa como o cliente</a>
    </div>`;
  }

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
      if (tipo === 'logo') {
        const lado = Math.min(sw, sh);
        sx = (sw - lado) / 2;
        sy = (sh - lado) / 2;
        sw = sh = lado;
        w = h = Math.min(480, lado);
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
              <span class="mc-body"><b>${esc(it.nome)}</b>${it.desc ? `<small>${esc(it.desc)}</small>` : ''}<span class="tags">${selos(it)}</span></span>
              <span class="price">${brl(it.preco)}</span>
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

  function openItem(ci, ii) {
    S.itemEdit = { ci, ii };
    const editing = ii != null;
    const it = editing ? S.settings.cardapio[ci].itens[ii] : { nome: '', desc: '', preco: '', tags: [], destaque: false };
    $('#itemTitle').textContent = editing ? 'Editar prato' : 'Novo prato';
    $('#itemBody').innerHTML = `<form class="stack" id="itemForm" novalidate>
      <label class="field"><span>Nome</span><input class="input" id="itNome" required maxlength="60" value="${esc(it.nome)}" placeholder="Ex.: Mandioca na brasa"></label>
      <label class="field"><span>Descrição (opcional)</span><textarea class="textarea" id="itDesc" maxlength="160" rows="3" placeholder="Ingredientes, porção, acompanhamentos">${esc(it.desc || '')}</textarea></label>
      <div class="item-row">
        <label class="field"><span>Preço</span><div class="money"><span>R$</span><input class="input mono" id="itPreco" inputmode="decimal" required value="${it.preco === '' ? '' : String(Number(it.preco).toFixed(2)).replace('.', ',')}" placeholder="0,00"></div></label>
        <label class="field"><span>Categoria</span><select class="input" id="itCat">${S.settings.cardapio.map((c, i) => `<option value="${i}" ${i === ci ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select></label>
      </div>
      <div class="field"><span>Selos</span><div class="chips-wrap">${Object.entries(cfg.tags).map(([k, l]) => `<button type="button" class="chip" data-selo="${k}" aria-pressed="${(it.tags || []).includes(k)}">${esc(l)}</button>`).join('')}</div></div>
      <label class="set-inline"><span>Destaque da casa<small>Mostra o selo “Da casa” no prato.</small></span><span class="switch"><input type="checkbox" id="itDestaque" ${it.destaque ? 'checked' : ''}><span></span></span></label>
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
  function ajAparelho() {
    const tema = temaAtual();
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    return `<div class="settings">
        <div class="set-row"><div><h3>Som dos alertas</h3><p>Toca um sino quando uma mesa chama.</p></div>
          <div class="vhead-actions"><button type="button" class="btn btn-quiet btn-sm" data-set="testar">Testar</button>
          <label class="switch"><input type="checkbox" data-set="som" ${S.som ? 'checked' : ''} aria-label="Som dos alertas"><span></span></label></div></div>
        <div class="set-row"><div><h3>Lembrete de atrasados</h3><p>Repete o sino a cada 90 s enquanto houver chamado com mais de ${LATE} min.</p></div>
          <label class="switch"><input type="checkbox" data-set="lembrete" ${S.lembrete ? 'checked' : ''} aria-label="Lembrete de atrasados"><span></span></label></div>
        <div class="set-row"><div><h3>Notificações do sistema</h3><p>${perm === 'granted' ? 'Ativadas. Você recebe avisos mesmo com o painel em segundo plano.' : perm === 'denied' ? 'Bloqueadas no navegador. Libere nas permissões do site.' : perm === 'unsupported' ? 'Este navegador não oferece notificações.' : 'Receba avisos com o painel em segundo plano.'}</p></div>
          ${perm === 'default' ? '<button type="button" class="btn btn-cobalt btn-sm" data-set="notif">Ativar</button>' : ''}</div>
        <div class="set-row"><div><h3>Manter a tela ligada</h3><p>${'wakeLock' in navigator ? 'Ideal para o tablet fixo no balcão.' : 'Este navegador não permite manter a tela ligada.'}</p></div>
          <label class="switch"><input type="checkbox" data-set="tela" ${S.telaLigada ? 'checked' : ''} ${'wakeLock' in navigator ? '' : 'disabled'} aria-label="Manter a tela ligada"><span></span></label></div>
        <div class="set-row wrap"><div><h3>Tema</h3><p>Escuro ajuda em salões com pouca luz.</p></div>
          <div class="seg" role="radiogroup" aria-label="Tema">
            <button type="button" role="radio" aria-checked="${tema === 'light'}" data-tema="light">Claro</button>
            <button type="button" role="radio" aria-checked="${tema === 'dark'}" data-tema="dark">Escuro</button>
            <button type="button" role="radio" aria-checked="${tema === 'auto'}" data-tema="auto">Automático</button></div></div>
        <div class="set-row"><div><h3>Conexão</h3><p>${isDemo
          ? 'Modo demonstração: tudo fica salvo só neste navegador. Para os celulares dos clientes chamarem a equipe, o site precisa estar ligado ao servidor.'
          : 'Conectado ao servidor em tempo real.'}</p></div></div>
        ${isDemo ? `<div class="set-row"><div><h3>Dados de demonstração</h3><p>Apaga os chamados e comentários deste navegador. Os dados do restaurante continuam.</p></div>
          <button type="button" class="btn btn-danger btn-sm" data-set="reset">${icon('trash')} Apagar</button></div>` : ''}
        <div class="set-row"><div><h3>${esc(S.user.nome)}</h3><p>Conectado neste aparelho.</p></div>
          <button type="button" class="btn btn-line btn-sm" data-tool="sair">${icon('logout')} Sair</button></div>
      </div>`;
  }

  /* Widgets */
  function ajWidgets() {
    return `<div class="panel stack" id="widgetsCfg">
        <p class="muted" style="font-size:13px">Desligue o que o restaurante não usa e use as setas para mudar a ordem. Os dados de Wi-Fi, Google e cardápio ficam nas abas Restaurante e Cardápio.</p>
        <ul class="wlist">${S.settings.widgets.map((w, i) => widgetRow(w, i, S.settings.widgets.length)).join('')}</ul>
        ${widgetForm()}
      </div>`;
  }

  /* Eventos dos ajustes */
  document.addEventListener('click', async (e) => {
    const t = e.target;
    const tab = t.closest('[data-aj]');
    if (tab) {
      S.ajTab = tab.dataset.aj;
      S.widgetEdit = null;
      return renderView();
    }
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

    if (el.matches('[data-pin]')) {
      const v = el.value.trim();
      if (!/^\d{4,8}$/.test(v)) {
        el.value = (S.settings.equipe && S.settings.equipe.pin) || cfg.equipe.pin;
        return toast('O PIN precisa ter de 4 a 8 números.', { tone: 'error' });
      }
      return saveSettings({ equipe: { ...S.settings.equipe, pin: v } });
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
    };
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
    const q = t.closest('[data-qr]');
    if (q) return openQr(+q.dataset.qr);
    const c = t.closest('[data-copy]');
    if (c) {
      const ok = await copyText(tableUrl(+c.dataset.copy));
      return toast(ok ? `Link da mesa ${c.dataset.copy} copiado.` : 'Não foi possível copiar o link.', { tone: ok ? 'ok' : 'error' });
    }
    const p = t.closest('[data-print]');
    if (p) return printQrs([+p.dataset.print]);
    if (t.closest('#printAll')) return printQrs(Array.from({ length: S.settings.mesas.total }, (_, i) => i + 1));
    const n = t.closest('[data-nfc]');
    if (n) return gravarNfc(+n.dataset.nfc, n);
    const aBtn = t.closest('[data-area]');
    if (aBtn) {
      const areas = S.settings.mesas.areas.slice();
      if (aBtn.dataset.area === 'add') {
        const lastAte = areas.length ? areas[areas.length - 1].ate : 0;
        areas.push({ nome: 'Nova área', de: Math.min(lastAte + 1, S.settings.mesas.total), ate: S.settings.mesas.total });
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
    if (e.target.id === 'baseUrl') {
      const v = e.target.value.trim();
      try {
        new URL(v);
        set('nfc-base-url', v === defaultBase() ? null : v);
        renderView();
        toast('Link base atualizado.');
      } catch {
        toast('Digite um endereço completo, começando com https://', { tone: 'error' });
      }
    }
    if (e.target.id === 'totalMesas') {
      const n = Math.min(300, Math.max(1, parseInt(e.target.value, 10) || S.settings.mesas.total));
      saveMesas({ total: n }).then(renderView);
      return;
    }
    const af = e.target.closest('[data-afield]');
    if (af) {
      const row = af.closest('[data-area-idx]');
      const areas = S.settings.mesas.areas.slice();
      const i = +row.dataset.areaIdx;
      const field = af.dataset.afield;
      areas[i] = { ...areas[i], [field]: field === 'nome' ? af.value.trim() || 'Área' : Math.max(1, parseInt(af.value, 10) || 1) };
      saveMesas({ areas });
      return;
    }
    const wt = e.target.closest('input[data-w="toggle"]');
    if (wt) {
      const row = wt.closest('[data-widx]');
      const list = S.settings.widgets.slice();
      const i = +row.dataset.widx;
      list[i] = { ...list[i], ativo: wt.checked };
      saveWidgets(list);
    }
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
    route();
    window.addEventListener('hashchange', route);
    store.subscribe(queueRefresh);
    refresh();
    setInterval(tick, 1000);
    // Rede de segurança caso o tempo real caia.
    setInterval(refresh, isDemo ? 30e3 : 20e3);
    applyWakeLock();
  }

  store
    .init({ realtimeAll: true })
    .then(async () => {
      try { S.settings = await store.getSettings(); } catch (e) { console.error(e); }
      if (isDemo) {
        let sess = null;
        try { sess = JSON.parse(get('nfc-equipe')); } catch {}
        if (sess && sess.exp > Date.now()) {
          S.user = { nome: sess.nome };
          return startApp();
        }
      } else if (await store.auth.session()) {
        S.user = { nome: get('nfc-equipe-nome') || 'Equipe' };
        return startApp();
      }
      showLogin();
    })
    .catch((e) => {
      console.error(e);
      showLogin('Não foi possível conectar ao servidor. Verifique a internet e recarregue.');
    });
})();
