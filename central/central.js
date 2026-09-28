/*
 * Central de plaquinhas — uso interno (vocês).
 * Gera lotes de códigos únicos, entrega plaquinhas a um restaurante (endereço
 * do site dele), imprime os QR, exporta a lista e grava as etiquetas NFC.
 * Toda plaquinha aponta para ESTE site (/t/CODIGO); o redirecionador manda
 * para o site do restaurante (?tag=CODIGO), onde a equipe escolhe a mesa.
 */
(function () {
  const { $, $$, esc, icon, toast, qrSvg, ago, openSheet, closeSheet, copyText } = UI;
  const env = window.CENTRAL_ENV || {};
  const online = !!(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);
  const api = online ? supabaseApi() : localApi();

  const S = {
    user: null,
    view: 'visao',
    dias: 30,
    met: null,
    filtro: 'todas',
    lote: '',
    rest: '',
    busca: '',
    sel: new Set(),
    rests: [],
    tags: [],
    editRest: null,
  };

  // Local (python -m http.server na raiz): /central/t.html?c=CODIGO. Publicado: /t/CODIGO.
  const local = location.pathname.startsWith('/central/');
  const tagUrl = (c) => (local ? new URL(`/central/t.html?c=${c}`, location.origin).href : new URL(`/t/${c}`, location.origin).href);
  const restDe = (id) => S.rests.find((r) => r.id === id);
  const nomeArq = (t) => String(t || 'plaquinhas').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'plaquinhas';
  // PDF para a gráfica: uma plaquinha de 12 × 6 cm por página (central/placa.js).
  async function pdfPlaquinhas(codigos, titulo) {
    const lista = [...codigos].sort();
    toast(`Gerando PDF com ${lista.length} ${lista.length === 1 ? 'plaquinha' : 'plaquinhas'}…`);
    await Placa.baixarPdf(lista.map((c) => ({ codigo: c, url: tagUrl(c) })), `${nomeArq(titulo)}.pdf`);
  }
  const fmtAtivacao = (c) => { c = String(c || ''); return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c; };
  function mostrarAtivacao(r, novo) {
    $('#shTitle').textContent = novo ? 'Restaurante criado' : 'Código de ativação';
    $('#shBody').innerHTML = `<div class="stack ativ-sheet">
      <p>Passe este código para a equipe de <b>${esc(r.nome)}</b>:</p>
      <b class="ativ-grande mono">${fmtAtivacao(r.codigo_ativacao)}</b>
      <ol class="ativ-passos">
        <li>Cole a plaquinha na mesa e encoste o celular nela (ou leia o QR).</li>
        <li>Na tela <b>Plaquinha nova</b>, digite este código. Só na primeira: o celular lembra para as próximas.</li>
        <li>Entre com o PIN da equipe e escolha o número da mesa.</li>
      </ol>
      <button type="button" class="btn btn-cobalt btn-block" data-copiar-atv="${r.id}">${icon('copy')} Copiar código</button>
    </div>`;
    openSheet('sh');
  }
  const fmtData = (iso) => (iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '');

  /* ============================== Dados ============================== */
  function localApi() {
    const KEY = 'central-demo-v1';
    const read = () => {
      try { return { restaurantes: [], etiquetas: [], ...(JSON.parse(localStorage.getItem(KEY)) || {}) }; } catch { return { restaurantes: [], etiquetas: [] }; }
    };
    const write = (db) => localStorage.setItem(KEY, JSON.stringify(db));
    const ALFA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    const novoCodigo = () => {
      const b = crypto.getRandomValues(new Uint8Array(7));
      return [...b].map((x) => ALFA[x % ALFA.length]).join('');
    };
    const id = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
    return {
      async init() {},
      async sessao() { return { email: 'demonstração' }; },
      async entrar() {},
      async sair() {},
      async listRestaurantes() { return read().restaurantes; },
      async salvarRestaurante(r) {
        const db = read();
        let salvo;
        if (r.id) db.restaurantes = db.restaurantes.map((x) => (x.id === r.id ? (salvo = { ...x, ...r }) : x));
        else db.restaurantes.push((salvo = { ...r, id: id(), codigo_ativacao: novoCodigo() + novoCodigo()[0], criado_em: new Date().toISOString() }));
        write(db);
        return salvo;
      },
      async trocarCodigo(rid) {
        const db = read();
        const c = novoCodigo() + novoCodigo()[0];
        db.restaurantes.forEach((x) => x.id === rid && (x.codigo_ativacao = c));
        write(db);
        return c;
      },
      async listEtiquetas() { return read().etiquetas; },
      async gerar(qtd, lote) {
        const db = read();
        const existentes = new Set(db.etiquetas.map((e) => e.codigo));
        const novos = [];
        while (novos.length < qtd) {
          const c = novoCodigo();
          if (existentes.has(c)) continue;
          existentes.add(c);
          novos.push(c);
          db.etiquetas.push({ codigo: c, lote, restaurante_id: null, gravada: false, criado_em: new Date().toISOString(), vendida_em: null, leituras: 0 });
        }
        write(db);
        return novos;
      },
      async atribuir(codigos, rid) {
        const db = read();
        const set = new Set(codigos);
        db.etiquetas.forEach((e) => {
          if (set.has(e.codigo)) Object.assign(e, { restaurante_id: rid, vendida_em: rid ? new Date().toISOString() : null });
        });
        write(db);
      },
      async marcarGravadas(codigos, g) {
        const db = read();
        const set = new Set(codigos);
        db.etiquetas.forEach((e) => set.has(e.codigo) && (e.gravada = g));
        write(db);
      },
      // Mesmo formato de public.metricas() do schema.sql.
      async metricas(dias) {
        const db = read();
        const leituras = db.leituras || [];
        const iso = (d) => d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
        const hoje = new Date();
        const diaMenos = (k) => iso(new Date(hoje.getTime() - k * 864e5));
        const ini = diaMenos(dias - 1);
        const ant = diaMenos(2 * dias - 1);
        const noPer = (l) => l.dia >= ini;
        const noAnt = (l) => l.dia >= ant && l.dia < ini;
        const soma = (arr) => arr.reduce((t, l) => t + l.n, 0);
        const por_dia = [];
        for (let k = dias - 1; k >= 0; k--) {
          const d = diaMenos(k);
          por_dia.push({ dia: d, n: soma(leituras.filter((l) => l.dia === d)) });
        }
        const por_restaurante = db.restaurantes.map((r) => {
          const doR = leituras.filter((l) => l.restaurante_id === r.id);
          const tags = db.etiquetas.filter((e) => e.restaurante_id === r.id);
          const ult = tags.map((e) => e.ultima_leitura).filter(Boolean).sort().pop() || null;
          return {
            id: r.id, nome: r.nome, ativo: r.ativo !== false,
            n: soma(doR.filter(noPer)), anterior: soma(doR.filter(noAnt)),
            etiquetas: tags.length, lidas: new Set(doR.filter(noPer).map((l) => l.codigo)).size,
            nunca_lidas: tags.filter((e) => !e.leituras).length, ultima: ult,
          };
        }).sort((a, b) => b.n - a.n || a.nome.localeCompare(b.nome));
        return { hoje: iso(hoje), por_dia, por_restaurante, total: soma(leituras.filter(noPer)), total_anterior: soma(leituras.filter(noAnt)) };
      },
    };
  }

  function supabaseApi() {
    let sb;
    const must = ({ data, error }) => {
      if (error) throw error;
      return data;
    };
    return {
      async init() {
        sb = window.supabase.createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
      },
      async sessao() {
        const { data } = await sb.auth.getUser();
        if (!data.user) return null;
        const ok = must(await sb.rpc('eh_operador'));
        if (!ok) {
          await sb.auth.signOut();
          throw new Error('Este usuário não é operador da central.');
        }
        return { email: data.user.email };
      },
      async entrar(email, senha) {
        must(await sb.auth.signInWithPassword({ email, password: senha }));
      },
      async sair() { await sb.auth.signOut(); },
      async listRestaurantes() {
        return must(await sb.from('restaurantes').select('*').order('nome'));
      },
      async salvarRestaurante(r) {
        const { id, ...dados } = r;
        if (id) return must(await sb.from('restaurantes').update(dados).eq('id', id).select().single());
        return must(await sb.from('restaurantes').insert(dados).select().single());
      },
      async trocarCodigo(rid) {
        return must(await sb.rpc('trocar_codigo_ativacao', { p_restaurante: rid }));
      },
      async listEtiquetas() {
        const todas = [];
        for (let de = 0; ; de += 1000) {
          const parte = must(await sb.from('etiquetas').select('*').order('criado_em', { ascending: false }).order('codigo').range(de, de + 999));
          todas.push(...parte);
          if (parte.length < 1000) return todas;
        }
      },
      async gerar(qtd, lote) {
        return must(await sb.rpc('gerar_etiquetas', { p_qtd: qtd, p_lote: lote }));
      },
      async atribuir(codigos, rid) {
        for (let i = 0; i < codigos.length; i += 500) {
          must(await sb.rpc('atribuir_etiquetas', { p_codigos: codigos.slice(i, i + 500), p_restaurante: rid }));
        }
      },
      async marcarGravadas(codigos, g) {
        for (let i = 0; i < codigos.length; i += 500) {
          must(await sb.rpc('marcar_gravadas', { p_codigos: codigos.slice(i, i + 500), p_gravada: g }));
        }
      },
      async metricas(dias) {
        return must(await sb.rpc('metricas', { p_dias: dias }));
      },
    };
  }

  async function carregar() {
    try {
      const [rests, tags, met] = await Promise.all([api.listRestaurantes(), api.listEtiquetas(), api.metricas(S.dias)]);
      S.rests = rests || [];
      S.tags = tags || [];
      S.met = met;
      const existe = new Set(S.tags.map((t) => t.codigo));
      S.sel.forEach((c) => !existe.has(c) && S.sel.delete(c));
    } catch (e) {
      console.error(e);
      toast('Não foi possível carregar os dados. Confira a conexão.', { tone: 'error', ms: 4500 });
    }
    render();
  }

  /* ============================== Entrada ============================== */
  function showLogin(msg = '') {
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#loginErr').textContent = msg;
    setTimeout(() => $('#lgEmail').focus(), 50);
  }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await api.entrar($('#lgEmail').value.trim(), $('#lgSenha').value);
      S.user = await api.sessao();
      start();
    } catch (ex) {
      $('#loginErr').textContent = /invalid/i.test(ex.message || '') ? 'E-mail ou senha incorretos.' : ex.message || 'Não foi possível entrar.';
    }
    btn.disabled = false;
  });

  function start() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#who').innerHTML = `<span>${esc(S.user.email)}</span>${online ? `<button type="button" class="btn btn-quiet btn-sm" data-sair>${icon('logout')} Sair</button>` : ''}`;
    $('#demoBar').hidden = online;
    carregar();
  }

  /* ============================== Telas ============================== */
  function filtradas() {
    const q = S.busca.trim().toUpperCase();
    return S.tags.filter((t) => {
      if (S.filtro === 'estoque' && t.restaurante_id) return false;
      if (S.filtro === 'vendidas' && !t.restaurante_id) return false;
      if (S.lote && t.lote !== S.lote) return false;
      if (S.rest && t.restaurante_id !== S.rest) return false;
      if (q && !t.codigo.includes(q) && !(restDe(t.restaurante_id) || {}).nome?.toUpperCase().includes(q)) return false;
      return true;
    });
  }

  function render() {
    $$('[data-view]').forEach((b) => b.setAttribute('aria-selected', b.dataset.view === S.view));
    $('#main').innerHTML = S.view === 'restaurantes' ? vRestaurantes() : S.view === 'visao' ? vVisao() : vPlaquinhas();
  }

  /* ---------- Visão geral: quem está usando as plaquinhas ---------- */
  const num = (n) => Number(n || 0).toLocaleString('pt-BR');
  const variacao = (n, ant) => {
    if (!ant) return n ? '<span class="var var--novo">novo</span>' : '';
    const p = Math.round(((n - ant) / ant) * 100);
    return `<span class="var ${p >= 0 ? 'var--up' : 'var--down'}">${p >= 0 ? '▲' : '▼'} ${Math.abs(p)}%</span>`;
  };
  const diasSem = (iso) => (iso ? Math.floor((Date.now() - new Date(iso)) / 864e5) : null);
  const diaCurto = (d) => { const [, m, dd] = d.split('-'); return `${dd}/${m}`; };

  function grafico(por_dia) {
    const W = matchMedia('(max-width: 600px)').matches ? 360 : 720, H = 200, L = 36, B = 22, T = 8;
    const max = Math.max(4, ...por_dia.map((d) => d.n));
    const passo = Math.pow(10, Math.floor(Math.log10(max)));
    const topo = Math.ceil(max / passo) * passo;
    const n = por_dia.length;
    const slot = (W - L) / n;
    const larg = Math.max(1, slot - 2);
    const y = (v) => T + (H - B - T) * (1 - v / topo);
    const grade = [0, topo / 2, topo].map((v) => `<g class="gx"><line x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}">${num(v)}</text></g>`).join('');
    const cada = Math.ceil(n / (W < 500 ? 4 : 8));
    const barras = por_dia.map((d, i) => {
      const x = L + i * slot + 1;
      const h = y(0) - y(d.n);
      const r = Math.min(4, larg / 2, h);
      const barra = d.n ? `<path class="bar" d="M${x},${y(0)} V${y(d.n) + r} Q${x},${y(d.n)} ${x + r},${y(d.n)} H${x + larg - r} Q${x + larg},${y(d.n)} ${x + larg},${y(d.n) + r} V${y(0)} Z"/>` : '';
      const rotulo = (n - 1 - i) % cada === 0 ? `<text class="dx" x="${x + larg / 2}" y="${H - 6}">${diaCurto(d.dia)}</text>` : '';
      return `<g class="col" data-tip="${diaCurto(d.dia)} · ${num(d.n)} ${d.n === 1 ? 'leitura' : 'leituras'}">${barra}${rotulo}<rect class="hit" x="${x - 1}" y="${T}" width="${slot}" height="${H - B - T}"/></g>`;
    }).join('');
    return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Leituras por dia">${grade}<line class="base" x1="${L}" x2="${W}" y1="${y(0)}" y2="${y(0)}"/>${barras}</svg><div class="tip" hidden></div></div>`;
  }

  function vVisao() {
    const m = S.met;
    if (!m) return '<p class="muted">Carregando…</p>';
    const rs = m.por_restaurante;
    const ativos = rs.filter((r) => r.n > 0).length;
    const entregues = S.tags.filter((t) => t.restaurante_id);
    const nunca = entregues.filter((t) => !t.leituras).length;
    const media = m.total / m.por_dia.length;
    const parados = rs.filter((r) => r.ativo && r.etiquetas && (diasSem(r.ultima) === null || diasSem(r.ultima) >= 7));
    return `<div class="vhead"><div><h1>Visão geral</h1><p>Leituras são os toques no NFC e as leituras do QR que passam pela central. Chamados, cardápio e comentários ficam no sistema de cada restaurante.</p></div>
        <div class="seg" role="radiogroup" aria-label="Período">${[7, 30, 90].map((d) => `<button type="button" role="radio" aria-checked="${S.dias === d}" data-dias="${d}">${d} dias</button>`).join('')}</div></div>
      <dl class="strip">
        <div><dt>Leituras em ${S.dias} dias</dt><dd>${num(m.total)} ${variacao(m.total, m.total_anterior)}</dd></div>
        <div><dt>Média por dia</dt><dd>${media < 10 ? media.toFixed(1).replace('.', ',') : num(Math.round(media))}</dd></div>
        <div><dt>Restaurantes com leitura</dt><dd>${ativos}<small>/${rs.length}</small></dd></div>
        <div><dt>Ativadas nunca lidas</dt><dd>${nunca}<small>/${entregues.length}</small></dd></div>
      </dl>
      <section class="card-sec"><h2>Leituras por dia</h2>${grafico(m.por_dia)}
        <details class="tabela-alt"><summary>Ver em tabela</summary><table><thead><tr><th>Dia</th><th class="num">Leituras</th></tr></thead>
          <tbody>${m.por_dia.slice().reverse().map((d) => `<tr><td>${diaCurto(d.dia)}</td><td class="num">${num(d.n)}</td></tr>`).join('')}</tbody></table></details>
      </section>
      ${parados.length ? `<p class="note">${icon('msg')}<span><b>Atenção:</b> ${parados.map((r) => esc(r.nome)).join(', ')} ${parados.length === 1 ? 'está' : 'estão'} sem nenhuma leitura há 7 dias ou mais. Plaquinhas não instaladas, retiradas ou site fora do ar?</span></p>` : ''}
      <section class="card-sec"><h2>Restaurantes — mais acessados no período</h2>
        ${rs.length ? `<div class="tabela"><table>
          <thead><tr><th>#</th><th>Restaurante</th><th class="num">Leituras</th><th class="num">vs. período anterior</th><th class="num">Plaquinhas lidas</th><th class="num">Nunca lidas</th><th>Última leitura</th></tr></thead>
          <tbody>${rs.map((r, i) => {
            const ds = diasSem(r.ultima);
            return `<tr>
              <td class="muted">${i + 1}</td>
              <td><button type="button" class="link" data-ver-rest="${r.id}">${esc(r.nome)}</button>${r.ativo ? '' : ' <span class="pill">desativado</span>'}</td>
              <td class="num"><b>${num(r.n)}</b></td>
              <td class="num">${variacao(r.n, r.anterior) || '<span class="muted">—</span>'}</td>
              <td class="num">${r.lidas}/${r.etiquetas}</td>
              <td class="num">${r.nunca_lidas ? `<span class="warn">${r.nunca_lidas}</span>` : '0'}</td>
              <td>${r.ultima ? `${ago(r.ultima)}${ds >= 7 ? ' <span class="pill pill--warn">parado</span>' : ''}` : '<span class="muted">nunca</span>'}</td>
            </tr>`;
          }).join('')}</tbody></table></div>`
          : `<div class="vazio">${icon('grid')}<h2>Nenhum restaurante</h2><p>Cadastre em Restaurantes.</p></div>`}
      </section>`;
  }

  function vPlaquinhas() {
    const total = S.tags.length;
    const vendidas = S.tags.filter((t) => t.restaurante_id).length;
    const gravadas = S.tags.filter((t) => t.gravada).length;
    const lotes = [...new Set(S.tags.map((t) => t.lote).filter(Boolean))].sort();
    const lista = filtradas();
    const selVis = lista.filter((t) => S.sel.has(t.codigo)).length;
    const n = S.sel.size;
    const linhas = lista.slice(0, 600).map((t) => {
      const r = restDe(t.restaurante_id);
      return `<tr class="${S.sel.has(t.codigo) ? 'is-sel' : ''}">
        <td><input type="checkbox" data-sel="${t.codigo}" ${S.sel.has(t.codigo) ? 'checked' : ''} aria-label="Selecionar ${t.codigo}"></td>
        <td><button type="button" class="cod" data-ver="${t.codigo}">${t.codigo}</button></td>
        <td>${esc(t.lote || '—')}</td>
        <td>${r ? `<span class="pill pill--ok">${esc(r.nome)}</span>` : '<span class="pill">Em estoque</span>'}</td>
        <td>${t.gravada ? `<span class="pill pill--ok">${icon('check')} Gravada</span>` : '<span class="muted">—</span>'}</td>
        <td class="num">${t.leituras || 0}${t.ultima_leitura ? `<small>${ago(t.ultima_leitura)}</small>` : ''}</td>
        <td class="muted">${fmtData(t.criado_em)}</td>
      </tr>`;
    }).join('');
    return `<div class="vhead"><div><h1>Plaquinhas</h1><p>Cada plaquinha tem um código único, igual no NFC e no QR. Ela sai sem dono: a equipe do restaurante ativa com o código de ativação na primeira leitura.</p></div>
        <span class="acts"><button type="button" class="btn btn-line" data-abrir="gravar">${icon('nfc')} Gravar NFC</button>
        <button type="button" class="btn btn-cobalt" data-abrir="gerar">${icon('plus')} Gerar lote</button></span></div>
      <dl class="strip">
        <div><dt>Total</dt><dd>${total}</dd></div>
        <div><dt>Em estoque</dt><dd>${total - vendidas}</dd></div>
        <div><dt>Ativadas</dt><dd>${vendidas}</dd></div>
        <div><dt>NFC gravadas</dt><dd>${gravadas}</dd></div>
      </dl>
      <div class="filtros">
        <div class="seg" role="radiogroup" aria-label="Situação">
          ${[['todas', 'Todas'], ['estoque', 'Em estoque'], ['vendidas', 'Ativadas']].map(([v, l]) => `<button type="button" role="radio" aria-checked="${S.filtro === v}" data-filtro="${v}">${l}</button>`).join('')}
        </div>
        <select class="input" id="fLote" aria-label="Lote"><option value="">Todos os lotes</option>${lotes.map((l) => `<option ${S.lote === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <select class="input" id="fRest" aria-label="Restaurante"><option value="">Todos os restaurantes</option>${S.rests.map((r) => `<option value="${r.id}" ${S.rest === r.id ? 'selected' : ''}>${esc(r.nome)}</option>`).join('')}</select>
        <input class="input" id="fBusca" type="search" placeholder="Buscar código" value="${esc(S.busca)}" autocomplete="off">
      </div>
      <div class="selbar ${n ? 'is-on' : ''}">
        <label class="selall"><input type="checkbox" id="selAll" ${lista.length && selVis === lista.length ? 'checked' : ''} ${lista.length ? '' : 'disabled'}> ${n ? `<b>${n}</b> ${n === 1 ? 'selecionada' : 'selecionadas'}` : `Selecionar as ${lista.length} da lista`}</label>
        <span class="selpick">ou as próximas <input class="input mono" id="pickN" type="number" min="1" max="2000" placeholder="10" aria-label="Quantidade"> <button type="button" class="btn btn-line btn-sm" data-pick>em estoque</button></span>
        ${n ? `<div class="selacts">
          <button type="button" class="btn btn-cobalt btn-sm" data-abrir="vender">${icon('arrow')} Atribuir a um restaurante</button>
          <button type="button" class="btn btn-line btn-sm" data-acao="estoque">Devolver ao estoque</button>
          <button type="button" class="btn btn-line btn-sm" data-acao="pdf">${icon('download')} PDF das plaquinhas</button>
          <button type="button" class="btn btn-line btn-sm" data-acao="imprimir">${icon('printer')} Imprimir QR</button>
          <button type="button" class="btn btn-line btn-sm" data-acao="etiquetas">${icon('printer')} Etiquetas de código</button>
          <button type="button" class="btn btn-line btn-sm" data-acao="csv">${icon('download')} Exportar CSV</button>
          <button type="button" class="btn btn-line btn-sm" data-abrir="gravar">${icon('nfc')} Gravar NFC</button>
          <button type="button" class="btn btn-quiet btn-sm" data-acao="limpar">Limpar seleção</button>
        </div>` : ''}
      </div>
      ${lista.length ? `<div class="tabela"><table>
        <thead><tr><th></th><th>Código</th><th>Lote</th><th>Restaurante</th><th>NFC</th><th class="num">Leituras</th><th>Criada</th></tr></thead>
        <tbody>${linhas}</tbody></table>
        ${lista.length > 600 ? `<p class="muted mais">Mostrando 600 de ${lista.length}. Use os filtros para ver as outras.</p>` : ''}</div>`
        : `<div class="vazio">${icon('nfc')}<h2>${total ? 'Nada neste filtro' : 'Nenhuma plaquinha ainda'}</h2><p>${total ? 'Mude os filtros acima.' : 'Toque em “Gerar lote” para criar os primeiros códigos.'}</p></div>`}`;
  }

  function vRestaurantes() {
    const cont = (id) => S.tags.filter((t) => t.restaurante_id === id).length;
    return `<div class="vhead"><div><h1>Restaurantes</h1><p>Cada restaurante tem um <b>código de ativação</b>: a equipe dele digita na primeira leitura de uma plaquinha nova, e ela passa a ser do restaurante. Mudou o domínio? Troque o endereço aqui e todas as plaquinhas continuam funcionando.</p></div>
        <button type="button" class="btn btn-cobalt" data-abrir="rest">${icon('plus')} Novo restaurante</button></div>
      ${S.rests.length ? `<div class="rests">${S.rests.map((r) => `<article class="rcard ${r.ativo === false ? 'is-off' : ''}">
          <div><h3>${esc(r.nome)}</h3><a href="${esc(r.destino)}" target="_blank" rel="noopener" class="mono">${esc(r.destino.replace(/^https?:\/\//, ''))}</a>
            ${r.observacao ? `<p>${esc(r.observacao)}</p>` : ''}</div>
          <div class="ativ"><small>Código de ativação</small><b class="mono">${fmtAtivacao(r.codigo_ativacao)}</b>
            <span class="rcard-acts"><button type="button" class="btn btn-quiet btn-sm" data-copiar-atv="${r.id}">${icon('copy')} Copiar</button>
            <button type="button" class="btn btn-quiet btn-sm" data-trocar-atv="${r.id}">Trocar</button></span></div>
          <div class="rcard-foot"><span>${cont(r.id)} ${cont(r.id) === 1 ? 'plaquinha' : 'plaquinhas'}${r.ativo === false ? ' · <b>desativado</b>' : ''}</span>
            <span class="rcard-acts"><button type="button" class="btn btn-quiet btn-sm" data-ver-rest="${r.id}">Ver plaquinhas</button>
            <button type="button" class="btn btn-line btn-sm" data-editar="${r.id}">${icon('edit')} Editar</button></span></div>
        </article>`).join('')}</div>`
        : `<div class="vazio">${icon('grid')}<h2>Nenhum restaurante</h2><p>Cadastre o restaurante com o endereço do site dele (ex.: https://quintal.vtx.com.br). Ele recebe um código de ativação para a equipe ligar as plaquinhas.</p></div>`}`;
  }

  /* ============================== Folhas ============================== */
  function abrirGerar() {
    const hoje = new Date().toLocaleDateString('pt-BR', { month: '2-digit', year: 'numeric' }).replace('/', '-');
    $('#shTitle').textContent = 'Gerar lote';
    $('#shBody').innerHTML = `<form class="stack" id="fGerar" novalidate>
      <label class="field"><span>Quantidade</span><input class="input mono" id="gQtd" type="number" min="1" max="2000" value="50" required></label>
      <label class="field"><span>Nome do lote</span><input class="input" id="gLote" maxlength="40" value="Lote ${hoje}"><small class="help">Ajuda a achar as plaquinhas depois (ex.: pedido da gráfica).</small></label>
      <p class="help">Ao gerar, baixa na hora o PDF para a gráfica: uma plaquinha de 12 × 6 cm por página, cada uma com o QR e o código dela.</p>
      <button type="submit" class="btn btn-cobalt btn-block">${icon('plus')} Gerar e baixar PDF</button>
    </form>`;
    openSheet('sh');
  }
  function abrirVender() {
    $('#shTitle').textContent = 'Atribuir a um restaurante';
    const jaVendidas = [...S.sel].filter((c) => (S.tags.find((t) => t.codigo === c) || {}).restaurante_id).length;
    $('#shBody').innerHTML = S.rests.length ? `<form class="stack" id="fVender" novalidate>
      <p>${S.sel.size} ${S.sel.size === 1 ? 'plaquinha' : 'plaquinhas'} passam a abrir o site do restaurante escolhido.</p>
      ${jaVendidas ? `<p class="note">${icon('msg')}<span>${jaVendidas} já ${jaVendidas === 1 ? 'estava entregue' : 'estavam entregues'} a outro restaurante e ${jaVendidas === 1 ? 'será transferida' : 'serão transferidas'}.</span></p>` : ''}
      <label class="field"><span>Restaurante</span><select class="input" id="vRest" required>${S.rests.filter((r) => r.ativo !== false).map((r) => `<option value="${r.id}">${esc(r.nome)} — ${esc(r.destino.replace(/^https?:\/\//, ''))}</option>`).join('')}</select></label>
      <button type="submit" class="btn btn-cobalt btn-block">${icon('check')} Entregar</button>
    </form>` : `<div class="stack"><p>Cadastre o restaurante primeiro.</p><button type="button" class="btn btn-cobalt" data-abrir="rest">${icon('plus')} Novo restaurante</button></div>`;
    openSheet('sh');
  }
  function abrirRest(id) {
    const r = id ? restDe(id) : { nome: '', destino: 'https://', observacao: '', ativo: true };
    S.editRest = id || null;
    $('#shTitle').textContent = id ? 'Editar restaurante' : 'Novo restaurante';
    $('#shBody').innerHTML = `<form class="stack" id="fRestForm" novalidate>
      <label class="field"><span>Nome</span><input class="input" id="rNome" maxlength="80" required value="${esc(r.nome)}"></label>
      <label class="field"><span>Endereço do site</span><input class="input mono" id="rDestino" type="url" required value="${esc(r.destino)}" spellcheck="false" autocapitalize="off">
        <small class="help">O endereço onde o sistema do restaurante está publicado (subdomínio de vocês ou domínio próprio). A plaquinha abre <code>endereço/?tag=CÓDIGO</code>.</small></label>
      <label class="field"><span>Observação (opcional)</span><input class="input" id="rObs" maxlength="300" value="${esc(r.observacao || '')}"></label>
      <label class="check"><input type="checkbox" id="rAtivo" ${r.ativo !== false ? 'checked' : ''}> Ativo (desmarcado: as plaquinhas mostram “desativada”)</label>
      <p class="form-error" id="rErr" role="alert"></p>
      <button type="submit" class="btn btn-cobalt btn-block">${icon('check')} Salvar</button>
    </form>`;
    openSheet('sh');
  }
  function verTag(codigo) {
    const t = S.tags.find((x) => x.codigo === codigo);
    if (!t) return;
    const r = restDe(t.restaurante_id);
    $('#shTitle').textContent = `Plaquinha ${codigo}`;
    $('#shBody').innerHTML = `<div class="stack tagver">
      <div class="qr">${qrSvg(tagUrl(codigo), { cell: 6, margin: 1 })}</div>
      <code>${esc(tagUrl(codigo))}</code>
      <p>${r ? `Entregue a <b>${esc(r.nome)}</b> em ${fmtData(t.vendida_em)}` : 'Em estoque'} · ${t.leituras || 0} leituras${t.ultima_leitura ? ` (última ${ago(t.ultima_leitura)})` : ''}</p>
      <div class="acts">
        <button type="button" class="btn btn-line btn-sm" data-pdf1="${codigo}">${icon('download')} PDF</button>
        <button type="button" class="btn btn-line btn-sm" data-copiar="${codigo}">${icon('copy')} Copiar link</button>
        <a class="btn btn-line btn-sm" href="${esc(tagUrl(codigo))}" target="_blank" rel="noopener">${icon('external')} Testar</a>
      </div>
    </div>`;
    openSheet('sh');
  }

  /* ============================== Ações ============================== */
  const selecionadas = () => S.tags.filter((t) => S.sel.has(t.codigo));

  function imprimir(lista) {
    $('#printArea').innerHTML = lista.map((t) => `<div class="etq">
        <div class="qr">${qrSvg(tagUrl(t.codigo), { cell: 4, margin: 0 })}</div>
        <code>${t.codigo}</code>
      </div>`).join('');
    setTimeout(() => window.print(), 60);
  }

  // Adesivos pequenos só com o código, para o verso da plaquinha.
  function imprimirCodigos(lista) {
    $('#printArea').innerHTML = `<div class="etq-cods">${lista.map((t) => `<div class="etq-cod"><code>${t.codigo}</code></div>`).join('')}</div>`;
    setTimeout(() => window.print(), 60);
  }

  function exportarCsv(lista) {
    const cel = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const linhas = [['codigo', 'url', 'lote', 'restaurante', 'gravada'].join(';')]
      .concat(lista.map((t) => [t.codigo, tagUrl(t.codigo), t.lote, (restDe(t.restaurante_id) || {}).nome || '', t.gravada ? 'sim' : 'não'].map(cel).join(';')));
    const blob = new Blob(['﻿' + linhas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `plaquinhas-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* Gravação NFC (Chrome no Android). Dois modos:
     - câmera: lê o QR impresso na plaquinha e grava o MESMO código no NFC dela
       (não tem como trocar plaquinha, é o recomendado);
     - lista: segue os códigos selecionados, um por vez, mostrando qual gravar.
     Opcionalmente bloqueia cada etiqueta. Não regrava a mesma etiqueta duas
     vezes seguidas: compara o número de série. */
  const G = { modo: 'camera', fila: [], i: 0, lido: null, feitos: 0, reader: null, ctrl: null, ultimaSerie: null, ultimoLink: null, ocupado: false, bloquear: true, stream: null, detector: null, camT: 0 };
  const temCamera = () => 'BarcodeDetector' in window && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const atual = () => (G.modo === 'camera' ? G.lido : G.fila[G.i]);
  const codigoDoLink = (v) => {
    const m = String(v || '').match(/\/t\/([A-Za-z0-9]{4,16})\b|[?&]c=([A-Za-z0-9]{4,16})\b/);
    return m ? (m[1] || m[2]).toUpperCase() : null;
  };

  function abrirGravar() {
    $('#shTitle').textContent = 'Gravar NFC';
    if (!('NDEFReader' in window)) {
      $('#shBody').innerHTML = `<div class="stack">
        <p>Este navegador não grava NFC. Abra a central no <b>Chrome do Android</b>, com o NFC do celular ligado.</p>
        <p class="muted">Outra opção: exporte o CSV e peça para a gráfica gravar o NFC junto com a impressão do QR.</p>
      </div>`;
      return openSheet('sh');
    }
    G.fila = selecionadas().sort((a, b) => a.codigo.localeCompare(b.codigo));
    G.i = Math.max(0, G.fila.findIndex((t) => !t.gravada));
    G.modo = temCamera() ? 'camera' : 'lista';
    $('#shBody').innerHTML = `<div class="stack">
      <div class="modo" role="radiogroup" aria-label="Como gravar">
        ${temCamera() ? `<label><input type="radio" name="gModo" value="camera" checked><span><b>Ler o QR da plaquinha</b><small>Aponte a câmera para o QR já impresso e encoste a mesma plaquinha: o NFC recebe exatamente o código do QR. Recomendado.</small></span></label>` : ''}
        <label><input type="radio" name="gModo" value="lista" ${temCamera() ? '' : 'checked'} ${G.fila.length ? '' : 'disabled'}><span><b>Seguir a lista selecionada</b><small>${G.fila.length ? `${G.fila.length} ${G.fila.length === 1 ? 'código' : 'códigos'} em ordem; a tela mostra qual plaquinha encostar.` : 'Selecione plaquinhas na lista para usar este modo.'}</small></span></label>
      </div>
      <label class="check"><input type="checkbox" id="gBloq" checked> Bloquear cada etiqueta depois de gravar (definitivo: ninguém consegue regravar)</label>
      <button type="button" class="btn btn-cobalt btn-block" data-gravar="iniciar" ${temCamera() || G.fila.length ? '' : 'disabled'}>${icon('nfc')} Começar</button>
    </div>`;
    openSheet('sh');
  }

  function telaGravar(msg = '', tom = '') {
    const t = atual();
    if (G.modo === 'lista' && !t) {
      pararGravar();
      $('#shBody').innerHTML = `<div class="stack gravar-fim">${icon('check')}<h3>Fila concluída</h3><p>${G.fila.length} ${G.fila.length === 1 ? 'plaquinha processada' : 'plaquinhas processadas'}.</p>
        <button type="button" class="btn btn-quiet btn-block" data-close>Fechar</button></div>`;
      return;
    }
    const prog = G.modo === 'lista' ? `${G.i + 1} de ${G.fila.length}` : `${G.feitos} ${G.feitos === 1 ? 'gravada' : 'gravadas'} nesta sessão`;
    const topo = t
      ? `<div class="gravar-cod"><small>Encoste a plaquinha</small><b class="mono">${t.codigo}</b></div>`
      : `<video class="gravar-cam" id="gCam" playsinline muted></video>`;
    const padrao = t ? (G.ocupado ? 'Gravando… mantenha encostada.' : 'Aguardando a etiqueta NFC…') : 'Aponte a câmera para o QR da plaquinha.';
    $('#shBody').innerHTML = `<div class="stack gravar">
      <p class="gravar-prog">${prog}</p>
      ${topo}
      <p class="gravar-msg ${tom}" aria-live="polite">${esc(msg || padrao)}</p>
      <div class="acts">
        ${t ? `<button type="button" class="btn btn-line btn-sm" data-gravar="pular">${G.modo === 'camera' ? 'Ler outro QR' : 'Pular'}</button>` : ''}
        <button type="button" class="btn btn-quiet btn-sm" data-gravar="parar">Parar</button>
      </div>
    </div>`;
    if (G.modo === 'camera' && !t) ligarCamera();
  }

  async function ligarCamera() {
    const video = $('#gCam');
    if (!video) return;
    try {
      G.stream = G.stream || (await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }));
      G.detector = G.detector || new BarcodeDetector({ formats: ['qr_code'] });
      video.srcObject = G.stream;
      await video.play();
    } catch (e) {
      $('.gravar-msg').textContent = e.name === 'NotAllowedError' ? 'Permita o uso da câmera para ler o QR.' : `Câmera indisponível: ${e.message}`;
      $('.gravar-msg').className = 'gravar-msg is-erro';
      return;
    }
    clearTimeout(G.camT);
    const loop = async () => {
      if (!G.stream || G.lido || !document.contains(video)) return;
      try {
        for (const b of await G.detector.detect(video)) {
          const c = codigoDoLink(b.rawValue);
          if (!c) continue;
          const tag = S.tags.find((x) => x.codigo === c);
          if (!tag) {
            $('.gravar-msg').textContent = `O QR ${c} não é de uma plaquinha cadastrada.`;
            $('.gravar-msg').className = 'gravar-msg is-erro';
            continue;
          }
          G.lido = tag;
          navigator.vibrate && navigator.vibrate(30);
          desligarCamera();
          return telaGravar(tag.gravada ? 'Esta plaquinha já consta como gravada. Encoste para conferir ou regravar.' : '');
        }
      } catch {}
      G.camT = setTimeout(loop, 250);
    };
    loop();
  }
  function desligarCamera() {
    clearTimeout(G.camT);
    G.stream && G.stream.getTracks().forEach((tr) => tr.stop());
    G.stream = null;
  }

  async function iniciarGravar() {
    const modo = ($('input[name="gModo"]:checked') || {}).value || 'lista';
    G.modo = modo;
    G.bloquear = $('#gBloq').checked;
    G.lido = null;
    G.feitos = 0;
    G.ultimaSerie = null;
    G.ultimoLink = null;
    G.ctrl = new AbortController();
    G.reader = new NDEFReader();
    try {
      await G.reader.scan({ signal: G.ctrl.signal });
    } catch (e) {
      return telaGravar(e.name === 'NotAllowedError' ? 'Permita o uso de NFC para este site.' : `NFC indisponível: ${e.message}`, 'is-erro');
    }
    G.reader.onreadingerror = () => atual() && telaGravar('Não deu para ler. Afaste e encoste de novo.', 'is-erro');
    G.reader.onreading = (ev) => gravarEtiqueta(ev);
    telaGravar();
  }

  async function gravarEtiqueta(ev) {
    const t = atual();
    if (!t || G.ocupado) return;
    const serie = ev.serialNumber || '';
    const link = (ev.message.records || []).map((r) => {
      try { return r.recordType === 'url' ? new TextDecoder().decode(r.data) : ''; } catch { return ''; }
    }).find(Boolean) || '';
    // A mesma etiqueta ainda encostada depois de gravar: ignora.
    if ((serie && serie === G.ultimaSerie) || (!serie && link && link === G.ultimoLink)) return;
    const meu = tagUrl(t.codigo);
    const outro = codigoDoLink(link);
    if (outro && outro !== t.codigo) return telaGravar(`Esta etiqueta já tem outro código (${outro}). Confira se é a plaquinha certa.`, 'is-erro');
    G.ocupado = true;
    telaGravar();
    try {
      if (link !== meu) await G.reader.write({ records: [{ recordType: 'url', data: meu }] });
      if (G.bloquear) await G.reader.makeReadOnly();
      await api.marcarGravadas([t.codigo], true);
      t.gravada = true;
      G.ultimaSerie = serie;
      G.ultimoLink = meu;
      G.feitos++;
      navigator.vibrate && navigator.vibrate(60);
      if (G.modo === 'camera') G.lido = null;
      else G.i++;
      G.ocupado = false;
      telaGravar(`${t.codigo} gravada${G.bloquear ? ' e bloqueada' : ''}. ${G.modo === 'camera' ? 'Leia o QR da próxima.' : 'Afaste e encoste a próxima.'}`, 'is-ok');
    } catch (e) {
      G.ocupado = false;
      telaGravar(`Falhou: ${e.message}. Afaste e encoste de novo.`, 'is-erro');
    }
  }

  function pararGravar() {
    desligarCamera();
    G.ctrl && G.ctrl.abort();
    G.ctrl = null;
    G.reader = null;
    G.ocupado = false;
    G.lido = null;
    render();
  }

  /* ============================== Eventos ============================== */
  document.addEventListener('click', async (e) => {
    const t = e.target;
    const v = t.closest('[data-view]');
    if (v) { S.view = v.dataset.view; return render(); }
    if (t.closest('[data-sair]')) { await api.sair(); return location.reload(); }
    const ab = t.closest('[data-abrir]');
    if (ab) {
      const k = ab.dataset.abrir;
      if (k === 'gerar') return abrirGerar();
      if (k === 'vender') return abrirVender();
      if (k === 'rest') return abrirRest(null);
      if (k === 'gravar') return abrirGravar();
    }
    const f = t.closest('[data-filtro]');
    if (f) { S.filtro = f.dataset.filtro; return render(); }
    const dd = t.closest('[data-dias]');
    if (dd) { S.dias = +dd.dataset.dias; return carregar(); }
    const ed = t.closest('[data-editar]');
    if (ed) return abrirRest(ed.dataset.editar);
    const vr = t.closest('[data-ver-rest]');
    if (vr) { Object.assign(S, { view: 'plaquinhas', rest: vr.dataset.verRest, filtro: 'todas', lote: '', busca: '' }); return render(); }
    const ver = t.closest('[data-ver]');
    if (ver) return verTag(ver.dataset.ver);
    const ca = t.closest('[data-copiar-atv]');
    if (ca) {
      const r = restDe(ca.dataset.copiarAtv);
      const ok = r && (await copyText(fmtAtivacao(r.codigo_ativacao)));
      return toast(ok ? 'Código de ativação copiado.' : 'Não foi possível copiar.', { tone: ok ? 'ok' : 'error' });
    }
    const ta = t.closest('[data-trocar-atv]');
    if (ta) {
      const r = restDe(ta.dataset.trocarAtv);
      if (!r || !confirm(`Trocar o código de ativação de ${r.nome}? O código antigo para de funcionar. Plaquinhas já ativadas continuam normais.`)) return;
      try {
        r.codigo_ativacao = await api.trocarCodigo(r.id);
        render();
        mostrarAtivacao(r, false);
      } catch (ex) { toast(ex.message, { tone: 'error' }); }
      return;
    }
    const p1 = t.closest('[data-pdf1]');
    if (p1) {
      try { await pdfPlaquinhas([p1.dataset.pdf1], `plaquinha-${p1.dataset.pdf1}`); } catch (ex) { toast(ex.message, { tone: 'error', ms: 4500 }); }
      return;
    }
    const cp = t.closest('[data-copiar]');
    if (cp) {
      const ok = await copyText(tagUrl(cp.dataset.copiar));
      return toast(ok ? 'Link copiado.' : 'Não foi possível copiar.', { tone: ok ? 'ok' : 'error' });
    }
    if (t.closest('[data-pick]')) {
      const n = parseInt($('#pickN').value, 10) || 10;
      const livres = S.tags.filter((x) => !x.restaurante_id && !S.sel.has(x.codigo) && (!S.lote || x.lote === S.lote))
        .sort((a, b) => a.codigo.localeCompare(b.codigo)).slice(0, n);
      livres.forEach((x) => S.sel.add(x.codigo));
      toast(livres.length < n ? `Só havia ${livres.length} em estoque.` : `${livres.length} selecionadas.`);
      return render();
    }
    const ac = t.closest('[data-acao]');
    if (ac) {
      const lista = selecionadas();
      if (ac.dataset.acao === 'limpar') { S.sel.clear(); return render(); }
      if (ac.dataset.acao === 'imprimir') return imprimir(lista);
      if (ac.dataset.acao === 'pdf') {
        const lotes = [...new Set(lista.map((x) => x.lote).filter(Boolean))];
        try {
          await pdfPlaquinhas(lista.map((x) => x.codigo), `plaquinhas-${lotes.length === 1 ? lotes[0] : new Date().toISOString().slice(0, 10)}`);
        } catch (ex) { toast(ex.message, { tone: 'error', ms: 4500 }); }
        return;
      }
      if (ac.dataset.acao === 'etiquetas') return imprimirCodigos(lista);
      if (ac.dataset.acao === 'csv') return exportarCsv(lista);
      if (ac.dataset.acao === 'estoque') {
        if (!confirm(`Devolver ${lista.length} ${lista.length === 1 ? 'plaquinha' : 'plaquinhas'} ao estoque? Elas param de abrir o site do restaurante.`)) return;
        try {
          await api.atribuir(lista.map((x) => x.codigo), null);
          toast('Plaquinhas devolvidas ao estoque.', { tone: 'ok' });
        } catch (ex) { toast(ex.message, { tone: 'error' }); }
        return carregar();
      }
    }
    const g = t.closest('[data-gravar]');
    if (g) {
      if (g.dataset.gravar === 'iniciar') return iniciarGravar();
      if (g.dataset.gravar === 'pular') {
        if (G.modo === 'camera') G.lido = null;
        else G.i++;
        G.ultimaSerie = null;
        return telaGravar();
      }
      if (g.dataset.gravar === 'parar') { pararGravar(); return closeSheet(); }
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-sel]')) {
      t.checked ? S.sel.add(t.dataset.sel) : S.sel.delete(t.dataset.sel);
      return render();
    }
    if (t.id === 'selAll') {
      filtradas().forEach((x) => (t.checked ? S.sel.add(x.codigo) : S.sel.delete(x.codigo)));
      return render();
    }
    if (t.id === 'fLote') { S.lote = t.value; return render(); }
    if (t.id === 'fRest') { S.rest = t.value; return render(); }
  });
  let buscaT;
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'fBusca') return;
    S.busca = e.target.value;
    clearTimeout(buscaT);
    buscaT = setTimeout(() => {
      render();
      const b = $('#fBusca');
      b.focus();
      b.setSelectionRange(b.value.length, b.value.length);
    }, 250);
  });

  document.addEventListener('submit', async (e) => {
    const f = e.target;
    if (!['fGerar', 'fVender', 'fRestForm'].includes(f.id)) return;
    e.preventDefault();
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      if (f.id === 'fGerar') {
        const qtd = Math.min(2000, Math.max(1, parseInt($('#gQtd').value, 10) || 0));
        const lote = $('#gLote').value.trim().slice(0, 40);
        const novos = await api.gerar(qtd, lote);
        closeSheet();
        S.sel = new Set(novos);
        Object.assign(S, { filtro: 'todas', lote, rest: '', busca: '' });
        toast(`${novos.length} códigos gerados e selecionados.`, { tone: 'ok' });
        try {
          await pdfPlaquinhas(novos, `plaquinhas-${lote || new Date().toISOString().slice(0, 10)}`);
        } catch (ex) {
          toast(`Códigos criados, mas o PDF falhou: ${ex.message} Use “PDF das plaquinhas” na seleção.`, { tone: 'error', ms: 6000 });
        }
      } else if (f.id === 'fVender') {
        const rid = $('#vRest').value;
        const lista = [...S.sel];
        await api.atribuir(lista, rid);
        closeSheet();
        toast(`${lista.length} ${lista.length === 1 ? 'plaquinha entregue' : 'plaquinhas entregues'} a ${restDe(rid).nome}.`, { tone: 'ok' });
      } else {
        let destino = $('#rDestino').value.trim().replace(/\/+$/, '') + '/';
        if (!/^https?:\/\//i.test(destino)) destino = 'https://' + destino;
        try { new URL(destino); } catch { throw new Error('Endereço do site inválido.'); }
        const nome = $('#rNome').value.trim();
        if (!nome) throw new Error('Informe o nome.');
        const salvo = await api.salvarRestaurante({ ...(S.editRest ? { id: S.editRest } : {}), nome, destino, observacao: $('#rObs').value.trim() || null, ativo: $('#rAtivo').checked });
        if (!S.editRest && salvo) {
          S.rests.push(salvo);
          mostrarAtivacao(salvo, true);
        } else {
          closeSheet();
          toast('Restaurante salvo.', { tone: 'ok' });
        }
      }
      await carregar();
    } catch (ex) {
      console.error(ex);
      const err = $('#rErr');
      if (err) err.textContent = ex.message;
      else toast(ex.message || 'Não foi possível salvar.', { tone: 'error', ms: 4500 });
      btn.disabled = false;
    }
  });

  $('#sh').addEventListener('sheet:close', () => (G.ctrl || G.stream) && pararGravar());

  /* Dica do gráfico: passa o dedo/mouse sobre o dia. */
  document.addEventListener('pointerover', (e) => {
    const col = e.target.closest && e.target.closest('.col');
    const chart = e.target.closest && e.target.closest('.chart');
    if (!chart) return;
    const tip = $('.tip', chart);
    $$('.col.is-on', chart).forEach((c) => c !== col && c.classList.remove('is-on'));
    if (!col) return (tip.hidden = true);
    col.classList.add('is-on');
    tip.textContent = col.dataset.tip;
    tip.hidden = false;
    const r = col.getBoundingClientRect();
    const cr = chart.getBoundingClientRect();
    tip.style.left = `${Math.min(Math.max(r.left - cr.left + r.width / 2, 60), cr.width - 60)}px`;
  });
  document.addEventListener('pointerleave', (e) => {
    if (e.target.classList && e.target.classList.contains('chart')) {
      $('.tip', e.target).hidden = true;
      $$('.col.is-on', e.target).forEach((c) => c.classList.remove('is-on'));
    }
  }, true);

  /* ============================== Início ============================== */
  $$('.sheet [data-close].icon-btn').forEach((b) => (b.innerHTML = icon('x')));
  api.init()
    .then(() => api.sessao())
    .then((u) => {
      if (!u) return showLogin();
      S.user = u;
      start();
    })
    .catch((e) => {
      console.error(e);
      showLogin(e.message || 'Não foi possível conectar.');
    });
})();
