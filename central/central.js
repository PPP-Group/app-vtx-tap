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
    view: 'plaquinhas',
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
        if (r.id) db.restaurantes = db.restaurantes.map((x) => (x.id === r.id ? { ...x, ...r } : x));
        else db.restaurantes.push({ ...r, id: id(), criado_em: new Date().toISOString() });
        write(db);
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
        if (id) must(await sb.from('restaurantes').update(dados).eq('id', id));
        else must(await sb.from('restaurantes').insert(dados));
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
    };
  }

  async function carregar() {
    try {
      const [rests, tags] = await Promise.all([api.listRestaurantes(), api.listEtiquetas()]);
      S.rests = rests || [];
      S.tags = tags || [];
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
    $('#main').innerHTML = S.view === 'restaurantes' ? vRestaurantes() : vPlaquinhas();
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
    return `<div class="vhead"><div><h1>Plaquinhas</h1><p>Cada plaquinha tem um código único, igual no NFC e no QR. Ela abre o site do restaurante para o qual foi entregue.</p></div>
        <button type="button" class="btn btn-cobalt" data-abrir="gerar">${icon('plus')} Gerar lote</button></div>
      <dl class="strip">
        <div><dt>Total</dt><dd>${total}</dd></div>
        <div><dt>Em estoque</dt><dd>${total - vendidas}</dd></div>
        <div><dt>Entregues</dt><dd>${vendidas}</dd></div>
        <div><dt>NFC gravadas</dt><dd>${gravadas}</dd></div>
      </dl>
      <div class="filtros">
        <div class="seg" role="radiogroup" aria-label="Situação">
          ${[['todas', 'Todas'], ['estoque', 'Em estoque'], ['vendidas', 'Entregues']].map(([v, l]) => `<button type="button" role="radio" aria-checked="${S.filtro === v}" data-filtro="${v}">${l}</button>`).join('')}
        </div>
        <select class="input" id="fLote" aria-label="Lote"><option value="">Todos os lotes</option>${lotes.map((l) => `<option ${S.lote === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <select class="input" id="fRest" aria-label="Restaurante"><option value="">Todos os restaurantes</option>${S.rests.map((r) => `<option value="${r.id}" ${S.rest === r.id ? 'selected' : ''}>${esc(r.nome)}</option>`).join('')}</select>
        <input class="input" id="fBusca" type="search" placeholder="Buscar código" value="${esc(S.busca)}" autocomplete="off">
      </div>
      <div class="selbar ${n ? 'is-on' : ''}">
        <label class="selall"><input type="checkbox" id="selAll" ${lista.length && selVis === lista.length ? 'checked' : ''} ${lista.length ? '' : 'disabled'}> ${n ? `<b>${n}</b> ${n === 1 ? 'selecionada' : 'selecionadas'}` : `Selecionar as ${lista.length} da lista`}</label>
        <span class="selpick">ou as próximas <input class="input mono" id="pickN" type="number" min="1" max="2000" placeholder="10" aria-label="Quantidade"> <button type="button" class="btn btn-line btn-sm" data-pick>em estoque</button></span>
        ${n ? `<div class="selacts">
          <button type="button" class="btn btn-cobalt btn-sm" data-abrir="vender">${icon('arrow')} Entregar a um restaurante</button>
          <button type="button" class="btn btn-line btn-sm" data-acao="estoque">Devolver ao estoque</button>
          <button type="button" class="btn btn-line btn-sm" data-acao="imprimir">${icon('printer')} Imprimir QR</button>
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
    return `<div class="vhead"><div><h1>Restaurantes</h1><p>Para onde as plaquinhas de cada cliente apontam. Mudou o domínio? Troque aqui e todas as plaquinhas dele continuam funcionando.</p></div>
        <button type="button" class="btn btn-cobalt" data-abrir="rest">${icon('plus')} Novo restaurante</button></div>
      ${S.rests.length ? `<div class="rests">${S.rests.map((r) => `<article class="rcard ${r.ativo === false ? 'is-off' : ''}">
          <div><h3>${esc(r.nome)}</h3><a href="${esc(r.destino)}" target="_blank" rel="noopener" class="mono">${esc(r.destino.replace(/^https?:\/\//, ''))}</a>
            ${r.observacao ? `<p>${esc(r.observacao)}</p>` : ''}</div>
          <div class="rcard-foot"><span>${cont(r.id)} ${cont(r.id) === 1 ? 'plaquinha' : 'plaquinhas'}${r.ativo === false ? ' · <b>desativado</b>' : ''}</span>
            <span class="rcard-acts"><button type="button" class="btn btn-quiet btn-sm" data-ver-rest="${r.id}">Ver plaquinhas</button>
            <button type="button" class="btn btn-line btn-sm" data-editar="${r.id}">${icon('edit')} Editar</button></span></div>
        </article>`).join('')}</div>`
        : `<div class="vazio">${icon('grid')}<h2>Nenhum restaurante</h2><p>Cadastre o restaurante com o endereço do site dele (ex.: https://quintal.vtx.com.br) antes de entregar as plaquinhas.</p></div>`}`;
  }

  /* ============================== Folhas ============================== */
  function abrirGerar() {
    const hoje = new Date().toLocaleDateString('pt-BR', { month: '2-digit', year: 'numeric' }).replace('/', '-');
    $('#shTitle').textContent = 'Gerar lote';
    $('#shBody').innerHTML = `<form class="stack" id="fGerar" novalidate>
      <label class="field"><span>Quantidade</span><input class="input mono" id="gQtd" type="number" min="1" max="2000" value="50" required></label>
      <label class="field"><span>Nome do lote</span><input class="input" id="gLote" maxlength="40" value="Lote ${hoje}"><small class="help">Ajuda a achar as plaquinhas depois (ex.: pedido da gráfica).</small></label>
      <button type="submit" class="btn btn-cobalt btn-block">${icon('plus')} Gerar códigos</button>
    </form>`;
    openSheet('sh');
  }
  function abrirVender() {
    $('#shTitle').textContent = 'Entregar a um restaurante';
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

  /* Gravação NFC em sequência (Chrome no Android).
     Espera cada etiqueta ser encostada, grava o link dela e, se marcado, bloqueia.
     Não regrava a mesma etiqueta duas vezes: compara o número de série. */
  const G = { fila: [], i: 0, reader: null, ctrl: null, ultimaSerie: null, ultimoLink: null, ocupado: false, bloquear: true };

  function abrirGravar() {
    $('#shTitle').textContent = 'Gravar NFC';
    if (!('NDEFReader' in window)) {
      $('#shBody').innerHTML = `<div class="stack">
        <p>Este navegador não grava NFC. Abra esta página no <b>Chrome do Android</b>, com o NFC do celular ligado.</p>
        <p class="muted">Outra opção: exporte o CSV e grave com o app NFC Tools (Escrever › Adicionar registro › URL), ou peça para a gráfica gravar a partir do CSV.</p>
      </div>`;
      return openSheet('sh');
    }
    G.fila = selecionadas().sort((a, b) => a.codigo.localeCompare(b.codigo));
    G.i = Math.max(0, G.fila.findIndex((t) => !t.gravada));
    $('#shBody').innerHTML = `<div class="stack">
      <p>${G.fila.length} ${G.fila.length === 1 ? 'plaquinha' : 'plaquinhas'} na fila${G.fila.some((t) => t.gravada) ? ` · começa pela primeira ainda não gravada` : ''}.</p>
      <label class="check"><input type="checkbox" id="gBloq" checked> Bloquear cada etiqueta depois de gravar (definitivo: ninguém consegue regravar)</label>
      <p class="muted" style="font-size:13.5px">Ponha a plaquinha com o código indicado atrás do celular. Grave com o QR já impresso ao lado, para o NFC e o QR terem o mesmo código.</p>
      <button type="button" class="btn btn-cobalt btn-block" data-gravar="iniciar">${icon('nfc')} Começar</button>
    </div>`;
    openSheet('sh');
  }

  function telaGravar(msg = '', tom = '') {
    const t = G.fila[G.i];
    if (!t) {
      pararGravar();
      $('#shBody').innerHTML = `<div class="stack gravar-fim">${icon('check')}<h3>Fila concluída</h3><p>${G.fila.length} ${G.fila.length === 1 ? 'plaquinha processada' : 'plaquinhas processadas'}.</p>
        <button type="button" class="btn btn-quiet btn-block" data-close>Fechar</button></div>`;
      return;
    }
    $('#shBody').innerHTML = `<div class="stack gravar">
      <p class="gravar-prog">${G.i + 1} de ${G.fila.length}</p>
      <div class="gravar-cod"><small>Encoste a plaquinha</small><b class="mono">${t.codigo}</b></div>
      <p class="gravar-msg ${tom}" aria-live="polite">${esc(msg || (G.ocupado ? 'Gravando… mantenha encostada.' : 'Aguardando a etiqueta…'))}</p>
      <div class="acts">
        <button type="button" class="btn btn-line btn-sm" data-gravar="pular">Pular</button>
        <button type="button" class="btn btn-quiet btn-sm" data-gravar="parar">Parar</button>
      </div>
    </div>`;
  }

  async function iniciarGravar() {
    G.bloquear = $('#gBloq').checked;
    G.ultimaSerie = null;
    G.ultimoLink = null;
    G.ctrl = new AbortController();
    G.reader = new NDEFReader();
    try {
      await G.reader.scan({ signal: G.ctrl.signal });
    } catch (e) {
      return telaGravar(e.name === 'NotAllowedError' ? 'Permita o uso de NFC para este site.' : `NFC indisponível: ${e.message}`, 'is-erro');
    }
    G.reader.onreadingerror = () => telaGravar('Não deu para ler. Afaste e encoste de novo.', 'is-erro');
    G.reader.onreading = (ev) => gravarEtiqueta(ev);
    telaGravar();
  }

  async function gravarEtiqueta(ev) {
    const t = G.fila[G.i];
    if (!t || G.ocupado) return;
    const serie = ev.serialNumber || '';
    const link = (ev.message.records || []).map((r) => {
      try { return r.recordType === 'url' ? new TextDecoder().decode(r.data) : ''; } catch { return ''; }
    }).find(Boolean) || '';
    // A mesma etiqueta ainda encostada depois de gravar: ignora.
    if ((serie && serie === G.ultimaSerie) || (!serie && link && link === G.ultimoLink)) return;
    const meu = tagUrl(t.codigo);
    const outro = link && /\/t\/[A-Z0-9]+|[?&]c=[A-Z0-9]+/.test(link) && link !== meu;
    if (outro) return telaGravar(`Esta etiqueta já tem outro código (${link.split(/[/=]/).pop()}). Use uma etiqueta nova.`, 'is-erro');
    G.ocupado = true;
    telaGravar();
    try {
      if (link !== meu) await G.reader.write({ records: [{ recordType: 'url', data: meu }] });
      if (G.bloquear) await G.reader.makeReadOnly();
      await api.marcarGravadas([t.codigo], true);
      t.gravada = true;
      G.ultimaSerie = serie;
      G.ultimoLink = meu;
      navigator.vibrate && navigator.vibrate(60);
      G.i++;
      G.ocupado = false;
      telaGravar(`${t.codigo} gravada${G.bloquear ? ' e bloqueada' : ''}. Afaste e encoste a próxima.`, 'is-ok');
    } catch (e) {
      G.ocupado = false;
      telaGravar(`Falhou: ${e.message}. Afaste e encoste de novo.`, 'is-erro');
    }
  }

  function pararGravar() {
    G.ctrl && G.ctrl.abort();
    G.ctrl = null;
    G.reader = null;
    G.ocupado = false;
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
    const ed = t.closest('[data-editar]');
    if (ed) return abrirRest(ed.dataset.editar);
    const vr = t.closest('[data-ver-rest]');
    if (vr) { Object.assign(S, { view: 'plaquinhas', rest: vr.dataset.verRest, filtro: 'todas', lote: '', busca: '' }); return render(); }
    const ver = t.closest('[data-ver]');
    if (ver) return verTag(ver.dataset.ver);
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
      if (g.dataset.gravar === 'pular') { G.i++; G.ultimaSerie = null; return telaGravar(); }
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
        await api.salvarRestaurante({ ...(S.editRest ? { id: S.editRest } : {}), nome, destino, observacao: $('#rObs').value.trim() || null, ativo: $('#rAtivo').checked });
        closeSheet();
        toast('Restaurante salvo.', { tone: 'ok' });
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

  $('#sh').addEventListener('sheet:close', () => G.ctrl && pararGravar());

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
