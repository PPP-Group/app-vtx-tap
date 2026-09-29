/*
 * Central de plaquinhas — uso interno (vocês).
 * Gera lotes de códigos únicos, entrega plaquinhas a um restaurante (endereço
 * do site dele), imprime os QR, exporta a lista e grava as etiquetas NFC.
 * Toda plaquinha aponta para ESTE site (/t/CODIGO); o redirecionador manda
 * para o site do restaurante (?tag=CODIGO), onde a equipe escolhe a mesa.
 */
(function () {
  const { $, $$, esc, icon, toast, qrSvg, ago, openSheet, closeSheet, copyText } = UI;
  const env = window.CENTRAL_ENV || window.NFC_ENV || {};
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
  // Link gravado nas plaquinhas: sempre o endereço fixo da central (CENTRAL_HOST),
  // mesmo que a central esteja aberta por outro endereço. Sem ele (teste local):
  // o redirecionador deste mesmo servidor.
  const BASE = String(env.BASE_DOMAIN || '').toLowerCase();
  const tagUrl = (c) => (env.CENTRAL_HOST
    ? `https://${env.CENTRAL_HOST}/t/${c}`
    : new URL(`/central/t.html?c=${c}`, location.origin).href);
  // Endereço do restaurante: subdomínio do domínio base (ou ?r= no teste local).
  const siteDe = (r) => (BASE ? `https://${r.slug}.${BASE}/` : new URL(`/?r=${r.slug}`, location.origin).href);
  const siteCurto = (r) => siteDe(r).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const slugOk = (v) => /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(v) && !['tap', 'www', 'admin', 'api', 'app', 'central', 'mail', 'ftp', 'painel'].includes(v);
  const paraSlug = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const restDe = (id) => S.rests.find((r) => r.id === id);
  const nomeArq = (t) => String(t || 'plaquinhas').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'plaquinhas';
  // PDF para a gráfica: uma plaquinha de 12 × 6 cm por página (central/placa.js).
  async function pdfPlaquinhas(codigos, titulo) {
    const lista = [...codigos].sort();
    toast(`Gerando PDF com ${lista.length} ${lista.length === 1 ? 'plaquinha' : 'plaquinhas'}…`);
    await Placa.baixarPdf(lista.map((c) => ({ codigo: c, url: tagUrl(c) })), `${nomeArq(titulo)}.pdf`);
  }
  // Painel da equipe do restaurante.
  const painelDe = (r) => (BASE ? `https://${r.slug}.${BASE}/admin/` : new URL(`/admin/?r=${r.slug}`, location.origin).href);
  // Texto pronto para mandar ao restaurante (WhatsApp, e-mail).
  const textoAcesso = (r, senha) => [
    `*${r.nome}*`,
    `Site das mesas: ${siteDe(r)}`,
    `Painel da equipe: ${painelDe(r)}`,
    senha ? `Senha da equipe: ${senha}` : '',
    '',
    `Cada pessoa da equipe cria a conta no painel com a senha da equipe e depois entra só com o próprio PIN.`,
    `Para ligar uma plaquinha: encoste o celular nela, digite o endereço "${r.slug}" (só na primeira vez), entre com o PIN e escolha a mesa.`,
  ].filter((l, i, a) => l || a[i - 1]).join('\n');

  // Acesso do restaurante: endereço, painel e senha da equipe, com botões de copiar.
  function mostrarAcesso(r, novo, senha) {
    $('#shTitle').textContent = novo ? 'Restaurante criado' : r.nome;
    const linha = (rotulo, valor, link) => `<div class="acesso-linha">
        <span>${rotulo}</span>
        ${link ? `<a class="mono" href="${esc(link)}" target="_blank" rel="noopener">${esc(valor)}</a>` : `<b class="mono">${esc(valor)}</b>`}
        <button type="button" class="icon-btn" data-copiar-txt="${esc(link || valor)}" aria-label="Copiar ${rotulo.toLowerCase()}" title="Copiar">${icon('copy')}</button>
      </div>`;
    S.acessoTexto = textoAcesso(r, senha);
    $('#shBody').innerHTML = `<div class="stack acesso">
      <div class="acesso-dados">
        ${linha('Site das mesas', siteCurto(r), siteDe(r))}
        ${linha('Painel da equipe', `${siteCurto(r)}/admin`, painelDe(r))}
        ${senha ? linha('Senha da equipe', senha) : '<p class="muted acesso-obs">A senha da equipe não fica visível depois de criada. Para trocar, use <b>Editar</b>.</p>'}
      </div>
      <ol class="ativ-passos">
        <li>Cada pessoa da equipe abre o painel, toca em <b>Criar conta</b> com a senha da equipe e passa a entrar só com o próprio PIN.</li>
        <li>Para ligar uma plaquinha: encoste o celular nela; na tela <b>Plaquinha nova</b>, digite o endereço <b class="mono">${esc(r.slug)}</b> (só na primeira vez, o celular lembra).</li>
        <li>Entre com o PIN e escolha o número da mesa.</li>
      </ol>
      <div class="acesso-acts">
        <button type="button" class="btn btn-cobalt" data-copiar-acesso>${icon('copy')} Copiar tudo</button>
        <a class="btn btn-line" href="https://wa.me/?text=${encodeURIComponent(S.acessoTexto)}" target="_blank" rel="noopener">${icon('share')} Enviar no WhatsApp</a>
      </div>
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
      async salvarRestaurante({ senha, ...r }) {
        const db = read();
        if (db.restaurantes.some((x) => x.slug === r.slug && x.id !== r.id)) throw new Error('Esse subdomínio já está em uso. Escolha outro.');
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
      // Mesmas regras de public.limpar_etiquetas() do schema.sql.
      async limpar(codigos, nivel) {
        const db = read();
        db.etiquetas.forEach((e) => {
          if (!codigos.includes(e.codigo)) return;
          Object.assign(e, { mesa: null, vinculada_em: null, vinculada_por: null });
          if (nivel !== 'mesa') Object.assign(e, { restaurante_id: null, vendida_em: null, ativada_em: null });
          if (nivel === 'tudo') Object.assign(e, { gravada: false, leituras: 0, ultima_leitura: null });
        });
        write(db);
      },
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
            n: soma(doR.filter(noPer)), anterior: soma(doR.filter(noAnt)), chamados: 0, resposta_s: null,
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
      async salvarRestaurante({ id, senha, ...dados }) {
        if (!id) {
          const novo = must(await sb.rpc('criar_restaurante', { p_nome: dados.nome, p_slug: dados.slug, p_senha_equipe: senha }));
          if (novo && novo.id && dados.modulos) must(await sb.from('restaurantes').update({ modulos: dados.modulos }).eq('id', novo.id));
          return novo && { ...novo, modulos: dados.modulos };
        }
        const { data, error } = await sb.from('restaurantes').update(dados).eq('id', id).select().single();
        if (error) throw error.code === '23505' ? new Error('Esse subdomínio já está em uso. Escolha outro.') : error;
        if (senha) must(await sb.rpc('central_senha_equipe', { p_restaurante: id, p_senha: senha }));
        return data;
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
      async limpar(codigos, nivel) {
        for (let i = 0; i < codigos.length; i += 500) {
          must(await sb.rpc('limpar_etiquetas', { p_codigos: codigos.slice(i, i + 500), p_nivel: nivel }));
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
    const parados = rs.filter((r) => r.ativo && r.etiquetas && (diasSem(r.ultima) === null || diasSem(r.ultima) >= 7));
    return `<div class="vhead"><div><h1>Visão geral</h1><p>Leituras são os toques no NFC e as leituras do QR que passam pela central. Chamados, cardápio e comentários ficam no sistema de cada restaurante.</p></div>
        <div class="seg" role="radiogroup" aria-label="Período">${[7, 30, 90].map((d) => `<button type="button" role="radio" aria-checked="${S.dias === d}" data-dias="${d}">${d} dias</button>`).join('')}</div></div>
      <dl class="strip">
        <div><dt>Leituras em ${S.dias} dias</dt><dd>${num(m.total)} ${variacao(m.total, m.total_anterior)}</dd></div>
        <div><dt>Chamados no período</dt><dd>${num(m.chamados || 0)}</dd></div>
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
          <thead><tr><th>#</th><th>Restaurante</th><th class="num">Leituras</th><th class="num">vs. período anterior</th><th class="num">Plaquinhas lidas</th><th class="num">Nunca lidas</th><th class="num">Chamados</th><th class="num">Resposta média</th><th>Última leitura</th></tr></thead>
          <tbody>${rs.map((r, i) => {
            const ds = diasSem(r.ultima);
            return `<tr>
              <td class="muted">${i + 1}</td>
              <td><button type="button" class="link" data-ver-rest="${r.id}">${esc(r.nome)}</button>${r.ativo ? '' : ' <span class="pill">desativado</span>'}</td>
              <td class="num"><b>${num(r.n)}</b></td>
              <td class="num">${variacao(r.n, r.anterior) || '<span class="muted">—</span>'}</td>
              <td class="num">${r.lidas}/${r.etiquetas}</td>
              <td class="num">${r.nunca_lidas ? `<span class="warn">${r.nunca_lidas}</span>` : '0'}</td>
              <td class="num">${num(r.chamados)}</td>
              <td class="num">${r.resposta_s == null ? '<span class="muted">—</span>' : r.resposta_s < 60 ? `${r.resposta_s} s` : `${Math.floor(r.resposta_s / 60)} min ${String(r.resposta_s % 60).padStart(2, '0')} s`}</td>
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
    return `<div class="vhead"><div><h1>Plaquinhas</h1><p>Cada plaquinha tem um código único, igual no NFC e no QR. Ela sai sem dono: na primeira leitura, a equipe do restaurante digita o endereço do restaurante, entra com o PIN e escolhe a mesa.</p></div>
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
          <button type="button" class="btn btn-line btn-sm" data-acao="mesa">Tirar da mesa</button>
          <button type="button" class="btn btn-line btn-sm" data-acao="estoque">Devolver ao estoque</button>
          <button type="button" class="btn btn-line btn-sm" data-acao="zerar">Zerar tudo</button>
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
    return `<div class="vhead"><div><h1>Restaurantes</h1><p>Cada restaurante tem um endereço próprio e a senha da equipe. Na primeira leitura de uma plaquinha nova, alguém da equipe digita o endereço do restaurante e entra com o PIN: a plaquinha passa a ser dele. Em <b>Acesso</b> você copia os dados para mandar ao restaurante.</p></div>
        <button type="button" class="btn btn-cobalt" data-abrir="rest">${icon('plus')} Novo restaurante</button></div>
      ${S.rests.length ? `<div class="rests">${S.rests.map((r) => `<article class="rcard ${r.ativo === false ? 'is-off' : ''}">
          <div><h3>${esc(r.nome)}</h3>
            <p class="rcard-links"><a href="${esc(siteDe(r))}" target="_blank" rel="noopener" class="mono">${esc(siteCurto(r))}</a>
              <a href="${esc(painelDe(r))}" target="_blank" rel="noopener" class="mono">painel</a></p>
            ${r.observacao ? `<p>${esc(r.observacao)}</p>` : ''}
            ${r.modulos && r.modulos.fidelidade ? '<span class="pill pill--mod">Fidelidade</span>' : ''}</div>
          <div class="rcard-foot"><span>${cont(r.id)} ${cont(r.id) === 1 ? 'plaquinha' : 'plaquinhas'}${r.ativo === false ? ' · <b>desativado</b>' : ''}</span>
            <span class="rcard-acts"><button type="button" class="btn btn-quiet btn-sm" data-ver-rest="${r.id}">Ver plaquinhas</button>
            <button type="button" class="btn btn-quiet btn-sm" data-acesso="${r.id}">${icon('share')} Acesso</button>
            <button type="button" class="btn btn-line btn-sm" data-editar="${r.id}">${icon('edit')} Editar</button></span></div>
        </article>`).join('')}</div>`
        : `<div class="vazio">${icon('grid')}<h2>Nenhum restaurante</h2><p>Cadastre o restaurante com um nome, o endereço (subdomínio) e a senha da equipe. A equipe usa o endereço e o PIN para ligar as plaquinhas.</p></div>`}`;
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
      <label class="field"><span>Restaurante</span><select class="input" id="vRest" required>${S.rests.filter((r) => r.ativo !== false).map((r) => `<option value="${r.id}">${esc(r.nome)} — ${esc(siteCurto(r))}</option>`).join('')}</select></label>
      <button type="submit" class="btn btn-cobalt btn-block">${icon('check')} Entregar</button>
    </form>` : `<div class="stack"><p>Cadastre o restaurante primeiro.</p><button type="button" class="btn btn-cobalt" data-abrir="rest">${icon('plus')} Novo restaurante</button></div>`;
    openSheet('sh');
  }
  function abrirRest(id) {
    const r = id ? restDe(id) : { nome: '', slug: '', observacao: '', ativo: true };
    S.editRest = id || null;
    $('#shTitle').textContent = id ? 'Editar restaurante' : 'Novo restaurante';
    $('#shBody').innerHTML = `<form class="stack" id="fRestForm" novalidate>
      <label class="field"><span>Nome</span><input class="input" id="rNome" maxlength="80" required value="${esc(r.nome)}"></label>
      <label class="field"><span>Endereço (subdomínio)</span>
        <span class="slug-campo"><input class="input mono" id="rSlug" maxlength="40" required value="${esc(r.slug || '')}" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="quintal"><span class="slug-base mono">.${esc(BASE || 'seu-dominio')}</span></span>
        <small class="help">Letras minúsculas, números e hífen. O sistema do restaurante fica em <b id="rSite">${esc(r.slug ? siteCurto(r) : '…')}</b>, sem configurar nada no DNS.${id ? ' Trocar o subdomínio muda o endereço; as plaquinhas continuam funcionando.' : ''}</small></label>
      <label class="field"><span>${id ? 'Nova senha da equipe (opcional)' : 'Senha da equipe'}</span><input class="input" id="rSenha" type="text" minlength="6" maxlength="60" autocomplete="off" ${id ? 'placeholder="Deixe em branco para manter"' : 'required'}>
        <small class="help">A equipe usa esta senha para criar a conta no painel (cada pessoa depois entra com o próprio PIN).</small></label>
      <label class="field"><span>Observação (opcional)</span><input class="input" id="rObs" maxlength="300" value="${esc(r.observacao || '')}"></label>
      <label class="check"><input type="checkbox" id="rAtivo" ${r.ativo !== false ? 'checked' : ''}> Ativo (desmarcado: as plaquinhas mostram “desativada”)</label>
      <fieldset class="stack modulos"><legend>Módulos contratados</legend>
        <label class="check"><input type="checkbox" id="rFid" ${r.modulos && r.modulos.fidelidade ? 'checked' : ''}> Programa de fidelidade (aba Fidelidade no painel; o restaurante configura as regras e coloca no ar)</label>
      </fieldset>
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
      <p>${r ? `Entregue a <b>${esc(r.nome)}</b>${t.vendida_em || t.ativada_em ? ` em ${fmtData(t.vendida_em || t.ativada_em)}` : ''}${t.mesa ? ` · mesa <b>${t.mesa}</b>` : ' · sem mesa'}` : 'Em estoque'}
        · NFC ${t.gravada ? 'gravado' : 'não gravado'} · ${t.leituras || 0} leituras${t.ultima_leitura ? ` (última ${ago(t.ultima_leitura)})` : ''}</p>
      <div class="acts">
        <button type="button" class="btn btn-line btn-sm" data-pdf1="${codigo}">${icon('download')} PDF</button>
        <button type="button" class="btn btn-line btn-sm" data-copiar="${codigo}">${icon('copy')} Copiar link</button>
        <a class="btn btn-line btn-sm" href="${esc(tagUrl(codigo))}" target="_blank" rel="noopener">${icon('external')} Testar</a>
      </div>
      <div class="limpar">
        <h3>Limpar plaquinha</h3>
        <p class="muted">O código ${esc(codigo)} nunca muda. Limpar só apaga o que está ligado a ele.</p>
        <div class="acts">
          ${t.mesa ? `<button type="button" class="btn btn-line btn-sm" data-limpar1="mesa" data-cod="${codigo}">Tirar da mesa</button>` : ''}
          ${t.restaurante_id ? `<button type="button" class="btn btn-line btn-sm" data-limpar1="estoque" data-cod="${codigo}">Devolver ao estoque</button>` : ''}
          <button type="button" class="btn btn-danger btn-sm" data-limpar1="zerar" data-cod="${codigo}">${icon('trash')} Zerar tudo</button>
        </div>
      </div>
    </div>`;
    openSheet('sh');
  }

  // Limpar: 'mesa' tira da mesa (continua do restaurante); 'estoque' devolve ao
  // estoque; 'zerar' volta a ser como nova (NFC para gravar de novo). O código não muda.
  async function limparPlaquinhas(codigos, tipo) {
    if (!codigos.length) return;
    const um = codigos.length === 1;
    const alvo = um ? `a plaquinha ${codigos[0]}` : `${codigos.length} plaquinhas`;
    const pergunta = {
      mesa: `Tirar ${alvo} da mesa? ${um ? 'Ela continua' : 'Elas continuam'} do restaurante e ${um ? 'aparece' : 'aparecem'} como “Plaquinha nova” até ${um ? 'ser ligada' : 'serem ligadas'} de novo.`,
      estoque: `Devolver ${alvo} ao estoque? ${um ? 'Ela deixa' : 'Elas deixam'} de ser do restaurante e ${um ? 'para' : 'param'} de abrir o site dele.`,
      zerar: `Zerar ${alvo}? ${um ? 'Ela volta' : 'Elas voltam'} a ser como ${um ? 'nova' : 'novas'}: sem restaurante, sem mesa e leituras zeradas. Em seguida você pode apagar o chip encostando no celular. O código impresso não muda.`,
    }[tipo];
    if (!confirm(pergunta)) return;
    try {
      await api.limpar(codigos, { mesa: 'mesa', estoque: 'restaurante', zerar: 'tudo' }[tipo]);
      const feito = { mesa: um ? 'Plaquinha tirada da mesa.' : 'Plaquinhas tiradas da mesa.', estoque: um ? 'Plaquinha devolvida ao estoque.' : 'Plaquinhas devolvidas ao estoque.', zerar: um ? 'Plaquinha zerada: está como nova.' : 'Plaquinhas zeradas: estão como novas.' };
      toast(feito[tipo], { tone: 'ok' });
      if (tipo === 'zerar') telaApagar(codigos);
      else if (!$('#sh').hidden) closeSheet();
    } catch (ex) {
      toast(ex.message, { tone: 'error' });
    }
    return carregar();
  }

  // Depois de zerar: apaga o link gravado no chip, para a plaquinha ficar em
  // branco (grava de novo pela tela “Gravar NFC”). Plaquinha bloqueada não apaga.
  function telaApagar(codigos) {
    G.apagar = new Set(codigos);
    const um = codigos.length === 1;
    $('#shTitle').textContent = 'Apagar o chip';
    $('#shBody').innerHTML = 'NDEFReader' in window
      ? `<div class="stack gravar">
        <p>No sistema, ${um ? `a plaquinha <b>${esc(codigos[0])}</b> já está zerada` : `as ${codigos.length} plaquinhas já estão zeradas`}. Assim ${um ? 'ela já pode' : 'elas já podem'} ser usada${um ? '' : 's'} de novo: ao encostar, abre a tela de ativação, como nova.</p>
        <p class="muted">Quer também deixar o chip em branco? Só funciona se ${um ? 'ela não foi bloqueada' : 'elas não foram bloqueadas'} ao gravar (a opção “Bloquear” vem ligada). Toque em “Apagar” e encoste ${um ? 'a plaquinha' : 'uma de cada vez'} atrás do celular.</p>
        <p class="gravar-msg" aria-live="polite"></p>
        <div class="acts"><button type="button" class="btn btn-danger btn-sm" data-apagar>${icon('nfc')} Apagar o chip</button>
          <button type="button" class="btn btn-quiet btn-sm" data-close>Pronto</button></div></div>`
      : `<div class="stack"><p>No sistema, ${um ? 'a plaquinha já está zerada' : 'as plaquinhas já estão zeradas'}. Para apagar também o chip, abra a central no <b>Chrome do Android</b> com o NFC ligado e zere de novo. Sem apagar, ao encostar ela abre a tela de ativação, como uma nova.</p>
        <div class="acts"><button type="button" class="btn btn-quiet btn-sm" data-close>Pronto</button></div></div>`;
    openSheet('sh');
  }

  async function ligarApagar() {
    const b = $('[data-apagar]');
    if (b) b.hidden = true;
    msgGravar('Liberando o NFC…', '');
    desligarNfc();
    const ctrl = new AbortController();
    const reader = new NDEFReader();
    G.ctrl = ctrl;
    G.reader = reader;
    try {
      await reader.scan({ signal: ctrl.signal });
    } catch (e) {
      if (G.reader === reader) desligarNfc();
      if (b) b.hidden = false;
      return msgGravar(e.name === 'NotAllowedError' ? 'Permita o uso de NFC para este site (ícone ao lado do endereço).' : `NFC indisponível: ${e.message}. Confira se o NFC do celular está ligado.`);
    }
    msgGravar('Encoste a plaquinha atrás do celular.', '');
    reader.onreadingerror = () => msgGravar('Não deu para ler. Afaste e encoste de novo.');
    reader.onreading = (ev) => apagarChip(ev, reader);
  }

  async function apagarChip(ev, reader) {
    if (G.ocupado) return;
    const link = (ev.message.records || []).map((r) => {
      try { return r.recordType === 'url' ? new TextDecoder().decode(r.data) : ''; } catch { return ''; }
    }).find(Boolean) || '';
    const cod = codigoDoLink(link);
    if (!(ev.message.records || []).some((r) => r.recordType !== 'empty')) return msgGravar('Este chip já está em branco.', 'is-ok');
    if (!cod || !G.apagar.has(cod)) return msgGravar(`Esta não é ${G.apagar.size === 1 ? `a ${[...G.apagar][0]}` : 'uma das plaquinhas zeradas'}${cod ? ` (é a ${cod})` : ''}. Nada foi apagado.`);
    G.ocupado = true;
    msgGravar(`Apagando ${cod}… mantenha encostada.`, '');
    const ctrl = new AbortController();
    const prazo = setTimeout(() => ctrl.abort(), 8000);
    try {
      await reader.write({ records: [{ recordType: 'empty' }] }, { overwrite: true, signal: ctrl.signal });
      G.apagar.delete(cod);
      navigator.vibrate && navigator.vibrate(60);
      msgGravar(G.apagar.size ? `${cod} apagada. Encoste a próxima (faltam ${G.apagar.size}).` : `${cod} apagada: o chip está em branco. Para usar de novo, grave em “Gravar NFC”.`, 'is-ok');
      if (!G.apagar.size) desligarNfc();
    } catch (e) {
      // Chip bloqueado dá "IO error", igual a quando o celular perde o contato:
      // na primeira falha pede para tentar de novo; na segunda, conclui que está bloqueado.
      G.falhas = G.falhas || {};
      const n = (G.falhas[cod] = (G.falhas[cod] || 0) + 1);
      if (e.name === 'AbortError' || n < 2) {
        msgGravar('Não apagou. Afaste e encoste de novo, bem parado, por 2 segundos.');
      } else {
        G.apagar.delete(cod);
        msgGravar(`${cod} está bloqueada: foi gravada com “Bloquear” ligado, e o chip não aceita mais mudanças. Não precisa apagar: ela já está zerada no sistema e, ao encostar, abre a tela de ativação. Dá para usar de novo em qualquer restaurante, com o mesmo código.${G.apagar.size ? ` Encoste a próxima (faltam ${G.apagar.size}).` : ''}`, 'is-ok');
        if (!G.apagar.size) desligarNfc();
      }
    } finally {
      clearTimeout(prazo);
      G.ocupado = false;
    }
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

  /* Gravação NFC (Chrome no Android). Três modos:
     - câmera: lê o QR impresso na plaquinha e grava o MESMO código no NFC dela
       (não tem como trocar plaquinha, é o recomendado);
     - digitar: digita o código impresso na plaquinha (sem câmera);
     - lista: segue os códigos selecionados, um por vez, mostrando qual gravar.
     Câmera e NFC nunca ficam ligados ao mesmo tempo (em alguns Android o Chrome
     trava com os dois juntos): o NFC só liga depois que a câmera desliga.
     Opcionalmente bloqueia cada etiqueta. Não regrava a mesma etiqueta duas
     vezes seguidas: compara o número de série. */
  const G = { modo: 'camera', fila: [], i: 0, lido: null, feitos: 0, reader: null, ctrl: null, ultimaSerie: null, ultimoLink: null, ocupado: false, bloquear: true, stream: null, detector: null, camT: 0, vigia: 0, errosCam: 0 };
  const temCamera = () => 'BarcodeDetector' in window && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const atual = () => (G.modo === 'lista' ? G.fila[G.i] : G.lido);
  const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
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
    const padrao = temCamera() ? 'camera' : 'digitar';
    $('#shBody').innerHTML = `<div class="stack">
      <div class="modo" role="radiogroup" aria-label="Como gravar">
        ${temCamera() ? `<label><input type="radio" name="gModo" value="camera" checked><span><b>Ler o QR da plaquinha</b><small>Aponte a câmera para o QR já impresso e depois encoste a mesma plaquinha: o NFC recebe exatamente o código do QR. Recomendado.</small></span></label>` : ''}
        <label><input type="radio" name="gModo" value="digitar" ${padrao === 'digitar' ? 'checked' : ''}><span><b>Digitar o código da plaquinha</b><small>Digite o código impresso nela (ex.: K7P2QXA) e encoste. Não usa a câmera.</small></span></label>
        <label><input type="radio" name="gModo" value="lista" ${G.fila.length ? '' : 'disabled'}><span><b>Seguir a lista selecionada</b><small>${G.fila.length ? `${G.fila.length} ${G.fila.length === 1 ? 'código' : 'códigos'} em ordem; a tela mostra qual plaquinha encostar.` : 'Selecione plaquinhas na lista para usar este modo.'}</small></span></label>
      </div>
      <label class="check"><input type="checkbox" id="gBloq" checked> Bloquear cada etiqueta depois de gravar (definitivo: ninguém consegue regravar)</label>
      <button type="button" class="btn btn-cobalt btn-block" data-gravar="iniciar">${icon('nfc')} Começar</button>
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
      : G.modo === 'camera'
        ? `<video class="gravar-cam" id="gCam" playsinline muted></video>`
        : `<form class="gravar-dig" id="gDig" novalidate>
            <label class="field"><span>Código impresso na plaquinha</span>
              <input class="input mono" id="gCodigo" maxlength="16" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="K7P2QXA" required></label>
            <button type="submit" class="btn btn-cobalt">Continuar</button>
          </form>`;
    const padrao = t
      ? (G.ocupado ? 'Gravando… mantenha encostada.' : 'Aguardando a etiqueta NFC…')
      : G.modo === 'camera' ? 'Aponte a câmera para o QR da plaquinha.' : 'Digite o código que está impresso na plaquinha.';
    $('#shBody').innerHTML = `<div class="stack gravar">
      <p class="gravar-prog">${prog}</p>
      ${topo}
      <p class="gravar-msg ${tom}" aria-live="polite">${esc(msg || padrao)}</p>
      <div class="acts">
        ${t ? `<button type="button" class="btn btn-line btn-sm" data-gravar="pular">${G.modo === 'camera' ? 'Ler outro QR' : G.modo === 'digitar' ? 'Outro código' : 'Pular'}</button>` : ''}
        ${!t && G.modo === 'camera' ? '<button type="button" class="btn btn-line btn-sm" data-gravar="digitar">Digitar o código</button>' : ''}
        <button type="button" class="btn btn-quiet btn-sm" data-gravar="parar">Parar</button>
      </div>
    </div>`;
    if (!t && G.modo === 'camera') ligarCamera();
    if (!t && G.modo === 'digitar') setTimeout(() => $('#gCodigo') && $('#gCodigo').focus(), 60);
    // Com a plaquinha definida (e a câmera já desligada), liga o NFC.
    if (t && !G.reader) ligarNfc();
  }

  function msgGravar(texto, tom = 'is-erro') {
    const el = $('.gravar-msg');
    if (!el) return;
    el.textContent = texto;
    el.className = `gravar-msg ${tom}`;
  }

  async function ligarNfc() {
    desligarNfc();
    const ctrl = new AbortController();
    const reader = new NDEFReader();
    G.ctrl = ctrl;
    G.reader = reader;
    try {
      await reader.scan({ signal: ctrl.signal });
    } catch (e) {
      if (G.reader === reader) desligarNfc();
      msgGravar(e.name === 'NotAllowedError' ? 'Permita o uso de NFC para este site (ícone ao lado do endereço).' : `NFC indisponível: ${e.message}. Confira se o NFC do celular está ligado.`);
      return false;
    }
    reader.onreadingerror = () => atual() && msgGravar('Não deu para ler. Afaste e encoste de novo.');
    reader.onreading = (ev) => gravarEtiqueta(ev);
    return true;
  }
  function desligarNfc() {
    G.ctrl && G.ctrl.abort();
    G.ctrl = null;
    G.reader = null;
  }

  async function ligarCamera() {
    const video = $('#gCam');
    if (!video) return;
    const falhou = (texto) => {
      desligarCamera();
      msgGravar(texto);
    };
    try {
      G.stream = G.stream || (await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
      }));
      G.detector = G.detector || new BarcodeDetector({ formats: ['qr_code'] });
      if (!document.contains(video)) return desligarCamera();
      video.srcObject = G.stream;
      await Promise.race([video.play(), espera(6000).then(() => { throw new Error('tempo esgotado'); })]);
    } catch (e) {
      return falhou(e.name === 'NotAllowedError'
        ? 'Permita o uso da câmera para ler o QR, ou toque em “Digitar o código”.'
        : 'A câmera não abriu. Feche outros apps que usam a câmera ou reinicie o celular. Enquanto isso, toque em “Digitar o código”.');
    }
    // Tela preta: a câmera "abriu" mas não manda imagem. Desliga antes de travar o Chrome.
    clearTimeout(G.vigia);
    G.vigia = setTimeout(() => {
      if (G.stream && document.contains(video) && !video.videoWidth) {
        falhou('A câmera ficou sem imagem. Reinicie o celular ou toque em “Digitar o código”.');
      }
    }, 5000);
    G.errosCam = 0;
    clearTimeout(G.camT);
    const loop = async () => {
      if (!G.stream || G.lido || !document.contains(video)) return;
      if (video.readyState >= 2 && video.videoWidth) {
        try {
          for (const b of await G.detector.detect(video)) {
            const c = codigoDoLink(b.rawValue);
            if (!c) continue;
            const tag = S.tags.find((x) => x.codigo === c);
            if (!tag) {
              msgGravar(`O QR ${c} não é de uma plaquinha cadastrada.`);
              continue;
            }
            G.lido = tag;
            navigator.vibrate && navigator.vibrate(30);
            desligarCamera();
            // Dá um respiro para o Android soltar a câmera antes de ligar o NFC.
            await espera(400);
            return telaGravar(tag.gravada ? 'Esta plaquinha já consta como gravada. Encoste para conferir ou regravar.' : '');
          }
          G.errosCam = 0;
        } catch {
          if (++G.errosCam >= 12) return falhou('O leitor de QR deste celular falhou. Toque em “Digitar o código”.');
        }
      }
      G.camT = setTimeout(loop, 300);
    };
    loop();
  }
  function desligarCamera() {
    clearTimeout(G.camT);
    clearTimeout(G.vigia);
    G.stream && G.stream.getTracks().forEach((tr) => tr.stop());
    G.stream = null;
    const v = $('#gCam');
    if (v) v.srcObject = null;
  }

  async function iniciarGravar() {
    const modo = ($('input[name="gModo"]:checked') || {}).value || 'digitar';
    G.modo = modo;
    G.bloquear = $('#gBloq').checked;
    G.lido = null;
    G.feitos = 0;
    G.ultimaSerie = null;
    G.ultimoLink = null;
    G.ocupado = false;
    if (G.modo === 'lista') return telaGravar();
    // Pede a permissão do NFC agora (precisa do toque no botão) e solta em
    // seguida: com câmera ou código digitado, o NFC só liga com a plaquinha definida.
    $('#shBody').innerHTML = `<div class="stack gravar"><p class="gravar-msg" aria-live="polite">Liberando o NFC…</p>
      <div class="acts"><button type="button" class="btn btn-quiet btn-sm" data-gravar="parar">Parar</button></div></div>`;
    if (!(await ligarNfc())) return;
    desligarNfc();
    await espera(200);
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
    if (outro && outro !== t.codigo) return msgGravar(`Esta etiqueta já tem outro código (${outro}). Confira se é a plaquinha certa.`);
    G.ocupado = true;
    const reader = G.reader;
    const passos = G.bloquear ? 2 : 1;
    // Cada operação no chip tem prazo: se o celular perdeu o contato, é mais
    // rápido afastar e encostar de novo do que esperar.
    const comPrazo = (fazer) => {
      const ctrl = new AbortController();
      const t0 = setTimeout(() => ctrl.abort(), 8000);
      return fazer(ctrl.signal).finally(() => clearTimeout(t0));
    };
    const outroBotao = G.modo === 'lista' ? 'Pular' : G.modo === 'camera' ? 'Ler outro QR' : 'Outro código';
    try {
      if (link !== meu) {
        msgGravar(`Gravando${passos > 1 ? ' (1/2)' : ''}… mantenha encostada.`, '');
        await comPrazo((signal) => reader.write({ records: [{ recordType: 'url', data: meu }] }, { overwrite: true, signal }));
      }
    } catch (e) {
      G.ocupado = false;
      return msgGravar(e.name === 'AbortError'
        ? 'A etiqueta não respondeu. Afaste o celular e encoste de novo.'
        : `Não gravou: ${e.message}. Afaste e encoste de novo.`);
    }
    // Registrar no servidor fica para depois de liberar o chip (não segura o celular encostado).
    const registrar = () => {
      if (t.gravada) return;
      t.gravada = true;
      api.marcarGravadas([t.codigo], true).catch((e) => {
        console.error(e);
        t.gravada = false;
        setTimeout(registrar, 3000);
      });
    };
    if (G.bloquear) {
      try {
        msgGravar('Bloqueando (2/2)… mantenha encostada.', '');
        await comPrazo((signal) => reader.makeReadOnly({ signal }));
      } catch (e) {
        registrar();
        G.ocupado = false;
        return msgGravar(e.name === 'AbortError'
          ? `${t.codigo} gravada, mas o bloqueio não respondeu. Afaste e encoste de novo para bloquear, ou toque em “${outroBotao}” se ela já estiver bloqueada.`
          : `${t.codigo} gravada, mas não bloqueou (${e.message}). Encoste de novo para bloquear; se ela já estiver bloqueada, toque em “${outroBotao}”.`);
      }
    }
    registrar();
    G.ultimaSerie = serie;
    G.ultimoLink = meu;
    G.feitos++;
    navigator.vibrate && navigator.vibrate(60);
    G.ocupado = false;
    if (G.modo === 'lista') G.i++;
    else {
      G.lido = null;
      desligarNfc();
    }
    telaGravar(`Pronto: ${t.codigo} gravada${G.bloquear ? ' e bloqueada' : ''}. Pode afastar. ${G.modo === 'camera' ? 'Leia o QR da próxima.' : G.modo === 'digitar' ? 'Digite o código da próxima.' : 'Encoste a próxima.'}`, 'is-ok');
  }

  function pararGravar() {
    desligarCamera();
    desligarNfc();
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
    const l1 = t.closest('[data-limpar1]');
    if (l1) return limparPlaquinhas([l1.dataset.cod], l1.dataset.limpar1);
    if (t.closest('[data-apagar]')) return ligarApagar();
    const acs = t.closest('[data-acesso]');
    if (acs) {
      const r = restDe(acs.dataset.acesso);
      return r && mostrarAcesso(r, false);
    }
    const ct = t.closest('[data-copiar-txt]');
    if (ct) {
      const ok = await copyText(ct.dataset.copiarTxt);
      return toast(ok ? 'Copiado.' : 'Não foi possível copiar. Toque e segure no texto para copiar.', { tone: ok ? 'ok' : 'error' });
    }
    if (t.closest('[data-copiar-acesso]')) {
      const ok = await copyText(S.acessoTexto || '');
      return toast(ok ? 'Dados de acesso copiados. Cole no WhatsApp ou no e-mail.' : 'Não foi possível copiar.', { tone: ok ? 'ok' : 'error' });
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
      if (['estoque', 'mesa', 'zerar'].includes(ac.dataset.acao)) return limparPlaquinhas(lista.map((x) => x.codigo), ac.dataset.acao);
    }
    const g = t.closest('[data-gravar]');
    if (g) {
      if (g.dataset.gravar === 'iniciar') return iniciarGravar();
      if (g.dataset.gravar === 'pular') {
        if (G.modo === 'lista') G.i++;
        else {
          G.lido = null;
          desligarNfc();
        }
        G.ultimaSerie = null;
        return telaGravar();
      }
      if (g.dataset.gravar === 'digitar') {
        desligarCamera();
        G.modo = 'digitar';
        G.lido = null;
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
  document.addEventListener('input', (e) => {
    if (e.target.id === 'rNome' && !S.editRest && !$('#rSlug').dataset.mexeu) $('#rSlug').value = paraSlug(e.target.value);
    if (e.target.id === 'rSlug') { e.target.dataset.mexeu = '1'; e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''); }
    if (e.target.id === 'rNome' || e.target.id === 'rSlug') {
      const v = $('#rSlug').value;
      $('#rSite').textContent = v ? siteCurto({ slug: v }) : '…';
    }
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

  document.addEventListener('submit', (e) => {
    if (e.target.id !== 'gDig') return;
    e.preventDefault();
    const c = String($('#gCodigo').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const tag = S.tags.find((x) => x.codigo === c);
    if (!c) return msgGravar('Digite o código impresso na plaquinha.');
    if (!tag) return msgGravar(`O código ${c} não é de uma plaquinha cadastrada. Confira as letras e números.`);
    G.lido = tag;
    G.ultimaSerie = null;
    telaGravar(tag.gravada ? 'Esta plaquinha já consta como gravada. Encoste para conferir ou regravar.' : '');
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
        const nome = $('#rNome').value.trim();
        const slug = $('#rSlug').value.trim().toLowerCase();
        const senha = $('#rSenha').value.trim();
        if (!nome) throw new Error('Informe o nome.');
        if (!slugOk(slug)) throw new Error('Subdomínio inválido: use letras minúsculas, números e hífen (sem acento nem espaço).');
        if ((!S.editRest || senha) && senha.length < 6) throw new Error('A senha da equipe precisa ter pelo menos 6 caracteres.');
        const salvo = await api.salvarRestaurante({ ...(S.editRest ? { id: S.editRest } : {}), nome, slug, senha, observacao: $('#rObs').value.trim() || null, ativo: $('#rAtivo').checked, modulos: { ...((restDe(S.editRest) || {}).modulos || {}), fidelidade: $('#rFid').checked } });
        if (!S.editRest && salvo) {
          S.rests.push(salvo);
          mostrarAcesso(salvo, true, senha);
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
