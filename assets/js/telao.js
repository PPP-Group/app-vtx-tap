/*
 * Telão da Prorrogação (/telao/): o relógio do happy hour em tela cheia na TV do bar.
 * Busca a situação a cada 3 s e conta os segundos sozinho. Cada chopp lido enche o copo e mostra "+1 min".
 * Aberto pelo painel em "Abrir na TV", vai direto para a segunda tela (quando o navegador deixa).
 */
(function () {
  const { $, esc, aplicarCor } = UI;
  const PR = window.Prorrogacao;
  const store = Store.create();
  let st = null;
  let relogio = null;

  const hora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const quando = (iso) => {
    const d = new Date(iso);
    const hoje = new Date();
    const amanha = new Date(); amanha.setDate(hoje.getDate() + 1);
    const dia = d.toDateString() === hoje.toDateString() ? 'hoje' : d.toDateString() === amanha.toDateString() ? 'amanhã'
      : d.toLocaleDateString('pt-BR', { weekday: 'long' });
    return `${dia} às ${hora(iso)}`;
  };
  const plural = (n, s) => `${n} ${s}${n === 1 ? '' : 's'}`;

  function render() {
    const tl = $('#tl');
    if (!st || !st.disponivel) {
      tl.dataset.estado = 'off';
      $('#tlNome').textContent = 'Happy hour';
      $('#tlFrase').textContent = '';
      $('#tlSub').textContent = 'O relógio do happy hour não está ligado.';
      $('#tlStats').textContent = '';
      $('#tlDestaques').textContent = '';
      $('#tlRecorde').textContent = '';
      relogio.atualizar(null);
      return;
    }
    document.title = st.nome;
    $('#tlNome').textContent = st.nome;
    $('#tlFrase').textContent = st.frase || '';
    const produto = st.produto || 'chopp';
    const s = st.sessao;
    if (st.rodando && s) {
      tl.dataset.estado = 'rodando';
      $('#tlSub').innerHTML = `Acaba às <b>${hora(s.fim)}</b>${s.limite_em ? ` · no máximo até ${hora(s.limite_em)}` : ''}`;
      $('#tlStats').innerHTML = `<span><b>${s.leituras}</b> ${esc(produto)}${s.leituras === 1 ? '' : 's'}</span><span><b>+${PR.duracao(s.minutos_ganhos)}</b> de happy hour ganhos</span>`;
      const d = (s.destaques || []).filter((x) => x.qtd > 0);
      $('#tlDestaques').innerHTML = d.length ? `Quem mais prorrogou: ${d.map((x, i) => `<span class="tl-dest"><i>${i + 1}º</i> ${esc(PR.quemTxt(x))} <b>${x.qtd}</b></span>`).join('')}` : '';
    } else {
      tl.dataset.estado = 'parado';
      const u = st.ultima_sessao;
      const recente = u && Date.now() - new Date(u.fim).getTime() < 3 * 3600e3;
      $('#tlSub').innerHTML = st.proxima ? `Próximo happy hour: <b>${quando(st.proxima)}</b>` : recente ? 'Acabou. Valeu, galera.' : 'Fique de olho: o próximo happy hour vem aí.';
      $('#tlStats').innerHTML = recente ? `<span>Último: <b>${plural(u.leituras, esc(produto))}</b></span><span><b>+${PR.duracao(u.minutos_ganhos)}</b> de prorrogação</span>` : '';
      $('#tlDestaques').textContent = '';
    }
    $('#tlRecorde').innerHTML = st.recorde && st.recorde.minutos ? `Recorde da casa: <b>${PR.duracao(st.recorde.minutos)}</b> de happy hour` : '';
    relogio.atualizar(st);
  }

  // Tela cheia e tela sempre ligada (TV do bar).
  let lock = null;
  async function manterLigada() {
    try {
      if ('wakeLock' in navigator && !lock) {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => (lock = null));
      }
    } catch {}
  }
  // Tela cheia na tela onde a janela está (aberta pelo painel já na TV).
  $('#tlCheia').addEventListener('click', () => {
    const el = document.documentElement;
    (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
    manterLigada();
  });
  document.addEventListener('fullscreenchange', () => ($('#tlCheia').hidden = !!document.fullscreenElement));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && manterLigada());
  if (new URLSearchParams(location.search).has('tv')) {
    $('#tlCheia').classList.add('is-chamando');
    $('#tlCheia').textContent = 'Toque para pôr em tela cheia';
  }

  relogio = PR.copo($('#tlCopo'), { tamanho: 'tv' });
  store
    .init()
    .catch((err) => {
      if (err.code === 'SEM_RESTAURANTE') { UI.semRestaurante(); return new Promise(() => {}); }
    })
    .then(() => store.getSettings())
    .then((s) => {
      const R = s.restaurante || {};
      if (R.cor) aplicarCor(R.cor);
      $('#tlRest').textContent = R.nome || '';
      if (R.logo) $('#tlLogo').innerHTML = `<img src="${esc(R.logo)}" alt="">`;
      else $('#tlLogo').hidden = true;
      PR.acompanhar(store, (x) => { st = x; render(); }, 2500);
      manterLigada();
    })
    .catch((e) => {
      console.error(e);
      $('#tlSub').textContent = 'Sem conexão. Tentando de novo…';
      setTimeout(() => location.reload(), 15000);
    });
})();
