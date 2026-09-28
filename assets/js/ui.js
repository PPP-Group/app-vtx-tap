/* Utilitários compartilhados entre a página da mesa e o painel da equipe. */
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const brlFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const brl = (n) => brlFmt.format(Number(n) || 0);
  const pad = (n) => String(n).padStart(2, '0');
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  /* Ícones no estilo Lucide (ISC). */
  const ICONS = {
    bell: '<path d="M3 20a1 1 0 0 1-1-1v-1a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1Z"/><path d="M20 16a8 8 0 1 0-16 0"/><path d="M12 4v4"/><path d="M10 4h4"/>',
    book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
    wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><path d="M12 20h.01"/>',
    star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
    msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    instagram: '<rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><path d="M17.5 6.5h.01"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>',
    nfc: '<rect width="7" height="12" x="2" y="6" rx="1"/><path d="M13 8.32a7.43 7.43 0 0 1 0 7.36"/><path d="M16.46 6.21a11.76 11.76 0 0 1 0 11.58"/><path d="M19.91 4.1a15.91 15.91 0 0 1 .01 15.8"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    volume: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    mute: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m23 9-6 6M17 9l6 6"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    qr: '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3M21 21v.01M12 7v3a2 2 0 0 1-2 2H7M3 12h.01M12 3h.01M12 16v.01M16 12h1M21 12v.01M12 21v-1"/>',
    external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    arrow: '<path d="M5 12h14M12 5l7 7-7 7"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    sliders: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
    trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    sparkle: '<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/>',
    chevronUp: '<path d="m6 15 6-6 6 6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    edit: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  };
  const icon = (name, cls = '') =>
    `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;

  /* Tempo */
  const secondsSince = (iso) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  const clock = (iso) => {
    const s = secondsSince(iso);
    const m = Math.floor(s / 60);
    if (m >= 60) return `${Math.floor(m / 60)}h${pad(m % 60)}`;
    return `${pad(m)}:${pad(s % 60)}`;
  };
  const ago = (iso) => {
    const s = secondsSince(iso);
    if (s < 45) return 'agora';
    const m = Math.round(s / 60);
    if (m < 60) return `há ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `há ${h} h`;
    return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
  };
  const hhmm = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  /* Toast */
  function toast(msg, { tone = 'ink', ms = 2800, action } = {}) {
    let region = $('.toasts');
    if (!region) {
      region = document.createElement('div');
      region.className = 'toasts';
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
      document.body.appendChild(region);
    }
    const t = document.createElement('div');
    t.className = `toast toast--${tone}`;
    t.innerHTML = `<span>${esc(msg)}</span>`;
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = action.label;
      b.onclick = () => {
        action.run();
        dismiss();
      };
      t.appendChild(b);
    }
    region.appendChild(t);
    requestAnimationFrame(() => t.classList.add('in'));
    const dismiss = () => {
      t.classList.remove('in');
      setTimeout(() => t.remove(), 300);
    };
    setTimeout(dismiss, ms);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  function qrSvg(text, { cell = 5, margin = 2 } = {}) {
    if (typeof window.qrcode !== 'function') return '<p class="muted">QR indisponível sem internet.</p>';
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: cell, margin, scalable: true });
  }

  /*
   * Folhas (bottom sheets) com histórico: o botão "voltar" do Android fecha a folha
   * em vez de sair da página. Arrastar a alça para baixo também fecha.
   */
  const stack = [];
  const SID = Math.random().toString(36).slice(2);
  if (history.state && history.state.sheet) history.replaceState(null, '');
  const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])';

  function openSheet(el) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (!el || stack.includes(el)) return;
    el._returnFocus = document.activeElement;
    stack.push(el);
    el.hidden = false;
    document.documentElement.classList.add('is-locked');
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-open')));
    history.pushState({ sheet: el.id, sid: SID, depth: stack.length }, '');
    const target = el.querySelector('[autofocus]') || el.querySelector('.sheet-panel');
    setTimeout(() => target && target.focus({ preventScroll: true }), 60);
    el.dispatchEvent(new CustomEvent('sheet:open'));
  }

  function reallyClose() {
    const el = stack.pop();
    if (!el) return;
    el.classList.remove('is-open');
    const panel = el.querySelector('.sheet-panel');
    if (panel) panel.style.transform = '';
    setTimeout(() => {
      if (!el.classList.contains('is-open')) el.hidden = true;
    }, 320);
    if (!stack.length) document.documentElement.classList.remove('is-locked');
    el._returnFocus && el._returnFocus.focus && el._returnFocus.focus({ preventScroll: true });
    el.dispatchEvent(new CustomEvent('sheet:close'));
  }

  const closeSheet = () => stack.length && history.back();
  const closeAllSheets = () => stack.length && history.go(-stack.length);

  window.addEventListener('popstate', () => {
    // Fecha quantas folhas forem necessárias para sincronizar com o histórico.
    // Entradas de outro carregamento da página não contam: fecha tudo.
    const st = history.state;
    const depth = st && st.sid === SID ? st.depth : 0;
    while (stack.length > depth) reallyClose();
  });

  document.addEventListener('keydown', (e) => {
    if (!stack.length) return;
    const top = stack[stack.length - 1];
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSheet();
    }
    if (e.key === 'Tab') {
      const f = $$(FOCUSABLE, top).filter((n) => n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  document.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close]');
    if (closer && closer.closest('.sheet')) closeSheet();
  });

  // Arrastar para fechar
  document.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.sheet-grip, .sheet-head');
    if (!grip || e.target.closest('button, input, a')) return;
    const panel = grip.closest('.sheet-panel');
    if (!panel || panel.closest('.sheet--full')) return;
    const y0 = e.clientY;
    const t0 = performance.now();
    let dy = 0;
    panel.style.transition = 'none';
    const move = (ev) => {
      dy = Math.max(0, ev.clientY - y0);
      panel.style.transform = `translateY(${dy}px)`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      panel.style.transition = '';
      const v = dy / Math.max(1, performance.now() - t0);
      if (dy > 110 || v > 0.6) closeSheet();
      else panel.style.transform = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });

  window.UI = {
    $, $$, esc, brl, pad, norm, icon, toast, copyText, qrSvg,
    clock, ago, hhmm, secondsSince,
    openSheet, closeSheet, closeAllSheets,
    get sheetDepth() {
      return stack.length;
    },
  };
})();
