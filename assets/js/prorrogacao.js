/*
 * Prorrogação (adicional): o relógio do happy hour que ganha minutos a cada chopp.
 * Funções comuns ao painel, ao telão e à página da mesa.
 *
 *   Prorrogacao.acompanhar(store, fn, ms) → chama fn(status) agora e a cada ms (número ou função do status); devolve parar()
 *   Prorrogacao.restante(status)         → milissegundos que faltam (com o relógio do servidor)
 *   Prorrogacao.relogio(ms)              → "1:02:03" ou "12:34"
 *   Prorrogacao.copo(el, { tamanho })    → o relógio animado (copo de chopp que esvazia com o tempo e enche a cada chopp):
 *                                          { atualizar(status), tick() }. tamanho: 'tv' | 'cel' | 'painel'. CSS em prorrogacao.css.
 */
(function () {
  // Diferença entre o relógio do servidor e o do aparelho (o celular pode estar adiantado).
  let desvio = 0;
  const agora = () => Date.now() + desvio;
  function sincronizar(st) {
    if (st && st.agora) desvio = new Date(st.agora).getTime() - Date.now();
    return st;
  }
  const restante = (st) => (st && st.rodando && st.sessao ? Math.max(0, new Date(st.sessao.fim).getTime() - agora()) : 0);
  const dois = (n) => String(n).padStart(2, '0');
  function relogio(ms) {
    const t = Math.ceil(Math.max(0, ms) / 1000);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    return h ? `${h}:${dois(m)}:${dois(t % 60)}` : `${dois(m)}:${dois(t % 60)}`;
  }
  // "1h12" / "45 min"
  function duracao(min) {
    min = Math.round(+min || 0);
    return min >= 60 ? `${Math.floor(min / 60)}h${min % 60 ? dois(min % 60) : ''}` : `${min} min`;
  }
  const minutosTxt = (m) => {
    m = Math.round((+m || 0) * 100) / 100;
    return `${String(m).replace('.', ',')} ${m === 1 ? 'minuto' : 'minutos'}`;
  };
  // ms pode ser um número ou uma função do status (ex.: mais devagar com o relógio parado).
  function acompanhar(store, fn, ms = 5000) {
    let vivo = true;
    let t;
    let ultimo = null;
    const rodar = async () => {
      try {
        ultimo = sincronizar(await store.hhStatus());
        fn(ultimo);
      } catch (e) {
        console.error(e);
      }
      const espera = typeof ms === 'function' ? ms(ultimo) : ms;
      if (vivo) t = setTimeout(rodar, document.hidden ? espera * 3 : espera);
    };
    rodar();
    const parar = () => { vivo = false; clearTimeout(t); };
    // Busca agora (depois de um chopp lido neste aparelho).
    parar.ja = () => { clearTimeout(t); rodar(); };
    return parar;
  }

  /* ---------- O copo: relógio animado ---------- */
  const reduzido = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const quemTxt = (l) => (l && l.comanda ? `Comanda ${l.comanda}` : l && l.mesa ? `Mesa ${l.mesa}` : '');
  function copo(el, { tamanho = 'cel' } = {}) {
    el.classList.add('pr-copo', `pr--${tamanho}`);
    el.innerHTML = `<div class="pr-liquido" aria-hidden="true"><div class="pr-onda"></div>${'<i class="pr-bolha"></i>'.repeat(14)}</div>
      <div class="pr-brilho" aria-hidden="true"></div>
      <div class="pr-digitos" role="timer" aria-live="off"></div>
      <div class="pr-pops" aria-hidden="true"></div>`;
    const dig = el.querySelector('.pr-digitos');
    const pops = el.querySelector('.pr-pops');
    let formato = '';
    let st = null;
    let sessao = null;
    let fimAntes = 0;
    let pico = 1;
    let ultimoSeg = -1;

    // Cada dígito é uma fita de 0 a 9 que rola (para baixo quando o tempo passa, para cima quando ganha minutos).
    function montar(txt) {
      formato = txt.replace(/\d/g, '0');
      dig.innerHTML = [...txt].map((ch) => (ch === ':' ? '<span class="pr-sep" aria-hidden="true">:</span>'
        : `<span class="pr-col" aria-hidden="true"><span class="pr-fita">${[...'0123456789'].map((n) => `<span>${n}</span>`).join('')}</span></span>`)).join('');
    }
    function escrever(txt) {
      if (txt.replace(/\d/g, '0') !== formato) montar(txt);
      const cols = dig.querySelectorAll('.pr-fita');
      let i = 0;
      [...txt].forEach((ch) => {
        if (ch === ':') return;
        cols[i++].style.transform = `translateY(${-+ch}em)`;
      });
      dig.setAttribute('aria-label', txt);
    }
    function nivel(r) {
      pico = Math.max(pico, r);
      // No último minuto o copo enche de vermelho e esvazia até zerar.
      const n = r < 60e3 ? r / 60e3 : r / pico;
      el.style.setProperty('--nivel', st && st.rodando ? Math.max(0.03, Math.min(1, n)).toFixed(4) : 0);
    }
    // Chopp! espuma espirrando, "+1 min" subindo e o copo enchendo.
    function celebrar(min, quem) {
      el.classList.remove('is-chopp');
      void el.offsetWidth;
      el.classList.add('is-chopp');
      const pop = document.createElement('div');
      pop.className = 'pr-pop';
      pop.innerHTML = `<b>+${String(Math.round(min * 100) / 100).replace('.', ',')} min</b>${quem ? `<small>${quem}</small>` : ''}`;
      pops.appendChild(pop);
      if (!reduzido()) {
        for (let k = 0; k < 22; k++) {
          const g = document.createElement('i');
          const ang = (Math.PI * (0.1 + 0.8 * Math.random())) + Math.PI;
          const dist = 60 + Math.random() * 120;
          g.className = 'pr-gota';
          g.style.setProperty('--dx', `${Math.cos(ang) * dist}%`);
          g.style.setProperty('--dy', `${Math.sin(ang) * dist}%`);
          g.style.setProperty('--t', `${0.6 + Math.random() * 0.6}s`);
          g.style.left = `${35 + Math.random() * 30}%`;
          pops.appendChild(g);
          setTimeout(() => g.remove(), 1300);
        }
      }
      setTimeout(() => pop.remove(), 2400);
      if (navigator.vibrate && tamanho === 'cel') navigator.vibrate([30, 40, 30]);
    }
    function tick() {
      const r = restante(st);
      escrever(relogio(r));
      nivel(r);
      const seg = Math.ceil(r / 1000);
      el.classList.toggle('is-final', !!(st && st.rodando) && r < 60e3);
      if (st && st.rodando && seg <= 10 && seg !== ultimoSeg && seg > 0) {
        el.classList.remove('is-tremor');
        void el.offsetWidth;
        el.classList.add('is-tremor');
      }
      ultimoSeg = seg;
    }
    function atualizar(novo) {
      st = novo;
      const s = st && st.rodando ? st.sessao : null;
      el.classList.toggle('is-parado', !s);
      if (s) {
        const fim = new Date(s.fim).getTime();
        if (sessao !== s.id) { pico = 1; sessao = s.id; fimAntes = fim; }
        else if (fim > fimAntes + 1000) celebrar((fim - fimAntes) / 60e3, quemTxt(s.ultima_leitura));
        fimAntes = fim;
      } else {
        sessao = null;
      }
      tick();
    }
    const t = setInterval(tick, 250);
    return { atualizar, tick, celebrar, parar: () => clearInterval(t) };
  }

  window.Prorrogacao = { acompanhar, sincronizar, restante, relogio, duracao, minutosTxt, agora, copo, quemTxt };
})();
