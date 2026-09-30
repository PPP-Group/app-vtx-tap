/*
 * Aba Fidelidade do painel da equipe.
 *   Hoje:     números, prêmios para entregar, notas para conferir, importar XML, lançar nota
 *   Clientes: busca, ficha (extrato, notas, prêmios), PIN, editar, excluir, exportar
 *   Prêmios:  catálogo com foto
 *   Regras:   pontos por real, dias em dobro, CNPJ, prazo, indicação, regulamento
 *
 *   FidPainel.iniciar(ctx)  ctx = { store, S, rerender(), chrome(), ding(), isDemo, prepararImagem(file, tipo) }
 *   FidPainel.atualizar() / FidPainel.html() / FidPainel.badge()
 */
(function () {
  const { $, esc, brl, icon, toast, copyText, openSheet, closeSheet, qrSvg } = UI;
  const F = Store.fid;
  const DIAS = [[1, 'Seg'], [2, 'Ter'], [3, 'Qua'], [4, 'Qui'], [5, 'Sex'], [6, 'Sáb'], [0, 'Dom']];
  const TABS = [
    { id: 'hoje', label: 'Hoje' },
    { id: 'clientes', label: 'Clientes' },
    { id: 'premios', label: 'Prêmios' },
    { id: 'ranking', label: 'Ranking' },
    { id: 'regras', label: 'Regras' },
  ];
  const TIPO = { nivel: 'Bônus de nível', compra: 'Compra', indicacao: 'Indicação', boas_vindas: 'Boas-vindas', manual: 'Lançamento', resgate: 'Troca', estorno: 'Estorno', ajuste: 'Ajuste' };
  const STATUS = { pendente: 'Conferir', creditada: 'Creditada', recusada: 'Recusada', estornada: 'Estornada', entregue: 'Entregue', cancelado: 'Cancelado' };

  let ctx = null;
  const P = {
    tab: 'hoje', resumo: null, pend: { notas: [], resgates: [] }, recentes: null, clientes: null, busca: '',
    premios: null, premioEdit: null, regras: null, vistos: new Set(), pronto: false, ficha: null, importando: false,
    ranking: null, dias: 90,
  };

  const num = (n) => Number(n || 0).toLocaleString('pt-BR');
  const pts = (n) => `${num(n)} ${Math.abs(n) === 1 ? 'ponto' : 'pontos'}`;
  const dataHora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
  const data = (iso) => (iso ? new Date(iso).toLocaleDateString('pt-BR') : '');
  const fmtCpf = (c) => String(c || '').replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  const cpfOculto = (c) => String(c || '').replace(/^(\d{3})\d{6}(\d{2})$/, '$1.•••.•••-$2');
  const fmtCnpj = (c) => String(c || '').replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  const tel = (t) => {
    const d = F.soDigitos(t);
    return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : t || '';
  };
  const nomeDe = (x) => (x.fid_clientes && x.fid_clientes.nome) || x.nome || cpfOculto(x.cpf);
  const erroMsg = (e) => (e && e.message && !/fetch|network/i.test(e.message) ? e.message : 'Sem conexão. Confira a internet e tente de novo.');
  const regras = () => F.PADRAO && { ...F.PADRAO, ...(ctx.S.settings.fidelidade || {}) };
  // Datas e horas sempre no formato brasileiro (o campo nativo segue o idioma do navegador).
  const dataBr = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso.split('-').reverse().join('/') : '');
  // '' → null; inválida → undefined; válida → 'AAAA-MM-DD'.
  const dataIso = (br) => {
    const t = String(br || '').trim();
    if (!t) return null;
    const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return undefined;
    const d = new Date(+m[3], +m[2] - 1, +m[1]);
    return d.getDate() === +m[1] && d.getMonth() === +m[2] - 1 && +m[3] >= 2000 ? `${m[3]}-${m[2]}-${m[1]}` : undefined;
  };
  const horaOk = (h) => !h || /^([01]\d|2[0-3]):[0-5]\d$/.test(h);
  const campoData = (name, iso, rotulo) => `<label class="field"><span>${rotulo}</span><input class="input mono" name="${name}" inputmode="numeric" maxlength="10" placeholder="dd/mm/aaaa" autocomplete="off" data-fp-mask="data" value="${esc(dataBr(iso))}"></label>`;
  const campoHora = (name, h, rotulo) => `<label class="field"><span>${rotulo}</span><input class="input mono" name="${name}" inputmode="numeric" maxlength="5" placeholder="hh:mm" autocomplete="off" data-fp-mask="hora" value="${esc(h || '')}"></label>`;
  const niveisCfg = () => F.niveis(regras());
  const seloNivel = (id, extra = '') => {
    const l = niveisCfg().find((x) => x.id === id);
    return l ? `<span class="fp-selo ${extra}" style="--nv:${esc(l.cor)}">${esc(l.nome)}</span>` : '';
  };
  const CORES_NIVEL = ['#b45309', '#64748b', '#ca8a04', '#0f766e', '#1d4ed8', '#7e22ce', '#be185d', '#111827'];
  const MULTS = [[1, 'Sem bônus'], [1.05, '+5%'], [1.1, '+10%'], [1.15, '+15%'], [1.2, '+20%'], [1.25, '+25%'], [1.5, '+50%'], [2, 'Dobro']];
  const MODELO_NIVEIS = [
    { nome: 'Bronze', descricao: 'Todo mundo começa aqui', cor: '#b45309', minimo: 0, mult: 1, bonus: 0, beneficios: ['Pontos em todas as compras'] },
    { nome: 'Prata', descricao: 'Cliente da casa', cor: '#64748b', minimo: 500, mult: 1.1, bonus: 50, beneficios: ['Sobremesa no aniversário'] },
    { nome: 'Ouro', descricao: 'Os mais fiéis', cor: '#ca8a04', minimo: 1500, mult: 1.25, bonus: 150, beneficios: ['Prêmios exclusivos', 'Prioridade na reserva'] },
  ];
  const novoId = (nome) => `${String(nome || 'nivel').normalize('NFD').replace(/[^A-Za-z0-9]/g, '').toLowerCase().slice(0, 12) || 'nivel'}-${Math.random().toString(36).slice(2, 6)}`;
  const linkPrograma = () => new URL('/?fidelidade', location.origin).href;
  const sefazDe = (n) => n.url || null;

  /* ============================== Dados ============================== */
  async function atualizar() {
    const { store } = ctx;
    try {
      const [resumo, pend] = await Promise.all([store.fidResumo(), store.fidPendencias()]);
      P.resumo = resumo;
      P.pend = pend;
    } catch (e) {
      console.error(e);
      return;
    }
    // Troca de prêmio nova: toca o sino e avisa, em qualquer aba.
    const novos = P.pend.resgates.filter((x) => !P.vistos.has(x.id));
    novos.forEach((x) => P.vistos.add(x.id));
    if (P.pronto && novos.length) {
      ctx.ding(2);
      const x = novos[0];
      toast(`${nomeDe(x).split(' ')[0]} trocou pontos por ${x.premio_nome}. Código ${x.codigo}.`, {
        tone: 'ok', ms: 9000, action: { label: 'Ver', run: () => { P.tab = 'hoje'; location.hash = 'fidelidade'; ctx.rerender(); } },
      });
    }
    P.pronto = true;
    if (ctx.S.view === 'fidelidade' && P.tab === 'hoje') {
      P.recentes = await store.fidRecentes().catch(() => P.recentes || []);
    }
  }
  const badge = () => (P.pend.resgates.length || 0) + (P.pend.notas.length || 0);

  async function carregarAba() {
    const { store } = ctx;
    try {
      if (P.tab === 'hoje' && !P.recentes) P.recentes = await store.fidRecentes();
      else if (P.tab === 'clientes' && !P.clientes) P.clientes = await store.fidClientes(P.busca);
      else if (P.tab === 'premios' && !P.premios) P.premios = await store.fidPremios();
      else if (P.tab === 'ranking' && !P.ranking) {
        const [rk, top] = await Promise.all([store.fidRanking ? store.fidRanking(null) : null, store.fidTopProdutos(null, P.dias)]);
        P.ranking = { rk, top };
      } else return;
    } catch (e) {
      console.error(e);
      return toast(erroMsg(e), { tone: 'error' });
    }
    if (ctx.S.view === 'fidelidade') ctx.rerender();
  }

  /* ============================== Tela ============================== */
  function html() {
    const tab = P.tab;
    // Redesenho (ex.: atualização automática) no meio da edição: guarda o que já foi digitado.
    if (tab === 'regras' && $('#fpRegras') && !P.jaLido) lerRegras();
    P.jaLido = false;
    const r = regras();
    const intro = {
      hoje: 'Prêmios para entregar, notas para conferir e o arquivo de notas do caixa.',
      clientes: 'Quem participa do programa, com o saldo e o extrato de cada um.',
      premios: 'O que o cliente pode trocar pelos pontos. Aparece na página da mesa na hora.',
      ranking: 'Os 10 clientes que mais ganharam pontos e os produtos mais pedidos nas notas.',
      regras: 'Quanto vale cada real, dias com pontos em dobro e o regulamento.',
    }[tab];
    setTimeout(carregarAba, 0);
    return `<div class="vhead"><div><h1>${esc(r.nome || 'Fidelidade')}</h1><p>${intro}</p></div>
        <span class="fp-status ${r.ativo ? 'is-on' : ''}">${r.ativo ? 'No ar' : 'Pausado'}</span></div>
      <div class="aj-tabs" role="tablist" aria-label="Seções da fidelidade">
        ${TABS.map((t) => `<button type="button" role="tab" aria-selected="${t.id === tab}" data-fp-tab="${t.id}">${t.label}${t.id === 'hoje' && badge() ? ` <span class="badge">${badge()}</span>` : ''}</button>`).join('')}
      </div>
      ${{ hoje: tHoje, clientes: tClientes, premios: tPremios, ranking: tRanking, regras: tRegras }[tab]()}`;
  }

  /* ---------- Hoje ---------- */
  function tHoje() {
    const r = regras();
    const s = P.resumo || {};
    const aviso = !r.ativo
      ? `<p class="note">${icon('alert')}<span>O programa está pausado: os clientes não veem o atalho na página da mesa. Ligue em <button type="button" class="link" data-fp-tab="regras">Regras</button>.</span></p>` : '';
    return `${aviso}
      <div class="fp-kpis">
        <div class="fp-kpi"><small>Clientes</small><b>${num(s.clientes)}</b><span>${s.novos_30d ? `+${num(s.novos_30d)} em 30 dias` : 'no programa'}</span></div>
        <div class="fp-kpi"><small>Compras (30 dias)</small><b>${num(s.compras_30d)}</b><span>${brl(s.valor_30d || 0)}</span></div>
        <div class="fp-kpi"><small>Pontos em aberto</small><b>${num(s.pontos)}</b><span>nas contas</span></div>
        <div class="fp-kpi"><small>Prêmios entregues</small><b>${num(s.entregues_30d)}</b><span>em 30 dias</span></div>
      </div>
      <div class="fp-grid">
        <div class="aj-col">
          <section class="panel stack">
            <div class="fp-h"><h2>Prêmios para entregar</h2>${P.pend.resgates.length ? `<span class="badge">${P.pend.resgates.length}</span>` : ''}</div>
            ${P.pend.resgates.length ? `<ul class="fp-lista">${P.pend.resgates.map(resgateItem).join('')}</ul>`
              : '<p class="muted">Nenhuma troca esperando. Quando um cliente trocar pontos, o pedido aparece aqui com um código de 4 números.</p>'}
          </section>
          <section class="panel stack">
            <div class="fp-h"><h2>Notas para conferir</h2>${P.pend.notas.length ? `<span class="badge">${P.pend.notas.length}</span>` : ''}</div>
            ${P.pend.notas.length ? `<p class="help">Abra a nota na SEFAZ, confira o CPF e o valor, e aprove. Ou importe o XML do caixa: as notas são conferidas sozinhas.</p>
              <ul class="fp-lista">${P.pend.notas.map(notaItem).join('')}</ul>`
              : '<p class="muted">Tudo conferido.</p>'}
          </section>
        </div>
        <div class="aj-col">
          <section class="panel stack">
            <h2>Arquivo de notas do caixa</h2>
            <p class="muted">Envie os XML das NFC-e (ou o ZIP que o sistema do caixa exporta). Toda nota com CPF de cliente cadastrado ganha pontos, mesmo que o cliente não tenha lido o QR. Notas canceladas saem da conta.</p>
            <label class="btn btn-cobalt ${P.importando ? 'is-busy' : ''}">${icon('upload')} ${P.importando ? 'Importando…' : 'Enviar XML ou ZIP'}
              <input type="file" class="sr-only" accept=".xml,.zip,text/xml,application/xml,application/zip" multiple data-fp-xml ${P.importando ? 'disabled' : ''}></label>
            <small class="help">${s.ultimo_xml ? `Última importação: ${dataHora(s.ultimo_xml)}.` : 'Nenhuma importação ainda.'} Pode enviar o mesmo arquivo de novo: nada é contado duas vezes.</small>
            <div id="fpXmlRes"></div>
          </section>
          <section class="panel stack">
            <h2>Lançar nota no balcão</h2>
            <p class="muted">O cliente está sem celular? Leia o QR da nota dele aqui. Com o valor, os pontos entram na hora.</p>
            <button type="button" class="btn btn-line" data-fp-lancar>${icon('receipt')} Ler nota de um cliente</button>
          </section>
          <section class="panel stack">
            <h2>Últimos movimentos</h2>
            ${P.recentes && P.recentes.length ? `<ul class="fp-mov">${P.recentes.slice(0, 15).map((m) => `<li>
                <button type="button" class="link" data-fp-cliente="${esc(m.cpf)}">${esc(nomeDe(m))}</button>
                <span class="muted">${TIPO[m.tipo] || m.tipo}${m.valor ? ` · ${brl(m.valor)}` : ''}${m.mult > 1 ? ` · ${String(m.mult).replace('.', ',')}x` : ''} · ${dataHora(m.criado_em)}</span>
                <b class="${m.pontos < 0 ? 'fp-neg' : 'fp-pos'}">${m.pontos > 0 ? '+' : ''}${num(m.pontos)}</b></li>`).join('')}</ul>`
              : '<p class="muted">Nada ainda.</p>'}
          </section>
        </div>
      </div>`;
  }

  function resgateItem(x) {
    return `<li class="fp-item">
      <div class="fp-cod mono">${esc(x.codigo)}</div>
      <div class="fp-item-body"><b>${esc(x.premio_nome)}</b>
        <small><button type="button" class="link" data-fp-cliente="${esc(x.cpf)}">${esc(nomeDe(x))}</button> · ${pts(x.pontos)} · ${dataHora(x.criado_em)}</small></div>
      <div class="fp-item-acts">
        <button type="button" class="btn btn-cobalt btn-sm" data-fp-entregar="${esc(x.id)}">${icon('check')} Entregue</button>
        <button type="button" class="btn btn-quiet btn-sm" data-fp-cancelar="${esc(x.id)}">Cancelar</button>
      </div>
    </li>`;
  }

  function notaItem(n) {
    const url = sefazDe(n);
    return `<li class="fp-item fp-item--nota">
      <div class="fp-item-body"><b><button type="button" class="link" data-fp-cliente="${esc(n.cpf)}">${esc(nomeDe(n))}</button></b>
        <small>Lida ${dataHora(n.lida_em)}${n.lida_por && n.lida_por !== 'Cliente' ? ` por ${esc(n.lida_por)}` : ''} · nota nº ${num(+n.chave.slice(25, 34))}${n.valor_informado ? ` · cliente disse ${brl(n.valor_informado)}` : ''}</small>
        ${url ? `<a class="link fp-sefaz" href="${esc(url)}" target="_blank" rel="noopener">${icon('external')} Abrir na SEFAZ</a>` : '<small class="muted">Chave digitada: confira pela chave no portal da SEFAZ.</small>'}</div>
      <form class="fp-aprovar" data-fp-aprovar="${esc(n.chave)}" novalidate>
        <label class="field"><span>Valor total</span><input class="input mono" name="valor" inputmode="decimal" placeholder="0,00" value="${n.valor_informado ? Number(n.valor_informado).toFixed(2).replace('.', ',') : ''}" required></label>
        ${campoData('data', mesDaChave(n.chave), 'Data da compra')}
        <button type="submit" class="btn btn-cobalt btn-sm">${icon('check')} Aprovar</button>
        <button type="button" class="btn btn-quiet btn-sm" data-fp-recusar="${esc(n.chave)}">Recusar</button>
      </form>
    </li>`;
  }
  // A chave traz ano e mês da emissão; o dia fica para a equipe (vem hoje, se for deste mês).
  function mesDaChave(ch) {
    const ano = 2000 + +ch.slice(2, 4);
    const mes = +ch.slice(4, 6);
    const hoje = new Date();
    if (ano === hoje.getFullYear() && mes === hoje.getMonth() + 1) return hoje.toISOString().slice(0, 10);
    return '';
  }

  /* ---------- Clientes ---------- */
  function tClientes() {
    const lista = P.clientes;
    return `<div class="toolbar fp-busca">
        <label class="menu-search fp-search"><span class="sr-only">Buscar cliente</span>
          <input class="input" type="search" id="fpBusca" placeholder="Nome, CPF ou celular" value="${esc(P.busca)}" autocomplete="off" enterkeyhint="search"></label>
        <button type="button" class="btn btn-line btn-sm" data-fp-exportar>${icon('download')} Exportar planilha</button>
      </div>
      ${!lista ? '<p class="muted">Carregando…</p>' : !lista.length
        ? `<div class="empty"><span class="empty-ico">${icon('users')}</span><h2>${P.busca ? 'Ninguém encontrado' : 'Sem clientes ainda'}</h2>
            <p>${P.busca ? 'Confira o nome ou os números.' : 'Os clientes se cadastram pela página da mesa, no atalho do programa.'}</p></div>`
        : `<div class="fp-tabela" role="table">
            <div class="fp-linha fp-linha--h" role="row"><span>Nome</span><span>Celular</span><span>Desde</span><span>Pontos</span></div>
            ${lista.map((c) => `<button type="button" class="fp-linha" role="row" data-fp-cliente="${esc(c.cpf)}">
              <span><b>${esc(c.nome)} ${seloNivel(c.nivel, 'fp-selo--sm')}</b><small class="mono">${cpfOculto(c.cpf)}</small></span>
              <span>${esc(tel(c.telefone))}</span><span>${data(c.criado_em)}</span><b class="mono">${num(c.pontos)}</b></button>`).join('')}
          </div>${lista.length >= 300 ? '<p class="help">Mostrando os 300 mais recentes. Use a busca para achar os outros.</p>' : ''}`}`;
  }

  /* ---------- Ranking e produtos mais pedidos ---------- */
  const PERIODOS = [[30, '30 dias'], [90, '90 dias'], [365, '12 meses']];
  function tabelaProdutos(top, vazio) {
    if (!top || !top.length) return `<p class="muted">${vazio}</p>`;
    const max = Math.max(...top.map((x) => +x.quantidade || 0), 1);
    return `<ol class="fp-top">${top.map((x, i) => `<li>
        <span class="fp-top-pos">${i + 1}º</span>
        <span class="fp-top-nome"><b>${esc(x.descricao)}</b><span class="fp-top-barra"><i style="width:${Math.max(4, Math.round((+x.quantidade / max) * 100))}%"></i></span></span>
        <span class="fp-top-num"><b>${num(Math.round(+x.quantidade))}</b><small>${num(x.notas)} ${+x.notas === 1 ? 'nota' : 'notas'}${x.clientes != null ? ` · ${num(x.clientes)} ${+x.clientes === 1 ? 'cliente' : 'clientes'}` : ''}</small></span>
      </li>`).join('')}</ol>`;
  }
  function tRanking() {
    const d = P.ranking;
    if (!d) return '<p class="muted">Carregando…</p>';
    const rk = d.rk;
    const top = (rk && rk.top) || [];
    return `<div class="fp-grid">
      <section class="panel stack">
        <h2>Top 10 do clube</h2>
        ${rk && rk.ativo === false && regras().ativo ? `<p class="note">${icon('alert')}<span>O ranking está escondido dos clientes. Ligue em <button type="button" class="link" data-fp-tab="regras">Regras</button>.</span></p>` : ''}
        ${top.length ? `${podioHtml(top)}
          ${top.length > 3 ? `<ol class="rk-lista">${top.slice(3).map((x) => `<li><span class="rk-pos">${x.pos}º</span><span class="pd-av">${esc((x.nome || '?')[0])}</span><b>${esc(x.nome)}</b><span class="rk-pts">${num(x.pontos)} pts</span></li>`).join('')}</ol>` : ''}
          <small class="help">É assim que o cliente vê: primeiro nome e a inicial do sobrenome. Trocas não tiram pontos do ranking.</small>`
        : '<p class="muted">O ranking aparece quando os clientes começarem a ganhar pontos.</p>'}
      </section>
      <section class="panel stack">
        <div class="fp-top-head"><h2>Produtos mais pedidos</h2>
          <div class="seg" role="radiogroup" aria-label="Período">${PERIODOS.map(([v, l]) => `<button type="button" role="radio" aria-checked="${P.dias === v}" data-fp-dias="${v}">${l}</button>`).join('')}</div></div>
        ${tabelaProdutos(d.top, 'Os produtos vêm das notas conferidas na SEFAZ ou do XML importado em Hoje. Assim que as primeiras chegarem, eles aparecem aqui.')}
      </section>
    </div>`;
  }
  function podioHtml(top) {
    return `<ol class="podio podio--grande">${[1, 0, 2].map((i) => {
      const x = top[i];
      if (!x) return `<li class="pd pd--${i + 1} is-vazio"><span class="pd-av">?</span><b>—</b><span class="pd-degrau">${i + 1}º</span></li>`;
      return `<li class="pd pd--${i + 1}">${i === 0 ? `<span class="pd-coroa">${icon('trophy')}</span>` : ''}<span class="pd-av">${esc((x.nome || '?')[0])}</span><b>${esc(x.nome)}</b><small>${num(x.pontos)} pts</small><span class="pd-degrau">${x.pos}º</span></li>`;
    }).join('')}</ol>`;
  }

  async function abrirCliente(cpf) {
    $('#fpTitle').textContent = 'Cliente';
    $('#fpBody').innerHTML = '<p class="muted">Carregando…</p>';
    openSheet('sh-fp');
    try {
      P.ficha = await ctx.store.fidCliente(cpf);
      if (P.ficha) P.ficha.top = await ctx.store.fidTopProdutos(cpf, 3650).catch(() => []);
    } catch (e) {
      $('#fpBody').innerHTML = `<p class="form-error">${esc(erroMsg(e))}</p>`;
      return;
    }
    renderFicha();
  }
  function renderFicha(editando = false) {
    const f = P.ficha;
    if (!f) {
      $('#fpBody').innerHTML = '<p class="muted">Este cliente não existe mais.</p>';
      return;
    }
    const c = f.cliente;
    const r = regras();
    $('#fpTitle').textContent = c.nome;
    $('#fpBody').innerHTML = `<div class="stack-lg fp-ficha">
      <div class="fp-saldo"><b class="mono">${num(c.pontos)}</b><span>pontos</span></div>
      ${c.nivel_atual ? `<div class="fp-nivel-ficha" style="--nv:${esc(c.nivel_atual.cor)}"><span class="fp-selo">${esc(c.nivel_atual.nome)}</span>
        <small>${num(c.nivel_atual.pontos_nivel)} pontos de nível${c.nivel_atual.proximo ? ` · faltam ${num(c.nivel_atual.proximo.falta)} para ${esc(c.nivel_atual.proximo.nome)}` : ' · nível mais alto'}</small></div>` : ''}
      ${editando ? `<form class="stack" id="fpEditar" novalidate>
          <label class="field"><span>Nome completo</span><input class="input" name="nome" maxlength="80" value="${esc(c.nome)}" required></label>
          <label class="field"><span>E-mail</span><input class="input" name="email" type="email" maxlength="120" value="${esc(c.email || '')}"></label>
          <label class="field"><span>Celular</span><input class="input" name="telefone" type="tel" maxlength="16" value="${esc(tel(c.telefone))}"></label>
          <label class="check"><input type="checkbox" name="marketing" ${c.marketing ? 'checked' : ''}> <span>Aceita receber promoções</span></label>
          <div class="vhead-actions"><button type="submit" class="btn btn-cobalt btn-sm">Salvar</button><button type="button" class="btn btn-quiet btn-sm" data-fp-ficha="ver">Cancelar</button></div>
        </form>`
        : `<dl class="fp-dados">
          <div><dt>CPF</dt><dd class="mono">${fmtCpf(c.cpf)}</dd></div>
          <div><dt>Celular</dt><dd>${c.telefone ? `<a href="https://wa.me/55${F.soDigitos(c.telefone)}" target="_blank" rel="noopener">${esc(tel(c.telefone))}</a>` : '-'}</dd></div>
          <div><dt>E-mail</dt><dd>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '-'}</dd></div>
          <div><dt>Desde</dt><dd>${data(c.criado_em)}</dd></div>
          <div><dt>Código de indicação</dt><dd class="mono">${esc(c.codigo || '-')}</dd></div>
          ${c.indicado_por ? `<div><dt>Indicado por</dt><dd><button type="button" class="link" data-fp-cliente="${esc(c.indicado_por)}">${esc(c.indicado_por_nome || cpfOculto(c.indicado_por))}</button></dd></div>` : ''}
          <div><dt>Promoções</dt><dd>${c.marketing ? 'Aceita' : 'Não aceita'}</dd></div>
        </dl>
        <div class="vhead-actions">
          <button type="button" class="btn btn-line btn-sm" data-fp-ficha="editar">${icon('edit')} Editar</button>
          <button type="button" class="btn btn-line btn-sm" data-fp-ficha="pin">${icon('lock')} Redefinir PIN</button>
          <button type="button" class="btn btn-danger btn-sm" data-fp-ficha="excluir">${icon('trash')} Excluir</button>
        </div>`}
      ${r.manual ? `<form class="fp-manual" id="fpManual" novalidate>
          <h3>Lançar compra sem nota</h3>
          <div class="fp-manual-row">
            <label class="field"><span>Valor</span><input class="input mono" name="valor" inputmode="decimal" placeholder="0,00" required></label>
            <label class="field"><span>Motivo</span><input class="input" name="descricao" maxlength="100" placeholder="Ex.: pedido do delivery"></label>
            <button type="submit" class="btn btn-cobalt btn-sm">Lançar</button>
          </div></form>` : ''}
      ${f.top && f.top.length ? `<section class="stack"><h3 class="fp-h3">Mais pedidos por ${esc(c.nome.split(' ')[0])}</h3>${tabelaProdutos(f.top.slice(0, 5), '')}</section>` : ''}
      ${f.resgates.length ? `<section class="stack"><h3 class="fp-h3">Trocas</h3><ul class="fp-mov">${f.resgates.map((x) => `<li>
          <span><b>${esc(x.premio_nome)}</b></span><span class="muted">código ${esc(x.codigo)} · ${dataHora(x.criado_em)}</span>
          <b class="fp-st fp-st--${x.status}">${STATUS[x.status]}</b></li>`).join('')}</ul></section>` : ''}
      <section class="stack"><h3 class="fp-h3">Notas</h3>${f.notas.length ? `<ul class="fp-mov">${f.notas.map((n) => `<li>
          <span>nº ${num(+n.chave.slice(25, 34))}${n.valor ? ` · ${brl(n.valor)}` : ''}</span>
          <span class="muted">${dataHora(n.emitida_em || n.lida_em)}${n.motivo ? ` · ${esc(n.motivo)}` : ''}</span>
          <b class="fp-st fp-st--${n.status}">${n.status === 'creditada' && n.pontos != null ? `+${num(n.pontos)}` : STATUS[n.status]}</b></li>`).join('')}</ul>` : '<p class="muted">Nenhuma nota.</p>'}</section>
      <section class="stack"><h3 class="fp-h3">Extrato</h3>${f.movimentos.length ? `<ul class="fp-mov">${f.movimentos.map((m) => `<li>
          <span>${esc(m.descricao || TIPO[m.tipo] || m.tipo)}</span>
          <span class="muted">${dataHora(m.criado_em)}${m.por ? ` · ${esc(m.por)}` : ''}</span>
          <b class="${m.pontos < 0 ? 'fp-neg' : 'fp-pos'}">${m.pontos > 0 ? '+' : ''}${num(m.pontos)}</b></li>`).join('')}</ul>` : '<p class="muted">Sem movimentos.</p>'}</section>
    </div>`;
  }

  /* ---------- Prêmios ---------- */
  function tPremios() {
    const lista = P.premios;
    const ed = P.premioEdit;
    return `<div class="fp-grid">
      <div class="aj-col">
        <section class="panel stack">
          <div class="fp-h"><h2>Catálogo</h2><button type="button" class="btn btn-cobalt btn-sm" data-fp-premio="novo">${icon('plus')} Novo prêmio</button></div>
          ${!lista ? '<p class="muted">Carregando…</p>' : !lista.length ? '<p class="muted">Nenhum prêmio ainda. Comece por algo simples, como uma bebida ou uma sobremesa.</p>'
            : `<ul class="fp-premios">${lista.map((p) => `<li class="fp-premio ${p.ativo ? '' : 'is-off'}">
                <div class="fp-premio-img">${p.imagem ? `<img src="${esc(p.imagem)}" alt="" loading="lazy">` : icon('gift')}</div>
                <div class="fp-item-body"><b>${esc(p.nome)} ${p.nivel_min ? seloNivel(p.nivel_min, 'fp-selo--sm') : ''}</b><small>${pts(p.pontos)}${p.ativo ? '' : ' · escondido'}${p.descricao ? ` · ${esc(p.descricao)}` : ''}</small></div>
                <button type="button" class="icon-btn" data-fp-premio="${esc(p.id)}" aria-label="Editar ${esc(p.nome)}">${icon('edit')}</button>
              </li>`).join('')}</ul>`}
        </section>
      </div>
      <div class="aj-col">${ed ? premioForm(ed) : `<section class="panel stack"><h2>Dica</h2>
        <p class="muted">Com ${regras().pontosPorReal || 1} ${(+regras().pontosPorReal || 1) === 1 ? 'ponto' : 'pontos'} por real, um prêmio de 150 pontos sai para quem gastou R$ ${num(Math.round(150 / (+regras().pontosPorReal || 1)))}. Um retorno de 5% a 10% do valor gasto costuma funcionar bem.</p></section>`}</div>
    </div>`;
  }
  function premioForm(p) {
    return `<form class="panel stack" id="fpPremioForm" novalidate>
      <h2>${p.id ? 'Editar prêmio' : 'Novo prêmio'}</h2>
      <div class="fp-foto ${p.imagem ? 'has-img' : ''}">${p.imagem ? `<img src="${esc(p.imagem)}" alt="">` : icon('gift')}
        <label class="btn btn-line btn-sm">${icon('upload')} ${p.imagem ? 'Trocar foto' : 'Enviar foto'}<input type="file" accept="image/*" class="sr-only" data-fp-foto></label>
        ${p.imagem ? '<button type="button" class="btn btn-quiet btn-sm" data-fp-sem-foto>Tirar foto</button>' : ''}</div>
      <label class="field"><span>Nome</span><input class="input" name="nome" maxlength="60" required value="${esc(p.nome || '')}" placeholder="Ex.: Caipirinha da casa"></label>
      <label class="field"><span>Descrição (opcional)</span><input class="input" name="descricao" maxlength="160" value="${esc(p.descricao || '')}"></label>
      <div class="fp-manual-row">
        <label class="field"><span>Pontos</span><input class="input mono" name="pontos" type="number" min="1" max="1000000" required value="${esc(p.pontos || '')}"></label>
        ${niveisCfg().length ? `<label class="field"><span>Quem pode trocar</span><select class="input" name="nivel_min">
          <option value="">Todos os clientes</option>
          ${niveisCfg().slice(1).map((l) => `<option value="${esc(l.id)}" ${p.nivel_min === l.id ? 'selected' : ''}>Nível ${esc(l.nome)} em diante</option>`).join('')}
        </select></label>` : ''}
      </div>
      <small class="help">Os prêmios aparecem para o cliente do que custa menos para o que custa mais.</small>
      <label class="check"><input type="checkbox" name="ativo" ${p.ativo !== false ? 'checked' : ''}> <span>Mostrar para os clientes</span></label>
      <div class="vhead-actions">
        <button type="submit" class="btn btn-cobalt btn-sm">Salvar prêmio</button>
        <button type="button" class="btn btn-quiet btn-sm" data-fp-premio="fechar">Cancelar</button>
        ${p.id ? `<button type="button" class="btn btn-danger btn-sm" data-fp-premio-del="${esc(p.id)}">${icon('trash')} Excluir</button>` : ''}
      </div>
    </form>`;
  }

  /* ---------- Regras ---------- */
  function tRegras() {
    const r = P.regras || (P.regras = JSON.parse(JSON.stringify(regras())));
    const ind = r.indicacao || {};
    const link = linkPrograma();
    return `<form class="fp-grid" id="fpRegras" novalidate>
      <div class="aj-col">
        <section class="panel stack">
          <div class="set-row fp-row"><div><h3>Programa no ar</h3><p>Mostra o atalho na página da mesa e aceita notas.</p></div>
            <label class="switch"><input type="checkbox" name="ativo" ${r.ativo ? 'checked' : ''} aria-label="Programa no ar"><span></span></label></div>
          <label class="field"><span>Nome do programa</span><input class="input" name="nome" maxlength="40" value="${esc(r.nome)}" placeholder="Clube de pontos"></label>
          <label class="field"><span>Pontos a cada R$ 1</span><input class="input mono" name="pontosPorReal" type="number" min="0.01" max="100" step="0.01" value="${esc(r.pontosPorReal)}">
            <small class="help">Ex.: 1 dá 1 ponto por real; 0,5 dá 1 ponto a cada R$ 2. Centavos não contam.</small></label>
          <label class="field"><span>CNPJ das notas</span><textarea class="input mono" name="cnpjs" rows="2" placeholder="00.000.000/0000-00">${esc((r.cnpjs || []).map(fmtCnpj).join('\n'))}</textarea>
            <small class="help">Só notas emitidas por estes CNPJs valem pontos. Um por linha, se o restaurante tiver mais de um.</small></label>
          <div class="fp-manual-row">
            <label class="field"><span>Prazo para ler a nota (dias)</span><input class="input mono" name="prazoDias" type="number" min="1" max="90" value="${esc(r.prazoDias)}"></label>
            ${campoData('inicio', r.inicio, 'Vale para compras desde')}
          </div>
        </section>
        <section class="panel stack">
          <div class="fp-h"><h2>Dias com mais pontos</h2><button type="button" class="btn btn-line btn-sm" data-fp-boost="novo">${icon('plus')} Adicionar</button></div>
          ${(r.boosts || []).length ? r.boosts.map(boostForm).join('') : '<p class="muted">Ex.: terça com pontos em dobro, ou happy hour com 1,5x.</p>'}
        </section>
        ${niveisForm(r)}
      </div>
      <div class="aj-col">
        <section class="panel stack">
          <div class="set-row fp-row"><div><h3>Ranking do clube</h3><p>Mostra aos clientes o top 10 de quem mais ganhou pontos (primeiro nome e inicial).</p></div>
            <label class="switch"><input type="checkbox" name="rankAtivo" ${!r.ranking || r.ranking.ativo !== false ? 'checked' : ''} aria-label="Ranking do clube"><span></span></label></div>
        </section>
        <section class="panel stack">
          <div class="set-row fp-row"><div><h3>Indicação</h3><p>O cliente convida alguém com o código dele e os dois ganham pontos.</p></div>
            <label class="switch"><input type="checkbox" name="indAtivo" ${ind.ativo ? 'checked' : ''} aria-label="Indicação"><span></span></label></div>
          <div class="fp-manual-row">
            <label class="field"><span>Quem indica ganha</span><input class="input mono" name="indIndicador" type="number" min="0" max="100000" value="${esc(ind.indicador || 0)}"></label>
            <label class="field"><span>Quem foi indicado ganha</span><input class="input mono" name="indIndicado" type="number" min="0" max="100000" value="${esc(ind.indicado || 0)}"></label>
          </div>
          <label class="field"><span>Os pontos entram</span><select class="input" name="indQuando">
            <option value="cadastro" ${ind.quando !== 'compra' ? 'selected' : ''}>Assim que o indicado se cadastra</option>
            <option value="compra" ${ind.quando === 'compra' ? 'selected' : ''}>Na primeira compra do indicado (mais seguro)</option>
          </select></label>
        </section>
        ${sefazForm(r)}
        <section class="panel stack">
          <div class="set-row fp-row"><div><h3>Lançamento manual</h3><p>Deixa a equipe lançar compras sem nota (ex.: delivery) na ficha do cliente. Fica registrado quem lançou.</p></div>
            <label class="switch"><input type="checkbox" name="manual" ${r.manual ? 'checked' : ''} aria-label="Lançamento manual"><span></span></label></div>
        </section>
        <section class="panel stack">
          <label class="field"><span>Regulamento</span><textarea class="input" name="regulamento" rows="7" maxlength="6000" placeholder="Como os pontos funcionam, validade, prêmios, dados pessoais…">${esc(r.regulamento || '')}</textarea></label>
        </section>
        <section class="panel stack fp-link">
          <h2>Link do programa</h2>
          <p class="muted">Divulgue no Instagram, no delivery ou num QR no balcão. Abre direto no programa.</p>
          <div class="fp-qr">${qrSvg(link, { cell: 4, margin: 1 })}</div>
          <div class="vhead-actions"><a class="link mono" href="${esc(link)}" target="_blank" rel="noopener">${esc(link)}</a>
            <button type="button" class="btn btn-line btn-sm" data-fp-copiar="${esc(link)}">${icon('copy')} Copiar</button></div>
        </section>
      </div>
      <div class="fp-salvar" ${P.regrasSujas ? '' : 'hidden'}><span class="fp-salvar-txt">Mudanças não salvas</span><button type="submit" class="btn btn-cobalt">${icon('check')} Salvar regras</button>
        <button type="button" class="btn btn-quiet" data-fp-regras="desfazer">Desfazer</button></div>
    </form>`;
  }
  // Conferência automática na SEFAZ: opcional, cobrada por nota conferida junto com a mensalidade.
  function sefazForm(r) {
    const on = !!(r.sefaz && r.sefaz.ativo);
    const adm = !!(ctx.S.user && ctx.S.user.admin);
    const preco = window.Precos ? Precos.SEFAZ_NOTA : 0.25;
    return `<section class="panel stack fp-sefaz">
      <div class="set-row fp-row"><div><h3>Conferência automática na SEFAZ</h3>
        <p>Cada nota lida é conferida na hora no site da SEFAZ: valor oficial, CPF e produtos. Os pontos entram sem a equipe aprovar e os produtos alimentam o ranking de mais pedidos.</p></div>
        <label class="switch"><input type="checkbox" name="sefazAtivo" ${on ? 'checked' : ''} ${adm ? '' : 'disabled'} aria-label="Conferência automática na SEFAZ"><span></span></label></div>
      <p class="note">${icon('receipt')}<span><b>${brl(preco)} por nota conferida</b>, somado à mensalidade no fim do mês. Sem limite: não para no meio do mês. O uso aparece em Ajustes → Plano.</span></p>
      <p class="help">${on ? '' : 'Desligada: o cliente confirma o valor da nota e a equipe aprova em Fidelidade → Hoje (sem custo). '}${adm ? '' : 'Só o administrador liga ou desliga.'}${on && r.sefaz.em ? ` Ligada em ${new Date(r.sefaz.em).toLocaleDateString('pt-BR')}${r.sefaz.por ? ` por ${esc(r.sefaz.por)}` : ''}.` : ''}</p>
    </section>`;
  }
  function niveisForm(r) {
    const n = r.niveis || { ativo: false, base: 'sempre', meses: 12, lista: [] };
    const lista = n.lista || [];
    return `<section class="panel stack fp-niveis">
      <div class="set-row fp-row"><div><h3>Níveis do clube</h3><p>Ex.: Bronze, Prata e Ouro. O cliente sobe de nível com os pontos que ganha nas compras e ganha vantagens em cada um.</p></div>
        <label class="switch"><input type="checkbox" name="nvAtivo" ${n.ativo ? 'checked' : ''} aria-label="Níveis do clube"><span></span></label></div>
      <div class="fp-manual-row">
        <label class="field"><span>Contar os pontos</span><select class="input" name="nvBase">
          <option value="sempre" ${n.base !== 'meses' ? 'selected' : ''}>Desde o cadastro (nunca cai de nível)</option>
          <option value="meses" ${n.base === 'meses' ? 'selected' : ''}>Só dos últimos meses (pode cair de nível)</option></select></label>
        <label class="field fp-meses" ${n.base === 'meses' ? '' : 'hidden'}><span>Meses</span><input class="input mono" name="nvMeses" type="number" min="1" max="60" value="${esc(n.meses || 12)}"></label>
      </div>
      <small class="help">Contam os pontos das compras (com os bônus de nível e dos dias com mais pontos). Bônus de indicação e de nível não contam, e trocar pontos por prêmios não faz o cliente cair.</small>
      ${lista.map((l, i) => nivelForm(l, i, lista.length)).join('')}
      <div class="vhead-actions">
        ${lista.length < 6 ? `<button type="button" class="btn btn-line btn-sm" data-fp-nivel="novo">${icon('plus')} Adicionar nível</button>` : ''}
        ${!lista.length ? '<button type="button" class="btn btn-quiet btn-sm" data-fp-nivel="modelo">Usar o modelo Bronze, Prata e Ouro</button>' : ''}
      </div>
    </section>`;
  }
  function nivelForm(l, i, total) {
    return `<fieldset class="fp-nivel" data-nidx="${i}" style="--nv:${esc(l.cor || '#8C6416')}">
      <div class="fp-nivel-h"><span class="fp-selo" data-fp-previa>${esc(l.nome || 'Nível ' + (i + 1))}</span>
        <small class="muted">${i === 0 ? 'Nível de entrada: todo cliente começa aqui' : `Nível ${i + 1} de ${total}`}</small>
        <button type="button" class="icon-btn" data-fp-nivel-del="${i}" aria-label="Remover nível">${icon('trash')}</button></div>
      <div class="fp-manual-row">
        <label class="field"><span>Nome</span><input class="input" name="n-nome" maxlength="30" value="${esc(l.nome || '')}" placeholder="Ex.: Ouro" required></label>
        <label class="field"><span>Frase curta (opcional)</span><input class="input" name="n-descricao" maxlength="80" value="${esc(l.descricao || '')}" placeholder="Ex.: Os mais fiéis"></label>
      </div>
      <div class="fp-cores" role="group" aria-label="Cor do nível">
        ${CORES_NIVEL.map((c) => `<button type="button" class="fp-cor ${String(l.cor).toLowerCase() === c ? 'is-on' : ''}" style="--c:${c}" data-fp-cor="${c}" aria-label="Cor ${c}"></button>`).join('')}
        <label class="fp-cor fp-cor--livre" title="Outra cor"><input type="color" name="n-cor" value="${esc(/^#[0-9a-f]{6}$/i.test(l.cor || '') ? l.cor : '#8c6416')}" aria-label="Outra cor"></label>
      </div>
      <div class="fp-manual-row">
        <label class="field"><span>A partir de (pontos)</span><input class="input mono" name="n-minimo" type="number" min="0" max="10000000" value="${i === 0 ? 0 : esc(l.minimo || '')}" ${i === 0 ? 'disabled' : ''}></label>
        <label class="field"><span>Bônus nas compras</span><select class="input" name="n-mult">${MULTS.map(([m, t]) => `<option value="${m}" ${+l.mult === m ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="field"><span>Pontos ao chegar</span><input class="input mono" name="n-bonus" type="number" min="0" max="100000" value="${esc(l.bonus || 0)}"></label>
      </div>
      <label class="field"><span>Vantagens (uma por linha)</span><textarea class="input" name="n-beneficios" rows="3" maxlength="700" placeholder="Ex.: Sobremesa no aniversário">${esc((l.beneficios || []).join('\n'))}</textarea>
        <small class="help">Aparecem para o cliente. O bônus nas compras e os pontos ao chegar já entram sozinhos na lista. Prêmios exclusivos do nível: marque na aba Prêmios.</small></label>
    </fieldset>`;
  }
  function boostForm(b, i) {
    return `<fieldset class="fp-boost" data-bidx="${i}">
      <div class="fp-manual-row">
        <label class="field"><span>Nome</span><input class="input" name="b-nome" maxlength="40" value="${esc(b.nome || '')}" placeholder="Terça em dobro"></label>
        <label class="field fp-mult"><span>Multiplica</span><select class="input" name="b-mult">${[1.5, 2, 3].map((m) => `<option value="${m}" ${+b.mult === m ? 'selected' : ''}>${String(m).replace('.', ',')}x</option>`).join('')}</select></label>
      </div>
      <div class="fp-dias" role="group" aria-label="Dias">${DIAS.map(([d, l]) => `<label><input type="checkbox" name="b-dia" value="${d}" ${(b.dias || []).includes(d) ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      <div class="fp-manual-row">
        ${campoHora('b-de', b.de, 'Das')}
        ${campoHora('b-ate', b.ate, 'Até')}
        ${campoData('b-inicio', b.inicio, 'Começa')}
        ${campoData('b-fim', b.fim, 'Termina')}
      </div>
      <div class="fp-boost-foot"><small class="help">Sem dias marcados vale todo dia; sem horário, o dia inteiro.</small>
        <button type="button" class="btn btn-quiet btn-sm" data-fp-boost-del="${i}">${icon('trash')} Remover</button></div>
    </fieldset>`;
  }

  // Lê o formulário de regras para P.regras (sem salvar), para não perder o que foi digitado ao redesenhar.
  function lerRegras() {
    const f = $('#fpRegras');
    if (!f) return P.regras;
    const v = (n) => f.elements[n];
    const r = P.regras;
    r.ativo = v('ativo').checked;
    r.nome = v('nome').value.trim().slice(0, 40) || 'Clube de pontos';
    r.pontosPorReal = Math.max(0, +String(v('pontosPorReal').value).replace(',', '.') || 0);
    r.cnpjs = [...new Set(v('cnpjs').value.split(/[\n,;]+/).map(F.soDigitos).filter(Boolean))];
    r.prazoDias = Math.round(+v('prazoDias').value || 7);
    const invalidas = [];
    const di = (valor, rotulo) => {
      const x = dataIso(valor);
      if (x === undefined) invalidas.push(rotulo);
      return x || '';
    };
    r.inicio = di(v('inicio').value, 'Vale para compras desde') || null;
    r.ranking = { ativo: v('rankAtivo').checked };
    if (v('sefazAtivo').checked !== !!(r.sefaz && r.sefaz.ativo)) r.sefaz = { ativo: v('sefazAtivo').checked, em: new Date().toISOString(), por: (ctx.S.user && ctx.S.user.nome) || '' };
    r.indicacao = { ativo: v('indAtivo').checked, indicador: Math.round(+v('indIndicador').value || 0), indicado: Math.round(+v('indIndicado').value || 0), quando: v('indQuando').value === 'compra' ? 'compra' : 'cadastro' };
    r.manual = v('manual').checked;
    r.regulamento = v('regulamento').value.trim();
    r.boosts = [...f.querySelectorAll('.fp-boost')].map((el, i) => {
      const q = (n) => el.querySelector(`[name="${n}"]`);
      return {
        id: (r.boosts[i] && r.boosts[i].id) || Math.random().toString(36).slice(2, 10),
        nome: q('b-nome').value.trim().slice(0, 40), mult: +q('b-mult').value,
        dias: [...el.querySelectorAll('[name="b-dia"]:checked')].map((x) => +x.value),
        de: q('b-de').value.trim(), ate: q('b-ate').value.trim(),
        inicio: di(q('b-inicio').value, `${q('b-nome').value.trim() || 'Dia com mais pontos'}: começa`),
        fim: di(q('b-fim').value, `${q('b-nome').value.trim() || 'Dia com mais pontos'}: termina`), ativo: true,
      };
    });
    const antes = (r.niveis && r.niveis.lista) || [];
    r.niveis = {
      ativo: v('nvAtivo').checked, base: v('nvBase').value === 'meses' ? 'meses' : 'sempre', meses: Math.round(+v('nvMeses').value || 12),
      lista: [...f.querySelectorAll('.fp-nivel')].map((el, i) => {
        const q = (n) => el.querySelector(`[name="${n}"]`);
        const nome = q('n-nome').value.trim().slice(0, 30);
        return {
          id: (antes[i] && antes[i].id) || novoId(nome), nome, descricao: q('n-descricao').value.trim().slice(0, 80), cor: q('n-cor').value,
          minimo: i === 0 ? 0 : Math.round(+q('n-minimo').value || 0), mult: +q('n-mult').value || 1, bonus: Math.round(+q('n-bonus').value || 0),
          beneficios: q('n-beneficios').value.split('\n').map((x) => x.trim().slice(0, 80)).filter(Boolean).slice(0, 8),
        };
      }),
    };
    P.regrasInvalidas = invalidas;
    return r;
  }
  function validarRegras(r) {
    if ((P.regrasInvalidas || []).length) return `Data inválida em “${P.regrasInvalidas[0]}”. Use dd/mm/aaaa.`;
    for (const b of r.boosts) {
      if (!horaOk(b.de) || !horaOk(b.ate)) return `${b.nome || 'Dia com mais pontos'}: horário inválido. Use hh:mm, de 00:00 a 23:59.`;
    }
    const nv = r.niveis;
    if (nv.ativo && !nv.lista.length) return 'Crie pelo menos um nível, ou desligue os níveis do clube.';
    if (nv.base === 'meses' && !(nv.meses >= 1 && nv.meses <= 60)) return 'Os meses dos níveis vão de 1 a 60.';
    const nomes = new Set();
    for (const [i, l] of nv.lista.entries()) {
      if (!l.nome) return `Dê um nome ao nível ${i + 1}.`;
      if (nomes.has(l.nome.toLowerCase())) return `Há dois níveis chamados “${l.nome}”.`;
      nomes.add(l.nome.toLowerCase());
      if (i > 0 && !(l.minimo > nv.lista[i - 1].minimo)) return `O nível ${l.nome} precisa de mais pontos que o ${nv.lista[i - 1].nome} (${num(nv.lista[i - 1].minimo)}).`;
      if (l.bonus < 0 || l.bonus > 100000) return `${l.nome}: pontos ao chegar vão de 0 a 100.000.`;
    }
    if (!(r.pontosPorReal > 0 && r.pontosPorReal <= 100)) return 'Informe quantos pontos vale cada R$ 1 (entre 0,01 e 100).';
    const ruim = r.cnpjs.find((c) => c.length !== 14);
    if (ruim) return `CNPJ incompleto: ${ruim}. São 14 números.`;
    if (r.ativo && !r.cnpjs.length) return 'Para colocar no ar, informe o CNPJ que sai nas notas.';
    if (!(r.prazoDias >= 1 && r.prazoDias <= 90)) return 'O prazo para ler a nota vai de 1 a 90 dias.';
    for (const b of r.boosts) {
      if (!b.dias.length && !b.de && !b.ate && !b.inicio && !b.fim) return `${b.nome || 'Dia com mais pontos'}: marque os dias, o horário ou as datas em que vale. Para não usar, toque em Remover.`;
      if ((b.de && !b.ate) || (!b.de && b.ate)) return `${b.nome || 'Dia com mais pontos'}: preencha o horário de início e de fim, ou deixe os dois vazios.`;
      if (b.inicio && b.fim && b.fim < b.inicio) return `${b.nome || 'Dia com mais pontos'}: a data de término vem antes do começo.`;
    }
    return null;
  }

  /* ============================== Ações ============================== */
  const valorDe = (t) => {
    const s = String(t || '').trim().replace(/[^\d,.]/g, '');
    const v = /,\d{1,2}$/.test(s) ? +s.replace(/\./g, '').replace(',', '.') : +s.replace(/,/g, '');
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN;
  };
  // Redesenha as regras a partir de P.regras (já lidas ou alteradas aqui), sem reler o formulário antigo.
  const redesenhar = () => {
    P.jaLido = true;
    ctx.rerender();
  };
  const recarregar = async () => {
    P.ranking = null;
    await atualizar();
    if (ctx.S.view === 'fidelidade') ctx.rerender();
    ctx.chrome();
  };

  async function importar(files) {
    if (!files.length || P.importando) return;
    P.importando = true;
    ctx.rerender();
    let msg;
    try {
      const { notas, resumo } = await Nfce.lerArquivos(files);
      if (!notas.length) {
        msg = `<p class="note">${icon('alert')}<span>Nenhuma NFC-e encontrada nos arquivos (${resumo.arquivos} ${resumo.arquivos === 1 ? 'arquivo' : 'arquivos'}). Envie os XML das notas ou o ZIP do caixa.</span></p>`;
      } else {
        const r = await ctx.store.fidImportarXml(notas);
        const linhas = [
          [r.creditadas, `${r.creditadas === 1 ? 'nota creditada' : 'notas creditadas'} (${pts(r.pontos || 0)})`],
          [r.ajustadas, r.ajustadas === 1 ? 'nota aprovada à mão teve o valor corrigido' : 'notas aprovadas à mão tiveram o valor corrigido'],
          [r.estornadas, r.estornadas === 1 ? 'nota cancelada: pontos estornados' : 'notas canceladas: pontos estornados'],
          [r.recusadas, r.recusadas === 1 ? 'nota recusada (cancelada ou fora do prazo)' : 'notas recusadas (canceladas ou fora do prazo)'],
          [r.ja_conferidas, r.ja_conferidas === 1 ? 'já estava conferida' : 'já estavam conferidas'],
          [r.sem_cadastro, `${r.sem_cadastro === 1 ? 'nota' : 'notas'} com CPF de quem ainda não é cliente (${r.sem_cadastro === 1 ? 'fica guardada' : 'ficam guardadas'} para quando se cadastrar)`],
          [r.sem_cpf, `${r.sem_cpf === 1 ? 'nota' : 'notas'} sem CPF`],
          [r.outro_cnpj, `${r.outro_cnpj === 1 ? 'nota' : 'notas'} de outro CNPJ (ignoradas)`],
          [r.invalidas, `${r.invalidas === 1 ? 'nota inválida' : 'notas inválidas'}`],
        ].filter(([n]) => n);
        msg = `<div class="fp-xml-res"><b>${num(r.recebidas || notas.length)} ${(r.recebidas || notas.length) === 1 ? 'nota lida' : 'notas lidas'}</b>
          <ul>${linhas.map(([n, t]) => `<li><b>${num(n)}</b> ${t}</li>`).join('')}</ul></div>`;
        toast('Arquivo importado.', { tone: 'ok' });
      }
    } catch (e) {
      console.error(e);
      msg = `<p class="form-error">${esc(erroMsg(e))}</p>`;
    }
    P.importando = false;
    await recarregar();
    const el = $('#fpXmlRes');
    if (el) el.innerHTML = msg;
  }

  // Nota lida no balcão: CPF do cliente, QR da nota e valor → credita na hora.
  function lancarNota() {
    $('#fpTitle').textContent = 'Lançar nota';
    $('#fpBody').innerHTML = `<form class="stack" id="fpLancar" novalidate>
      <label class="field"><span>CPF do cliente (o mesmo da nota)</span><input class="input mono" name="cpf" inputmode="numeric" maxlength="14" placeholder="000.000.000-00" required></label>
      <p class="form-error" id="fpLancarErro" role="alert"></p>
      <button type="submit" class="btn btn-cobalt btn-block">${icon('receipt')} Ler o QR da nota</button>
    </form>`;
    openSheet('sh-fp');
  }
  // Valor da nota lido da imagem: primeiro o quadro em que o QR foi achado, depois a câmera no total.
  let pararCam = null;
  const pararOcr = () => { if (pararCam) pararCam(); pararCam = null; };
  function ocrMsg(html, camera) {
    const m = $('#fpOcrMsg');
    const box = $('#fpLancar2 .fid-ocr');
    if (m) m.innerHTML = html;
    if (box) box.hidden = !camera;
  }
  function ocrAchou(qr, v) {
    const f = $('#fpLancar2');
    if (!f || f.dataset.qr !== qr) return;
    pararOcr();
    if (!f.dataset.digitou) f.elements.valor.value = v.toFixed(2).replace('.', ',');
    ocrMsg(`Valor lido da nota: <b>${brl(v)}</b>. Confira antes de creditar.`, false);
  }
  async function ocrValor(qr, quadro) {
    if (!window.OcrNota) return ocrMsg('Digite o valor total da nota.', false);
    if (quadro) {
      const v = await OcrNota.lerValor(quadro, quadro.naturalWidth || quadro.width, quadro.naturalHeight || quadro.height);
      if (v) return ocrAchou(qr, v);
    }
    const f = $('#fpLancar2');
    if (!f || f.dataset.qr !== qr) return;
    ocrMsg('Aponte a câmera para o <b>VALOR A PAGAR</b> da nota, ou digite o valor.', true);
    pararOcr();
    pararCam = OcrNota.camera(f.querySelector('video'), {
      achou: (v) => ocrAchou(qr, v),
      aviso: (a) => { if (a === 'sem-camera' || a === 'sem-ocr') ocrMsg('Digite o valor total da nota.', false); },
    });
  }
  function depoisDoQr(cpf, qr, quadro) {
    const chave = F.chaveDoTexto(qr);
    const doQr = F.valorDoQr ? F.valorDoQr(qr) : null;
    $('#fpTitle').textContent = 'Lançar nota';
    $('#fpBody').innerHTML = `<form class="stack" id="fpLancar2" novalidate data-cpf="${esc(cpf)}" data-qr="${esc(qr)}">
      <p>Nota nº <b>${num(+chave.slice(25, 34))}</b> para o CPF <b class="mono">${fmtCpf(cpf)}</b>.</p>
      ${/^https?:/i.test(qr) ? `<a class="link" href="${esc(qr)}" target="_blank" rel="noopener">${icon('external')} Conferir na SEFAZ</a>` : ''}
      <div class="fid-ocr" hidden><video playsinline muted></video><span class="fid-ocr-mira" aria-hidden="true"></span></div>
      <p class="fid-ocr-msg" id="fpOcrMsg" aria-live="polite">${doQr ? `Valor lido do QR: <b>${brl(doQr)}</b>. Confira antes de creditar.` : 'Procurando o valor na nota…'}</p>
      <label class="field"><span>Valor total da nota</span><input class="input mono" name="valor" inputmode="decimal" placeholder="0,00" value="${doQr ? doQr.toFixed(2).replace('.', ',') : ''}" required></label>
      <p class="form-error" id="fpLancarErro" role="alert"></p>
      <button type="submit" class="btn btn-cobalt btn-block">${icon('check')} Creditar pontos</button>
    </form>`;
    openSheet('sh-fp');
    if (!doQr) ocrValor(qr, quadro);
  }

  async function onClick(e) {
    const t = e.target;
    const tab = t.closest('[data-fp-tab]');
    if (tab) {
      if (P.tab === 'regras') lerRegras();
      P.tab = tab.dataset.fpTab;
      return ctx.rerender();
    }
    const dias = t.closest('[data-fp-dias]');
    if (dias) {
      P.dias = +dias.dataset.fpDias;
      P.ranking = null;
      return ctx.rerender();
    }
    const cli = t.closest('[data-fp-cliente]');
    if (cli) return abrirCliente(cli.dataset.fpCliente);
    const ent = t.closest('[data-fp-entregar]') || t.closest('[data-fp-cancelar]');
    if (ent) {
      const entregar = !!ent.dataset.fpEntregar;
      const id = ent.dataset.fpEntregar || ent.dataset.fpCancelar;
      const x = P.pend.resgates.find((r) => r.id === id);
      if (!entregar && !confirm(`Cancelar a troca${x ? ` de ${x.premio_nome}` : ''}? Os ${x ? pts(x.pontos) : 'pontos'} voltam para o cliente.`)) return;
      ent.disabled = true;
      try {
        await ctx.store.fidResgateDecidir(id, entregar);
        toast(entregar ? 'Prêmio entregue.' : 'Troca cancelada; os pontos voltaram.', { tone: 'ok' });
      } catch (ex) {
        toast(erroMsg(ex), { tone: 'error' });
      }
      return recarregar();
    }
    const rec = t.closest('[data-fp-recusar]');
    if (rec) {
      const motivo = prompt('Por que a nota não vale? O cliente vê este motivo.', 'Nota sem o CPF do cliente');
      if (motivo == null) return;
      try {
        await ctx.store.fidRecusarNota(rec.dataset.fpRecusar, motivo.trim());
        toast('Nota recusada.');
      } catch (ex) {
        toast(erroMsg(ex), { tone: 'error' });
      }
      return recarregar();
    }
    if (t.closest('[data-fp-lancar]')) return lancarNota();
    if (t.closest('[data-fp-exportar]')) return exportar();
    const cp = t.closest('[data-fp-copiar]');
    if (cp) return copyText(cp.dataset.fpCopiar).then((ok) => toast(ok ? 'Link copiado.' : 'Não foi possível copiar.', { tone: ok ? 'ok' : 'error' }));

    const fi = t.closest('[data-fp-ficha]');
    if (fi) return acaoFicha(fi.dataset.fpFicha);

    const pr = t.closest('[data-fp-premio]');
    if (pr) {
      const v = pr.dataset.fpPremio;
      P.premioEdit = v === 'fechar' ? null : v === 'novo' ? { nome: '', descricao: '', pontos: '', imagem: '', ativo: true, ordem: 0, nivel_min: null } : { ...(P.premios || []).find((p) => p.id === v) };
      ctx.rerender();
      if (P.premioEdit) setTimeout(() => { const i = $('#fpPremioForm [name=nome]'); i && i.focus(); }, 60);
      return;
    }
    const pd = t.closest('[data-fp-premio-del]');
    if (pd) {
      if (!confirm('Excluir este prêmio? Quem já trocou continua com o código. Para só esconder, desmarque “Mostrar para os clientes”.')) return;
      try {
        await ctx.store.fidExcluirPremio(pd.dataset.fpPremioDel);
        P.premioEdit = null;
        P.premios = null;
        toast('Prêmio excluído.');
      } catch (ex) {
        toast(erroMsg(ex), { tone: 'error' });
      }
      return ctx.rerender();
    }
    if (t.closest('[data-fp-sem-foto]')) {
      lerPremioForm();
      P.premioEdit.imagem = '';
      return ctx.rerender();
    }

    const nvb = t.closest('[data-fp-nivel]');
    if (nvb) {
      lerRegras();
      const n = P.regras.niveis;
      if (nvb.dataset.fpNivel === 'modelo') {
        n.lista = MODELO_NIVEIS.map((l) => ({ ...l, id: novoId(l.nome) }));
        n.ativo = true;
      } else {
        const ult = n.lista[n.lista.length - 1];
        n.lista.push({ id: '', nome: '', descricao: '', cor: CORES_NIVEL[n.lista.length % CORES_NIVEL.length], minimo: ult ? ult.minimo + 500 : 0, mult: 1, bonus: 0, beneficios: [] });
        n.ativo = true;
      }
      P.regrasSujas = true;
      redesenhar();
      setTimeout(() => { const i = [...document.querySelectorAll('.fp-nivel [name="n-nome"]')].find((x) => !x.value); i && i.focus(); }, 60);
      return;
    }
    const nvd = t.closest('[data-fp-nivel-del]');
    if (nvd) {
      lerRegras();
      const l = P.regras.niveis.lista[+nvd.dataset.fpNivelDel];
      if (l && l.nome && !confirm(`Remover o nível ${l.nome}? Os clientes dele passam para o nível abaixo quando você salvar.`)) return;
      P.regras.niveis.lista.splice(+nvd.dataset.fpNivelDel, 1);
      P.regrasSujas = true;
      return redesenhar();
    }
    const cor = t.closest('[data-fp-cor]');
    if (cor) {
      const fs = cor.closest('.fp-nivel');
      fs.querySelector('[name="n-cor"]').value = cor.dataset.fpCor;
      fs.style.setProperty('--nv', cor.dataset.fpCor);
      fs.querySelectorAll('[data-fp-cor]').forEach((b) => b.classList.toggle('is-on', b === cor));
      return marcarSujo();
    }
    const bo = t.closest('[data-fp-boost]');
    if (bo) {
      P.regrasSujas = true;
      lerRegras();
      P.regras.boosts.push({ id: Math.random().toString(36).slice(2, 10), nome: '', mult: 2, dias: [], de: '', ate: '', inicio: '', fim: '', ativo: true });
      return redesenhar();
    }
    const bd = t.closest('[data-fp-boost-del]');
    if (bd) {
      P.regrasSujas = true;
      lerRegras();
      P.regras.boosts.splice(+bd.dataset.fpBoostDel, 1);
      return redesenhar();
    }
    if (t.closest('[data-fp-regras="desfazer"]')) {
      P.regras = null;
      P.regrasSujas = false;
      return redesenhar();
    }
  }

  async function acaoFicha(a) {
    const f = P.ficha;
    if (!f) return;
    const c = f.cliente;
    if (a === 'editar') return renderFicha(true);
    if (a === 'ver') return renderFicha();
    try {
      if (a === 'pin') {
        if (!confirm(`Redefinir o PIN de ${c.nome}? O próximo PIN que a pessoa digitar no celular passa a valer. Confira o documento antes.`)) return;
        await ctx.store.fidRedefinirPin(c.cpf);
        toast('PIN redefinido. Peça para o cliente entrar e criar um PIN novo.', { tone: 'ok', ms: 5000 });
      } else if (a === 'excluir') {
        if (!confirm(`Excluir ${c.nome} do programa? Apaga o cadastro, os pontos (${num(c.pontos)}) e o extrato. Não tem volta.`)) return;
        await ctx.store.fidExcluirCliente(c.cpf);
        closeSheet();
        toast('Cliente excluído.');
        P.clientes = null;
        return recarregar();
      }
    } catch (ex) {
      toast(erroMsg(ex), { tone: 'error' });
    }
  }

  function lerPremioForm() {
    const f = $('#fpPremioForm');
    if (!f) return P.premioEdit;
    const v = (n) => f.elements[n];
    Object.assign(P.premioEdit, {
      nome: v('nome').value, descricao: v('descricao').value, pontos: v('pontos').value, ativo: v('ativo').checked,
      nivel_min: v('nivel_min') ? v('nivel_min').value || null : P.premioEdit.nivel_min || null,
    });
    return P.premioEdit;
  }

  async function onChange(e) {
    const t = e.target;
    if (t.closest('#fpRegras')) {
      marcarSujo();
      if (t.name === 'nvBase') $('.fp-meses').hidden = t.value !== 'meses';
    }
    if (t.matches('[data-fp-xml]')) {
      const files = [...(t.files || [])];
      t.value = '';
      return importar(files);
    }
    if (t.matches('[data-fp-foto]')) {
      const file = t.files && t.files[0];
      t.value = '';
      if (!file) return;
      lerPremioForm();
      const slot = t.closest('.fp-foto');
      slot && slot.classList.add('is-busy');
      try {
        const blob = await ctx.prepararImagem(file, 'premio');
        P.premioEdit.imagem = await ctx.store.uploadImage(blob, 'premio');
      } catch (ex) {
        console.error(ex);
        toast(erroMsg(ex), { tone: 'error' });
      }
      return ctx.rerender();
    }
  }

  // A barra de salvar só aparece depois de alguma mudança nas regras.
  function marcarSujo() {
    P.regrasSujas = true;
    const b = $('.fp-salvar');
    if (b) b.hidden = false;
  }
  const mascara = (t) => {
    const d = t.value.replace(/\D/g, '');
    if (t.dataset.fpMask === 'data') t.value = d.slice(0, 8).replace(/^(\d{2})(\d)/, '$1/$2').replace(/^(\d{2}\/\d{2})(\d)/, '$1/$2');
    else t.value = d.slice(0, 4).replace(/^(\d{2})(\d)/, '$1:$2');
  };

  let buscaT = 0;
  function onInput(e) {
    const t = e.target;
    if (t.name === 'valor' && t.form && t.form.id === 'fpLancar2') t.form.dataset.digitou = '1';
    if (t.dataset.fpMask && !(e.inputType || '').startsWith('delete')) mascara(t);
    if (t.closest('#fpRegras')) {
      marcarSujo();
      if (t.name === 'n-nome') t.closest('.fp-nivel').querySelector('[data-fp-previa]').textContent = t.value || 'Nível';
      if (t.name === 'n-cor') {
        const fs = t.closest('.fp-nivel');
        fs.style.setProperty('--nv', t.value);
        fs.querySelectorAll('[data-fp-cor]').forEach((b) => b.classList.remove('is-on'));
      }
    }
    if (t.id === 'fpBusca') {
      clearTimeout(buscaT);
      buscaT = setTimeout(async () => {
        P.busca = t.value;
        try {
          P.clientes = await ctx.store.fidClientes(P.busca);
        } catch (ex) {
          return toast(erroMsg(ex), { tone: 'error' });
        }
        ctx.rerender();
        const b = $('#fpBusca');
        if (b) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); }
      }, 300);
    }
    if (t.name === 'cpf' && t.closest('#fpLancar')) t.value = F.soDigitos(t.value).slice(0, 11).replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  }

  async function onSubmit(e) {
    const f = e.target;
    const id = f.id || (f.dataset.fpAprovar ? 'aprovar' : '');
    if (!['fpRegras', 'fpPremioForm', 'fpEditar', 'fpManual', 'fpLancar', 'fpLancar2', 'aprovar'].includes(id)) return;
    e.preventDefault();
    const btn = f.querySelector('[type=submit]');
    if (btn) btn.disabled = true;
    try {
      if (id === 'aprovar') {
        const valor = valorDe(f.elements.valor.value);
        if (!(valor > 0)) throw new Error('Informe o valor total da nota.');
        const d = dataIso(f.elements.data.value);
        if (d === undefined) throw new Error('Data da compra inválida. Use dd/mm/aaaa.');
        if (d && d > new Date().toISOString().slice(0, 10)) throw new Error('A data da compra não pode ser no futuro.');
        const pontos = await ctx.store.fidAprovarNota(f.dataset.fpAprovar, valor, d ? new Date(`${d}T12:00:00-03:00`).toISOString() : null);
        toast(`Nota aprovada: +${pts(pontos || 0)}.`, { tone: 'ok' });
        return recarregar();
      }
      if (id === 'fpRegras') {
        const r = lerRegras();
        const erro = validarRegras(r);
        if (erro) throw new Error(erro);
        const novo = { ...r, boosts: r.boosts.filter((b) => b.mult > 1) };
        await ctx.store.updateSettings({ fidelidade: novo });
        ctx.S.settings.fidelidade = novo;
        P.regras = null;
        P.regrasSujas = false;
        toast('Regras salvas. Já valem para os clientes.', { tone: 'ok' });
        redesenhar();
        return;
      }
      if (id === 'fpPremioForm') {
        const p = lerPremioForm();
        await ctx.store.fidSalvarPremio(p);
        P.premioEdit = null;
        P.premios = await ctx.store.fidPremios();
        toast('Prêmio salvo.', { tone: 'ok' });
        ctx.rerender();
        return;
      }
      if (id === 'fpEditar') {
        const v = (n) => f.elements[n];
        if (!v('nome').value.trim()) throw new Error('Informe o nome.');
        await ctx.store.fidEditarCliente(P.ficha.cliente.cpf, { nome: v('nome').value, email: v('email').value, telefone: v('telefone').value, marketing: v('marketing').checked });
        P.ficha = await ctx.store.fidCliente(P.ficha.cliente.cpf);
        P.clientes = null;
        toast('Cadastro atualizado.', { tone: 'ok' });
        renderFicha();
        return;
      }
      if (id === 'fpManual') {
        const valor = valorDe(f.elements.valor.value);
        if (!(valor > 0)) throw new Error('Informe o valor da compra.');
        const pontos = await ctx.store.fidLancar(P.ficha.cliente.cpf, valor, f.elements.descricao.value.trim() || 'Lançamento manual');
        toast(`+${pts(pontos || 0)} lançados.`, { tone: 'ok' });
        P.ficha = await ctx.store.fidCliente(P.ficha.cliente.cpf);
        renderFicha();
        recarregar();
        return;
      }
      if (id === 'fpLancar') {
        const cpf = F.soDigitos(f.elements.cpf.value);
        if (!F.cpfValido(cpf)) throw new Error('CPF inválido. Confira os números.');
        const c = await ctx.store.fidConsultar(cpf);
        if (c.status === 'novo') throw new Error('Este CPF ainda não tem cadastro. O cliente se cadastra pela página da mesa (atalho do programa).');
        if (c.status !== 'ok') throw new Error(c.mensagem || 'O programa não está no ar.');
        closeSheet();
        setTimeout(() => Leitor.abrir({
          titulo: 'Nota do cliente',
          dica: 'Aponte a câmera para o QR Code no fim da nota.',
          aceitar: (tx) => { const k = F.chaveDoTexto(tx); return k && F.chaveValida(k) ? null : 'Este QR não é de uma nota fiscal (NFC-e).'; },
          valor: true,
          pronto: async (tx, x) => {
            // Primeiro a conferência automática na SEFAZ; sem ela, o valor vem da foto e a equipe confere.
            if (ctx.store.fidSefaz) {
              $('#fpTitle').textContent = 'Lançar nota';
              $('#fpBody').innerHTML = '<div class="fid-carregando"><span class="dot"></span><p>Conferindo a nota na SEFAZ…</p></div>';
              openSheet('sh-fp');
              const r = await ctx.store.fidSefaz({ cpf, qr: tx });
              if (r.status === 'creditada') {
                closeSheet();
                toast(`+${pts(r.pontos || 0)} creditados. Nota conferida na SEFAZ${r.itens ? ` (${r.itens} ${r.itens === 1 ? 'produto' : 'produtos'})` : ''}.`, { tone: 'ok', ms: 5000 });
                return recarregar();
              }
              if (['repetida', 'recusada', 'erro', 'sem_cadastro', 'inativo'].includes(r.status)) {
                const msg = r.status === 'repetida' ? `Esta nota já foi registrada (${STATUS[r.nota] || r.nota}).`
                  : r.status === 'sem_cadastro' ? 'Este CPF não tem cadastro no programa.'
                  : r.status === 'inativo' ? 'O programa está pausado.' : r.motivo || r.mensagem || 'Esta nota não vale pontos.';
                $('#fpBody').innerHTML = `<div class="stack"><p class="form-error">${esc(msg)}</p><button type="button" class="btn btn-quiet btn-block" data-close>Fechar</button></div>`;
                return;
              }
            }
            depoisDoQr(cpf, tx, x && x.quadro);
          },
        }), 350);
        return;
      }
      if (id === 'fpLancar2') {
        pararOcr();
        const valor = valorDe(f.elements.valor.value);
        if (!(valor > 0)) throw new Error('Informe o valor total da nota.');
        const r = await ctx.store.fidRegistrarNota({ cpf: f.dataset.cpf, qr: f.dataset.qr, valor });
        if (r.status === 'creditada') {
          closeSheet();
          toast(`+${pts(r.pontos)} creditados.`, { tone: 'ok' });
          return recarregar();
        }
        if (r.status === 'repetida') throw new Error(`Esta nota já foi registrada (${STATUS[r.nota] || r.nota}).`);
        if (r.status !== 'pendente') throw new Error(r.mensagem || r.motivo || 'Esta nota não vale pontos.');
        const pontos = await ctx.store.fidAprovarNota(F.chaveDoTexto(f.dataset.qr), valor, null);
        closeSheet();
        toast(`+${pts(pontos || 0)} creditados.`, { tone: 'ok' });
        return recarregar();
      }
    } catch (ex) {
      const el = f.querySelector('.form-error');
      if (el) el.textContent = erroMsg(ex);
      else toast(erroMsg(ex), { tone: 'error', ms: 5000 });
    } finally {
      if (btn && document.contains(btn)) btn.disabled = false;
    }
  }

  async function exportar() {
    let lista;
    try {
      lista = await ctx.store.fidExportar();
    } catch (ex) {
      return toast(erroMsg(ex), { tone: 'error' });
    }
    const cel = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const linhas = [['Nome', 'CPF', 'E-mail', 'Celular', 'Pontos', 'Código de indicação', 'Aceita promoções', 'Cadastro'].map(cel).join(';')]
      .concat(lista.map((c) => [c.nome, fmtCpf(c.cpf), c.email, tel(c.telefone), c.pontos, c.codigo, c.marketing ? 'sim' : 'não', data(c.criado_em)].map(cel).join(';')));
    const blob = new Blob(['﻿' + linhas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `clientes-fidelidade-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast(`${num(lista.length)} ${lista.length === 1 ? 'cliente exportado' : 'clientes exportados'}. Contém dados pessoais: guarde com cuidado.`, { ms: 5000 });
  }

  function iniciar(c) {
    ctx = c;
    document.addEventListener('click', (e) => { if (e.target.closest('#main[data-view="fidelidade"], #sh-fp')) onClick(e); });
    document.addEventListener('change', (e) => { if (e.target.closest('#main[data-view="fidelidade"], #sh-fp')) onChange(e); });
    document.addEventListener('input', (e) => { if (e.target.closest('#main[data-view="fidelidade"], #sh-fp')) onInput(e); });
    document.addEventListener('submit', (e) => { if (e.target.closest('#main[data-view="fidelidade"], #sh-fp')) onSubmit(e); });
    const sh = document.getElementById('sh-fp');
    if (sh) sh.addEventListener('sheet:close', pararOcr);
  }

  window.FidPainel = { iniciar, atualizar, html, badge };
})();
