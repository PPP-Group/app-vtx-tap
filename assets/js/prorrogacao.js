/*
 * Prorrogação (adicional): o relógio do happy hour que ganha minutos a cada chopp.
 * Funções comuns ao painel, ao telão e à página da mesa.
 *
 *   Prorrogacao.acompanhar(store, fn, ms) → chama fn(status) agora e a cada ms; devolve parar()
 *   Prorrogacao.restante(status)         → milissegundos que faltam (com o relógio do servidor)
 *   Prorrogacao.relogio(ms)              → "1:02:03" ou "12:34"
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
  function acompanhar(store, fn, ms = 5000) {
    let vivo = true;
    let t;
    const rodar = async () => {
      try {
        fn(sincronizar(await store.hhStatus()));
      } catch (e) {
        console.error(e);
      }
      if (vivo) t = setTimeout(rodar, document.hidden ? ms * 3 : ms);
    };
    rodar();
    return () => { vivo = false; clearTimeout(t); };
  }

  window.Prorrogacao = { acompanhar, sincronizar, restante, relogio, duracao, minutosTxt, agora };
})();
