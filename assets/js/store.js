/*
 * Camada de dados. Mesma interface para os dois backends:
 *
 *   init()                       → prepara conexão
 *   subscribe(fn)                → fn() a cada mudança em chamados/comentários
 *   watchCall(id, fn)            → fn(chamado) quando um chamado específico muda
 *   listCalls({ desde })         → chamados criados depois de `desde` (Date)
 *   getCall(id) / updateCall(id, patch)          (equipe)
 *
 *   Plaquinhas e sino liberado pela equipe:
 *   mesaDaEtiqueta(codigo)       → nº da mesa ligada à plaquinha, ou null
 *   sessaoAbrir({ mesa, nome, codigo }) → { token, status, mesa, nome, codigo }
 *   sessaoStatus(token) / sessaoSair(token)
 *   chamar(token, dados)         → chamado criado (só com o sino liberado; erro.code 'BLOQUEADO')
 *   cancelarChamado(token, id)
 *   listSessoes({ desde }) / decidirSessao(id, liberar) / fecharMesa(mesa) / listMesasAbertas()   (equipe)
 *   listEtiquetas() / vincularEtiqueta(codigo, mesa) / desvincularEtiqueta(codigo)                (equipe)
 *
 *   listFeedback() / createFeedback(d) / updateFeedback(id, patch)
 *   getSettings() / updateSettings(patch)
 *                                → restaurante, wifi, cardápio, mesas e widgets (editados no painel)
 *   uploadImage(blob, nome)      → URL pública da imagem (logo, capa)
 *   auth.estado()                → { temSenha } — se a senha da equipe já foi criada
 *   auth.entrar(pin) / auth.cadastrar({ nome, pin, senhaEquipe }) / auth.sessao() / auth.sair()
 *   auth.membros() / auth.remover(id) / auth.trocarSenha(senha)
 */
(function () {
  const cfg = window.NFC_CONFIG;
  const uid = () =>
    (crypto.randomUUID && crypto.randomUUID()) ||
    Date.now().toString(36) + Math.random().toString(36).slice(2);
  const nowIso = () => new Date().toISOString();

  // Valores iniciais, usados enquanto a equipe ainda não salvou nada pelo painel.
  const seed = () => ({
    restaurante: cfg.restaurante,
    wifi: cfg.wifi,
    cardapio: cfg.cardapio,
    mesas: cfg.mesasPadrao,
    widgets: cfg.widgetsPadrao,
  });
  // Completa o que foi salvo com os valores iniciais (campos novos em versões futuras).
  const mergeSettings = (saved) => {
    const base = seed();
    const out = { ...base };
    for (const k of Object.keys(base)) {
      const v = saved && saved[k];
      if (v == null) continue;
      out[k] = Array.isArray(v) || typeof v !== 'object' ? v : { ...base[k], ...v };
    }
    return out;
  };
  const normCodigo = (c) => String(c || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const bloqueado = (msg) => Object.assign(new Error(msg || 'O sino não está liberado para este celular.'), { code: 'BLOQUEADO' });
  const blobToDataUrl = (blob) =>
    new Promise((ok, fail) => {
      const r = new FileReader();
      r.onload = () => ok(r.result);
      r.onerror = () => fail(r.error);
      r.readAsDataURL(blob);
    });

  /* ---------- Modo demonstração: localStorage + BroadcastChannel ---------- */
  function LocalAdapter() {
    const KEY = 'nfc-demo-db-v1';
    const listeners = new Set();
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel('nfc-demo') : null;
    const empty = () => ({ chamados: [], comentarios: [], configuracao: null, equipe: null, sessoes: [], mesasAbertas: {}, etiquetas: [] });

    const read = () => {
      try {
        return { ...empty(), ...(JSON.parse(localStorage.getItem(KEY)) || {}) };
      } catch {
        return empty();
      }
    };
    const emit = () => listeners.forEach((fn) => fn());
    const write = (db) => {
      try {
        localStorage.setItem(KEY, JSON.stringify(db));
      } catch {}
      emit();
      channel && channel.postMessage('changed');
    };

    if (channel) channel.onmessage = emit;
    window.addEventListener('storage', (e) => e.key === KEY && emit());

    const patchIn = (col, id, patch) => {
      const db = read();
      const row = db[col].find((r) => r.id === id);
      if (!row) throw new Error('Registro não encontrado');
      Object.assign(row, patch, { atualizado_em: nowIso() });
      write(db);
      return row;
    };

    // Mesmas regras de public.sessao_* do schema.sql, guardadas neste navegador.
    const HORA = 3600e3;
    const expira = (db) => {
      const agora = Date.now();
      for (const s of db.sessoes) {
        const venceu = (s.status === 'liberada' && agora - new Date(s.liberada_em) > 6 * HORA)
          || (s.status === 'pendente' && agora - new Date(s.criado_em) > HORA / 2);
        if (venceu) Object.assign(s, { status: 'encerrada', encerrada_em: nowIso() });
      }
      for (const m of Object.keys(db.mesasAbertas)) {
        if (!db.sessoes.some((s) => s.mesa === +m && s.status === 'liberada')) delete db.mesasAbertas[m];
      }
      db.sessoes = db.sessoes.filter((s) => agora - new Date(s.criado_em) < 24 * HORA);
    };
    const codigoDaMesa = (db, mesa) => {
      if (!db.mesasAbertas[mesa]) db.mesasAbertas[mesa] = { codigo: String(Math.floor(Math.random() * 10000)).padStart(4, '0'), aberta_em: nowIso() };
      return db.mesasAbertas[mesa].codigo;
    };
    const statusDe = (db, s) => s
      ? { status: s.status, mesa: s.mesa, nome: s.nome, codigo: s.status === 'liberada' ? (db.mesasAbertas[s.mesa] || {}).codigo || null : null }
      : { status: 'inexistente' };
    const publica = ({ token, ...s }) => s;
    const totalMesas = (db) => (db.configuracao && db.configuracao.mesas && db.configuracao.mesas.total) || 500;
    const tentativas = {};

    return {
      mode: 'local',
      async init() {},
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      watchCall(id, fn) {
        const run = () => fn(read().chamados.find((c) => c.id === id) || null);
        run();
        listeners.add(run);
        return () => listeners.delete(run);
      },
      async listCalls({ desde } = {}) {
        const t = desde ? desde.getTime() : 0;
        return read().chamados.filter((c) => new Date(c.criado_em).getTime() >= t);
      },
      async getCall(id) {
        return read().chamados.find((c) => c.id === id) || null;
      },
      // Só para o botão "Simular chamado" do painel em demonstração.
      async createCall(data) {
        const db = read();
        const row = { id: uid(), status: 'aberto', criado_em: nowIso(), atualizado_em: nowIso(), ...data };
        db.chamados.push(row);
        // Mantém a demonstração leve.
        db.chamados = db.chamados.slice(-400);
        write(db);
        return row;
      },
      async updateCall(id, patch) {
        return patchIn('chamados', id, patch);
      },

      async mesaDaEtiqueta(codigo) {
        const e = read().etiquetas.find((x) => x.codigo === normCodigo(codigo));
        return e ? e.mesa : null;
      },
      async sessaoAbrir({ mesa, nome, codigo }) {
        const db = read();
        expira(db);
        nome = String(nome || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        codigo = String(codigo || '').trim();
        if (!(mesa >= 1 && mesa <= totalMesas(db))) throw new Error('Mesa inválida.');
        if (!nome) throw new Error('Informe seu nome.');
        const t = (tentativas[mesa] = (tentativas[mesa] || []).filter((x) => Date.now() - x < 10 * 60e3));
        const s = { id: uid(), token: uid(), mesa, nome, status: 'pendente', via: null, liberada_por: null, criado_em: nowIso(), liberada_em: null, encerrada_em: null };
        if (codigo) {
          if (t.length >= 6) throw new Error('Muitas tentativas de código. Peça ao garçom para liberar.');
          t.push(Date.now());
          if (!db.mesasAbertas[mesa] || db.mesasAbertas[mesa].codigo !== codigo) throw new Error('Código da mesa incorreto.');
          Object.assign(s, { status: 'liberada', via: 'codigo', liberada_em: nowIso() });
        } else if (db.sessoes.filter((x) => x.mesa === mesa && x.status === 'pendente').length >= 4) {
          throw new Error('Já há pedidos aguardando nesta mesa. Aguarde o garçom.');
        }
        db.sessoes.push(s);
        write(db);
        return { ...statusDe(db, s), token: s.token };
      },
      async sessaoStatus(token) {
        const db = read();
        expira(db);
        return statusDe(db, db.sessoes.find((s) => s.token === token));
      },
      async sessaoSair(token) {
        const db = read();
        const s = db.sessoes.find((x) => x.token === token && (x.status === 'pendente' || x.status === 'liberada'));
        if (s) Object.assign(s, { status: 'encerrada', encerrada_em: nowIso() });
        expira(db);
        write(db);
      },
      async chamar(token, dados) {
        const db = read();
        expira(db);
        const s = db.sessoes.find((x) => x.token === token && x.status === 'liberada');
        if (!s) throw bloqueado();
        const recentes = db.chamados.filter((c) => c.mesa === s.mesa && Date.now() - new Date(c.criado_em) < 120e3);
        if (recentes.length >= 5) throw new Error('Muitos chamados desta mesa. Aguarde um instante.');
        return this.createCall({ ...dados, mesa: s.mesa, sessao_id: s.id });
      },
      async cancelarChamado(token, id) {
        const db = read();
        const s = db.sessoes.find((x) => x.token === token);
        const c = db.chamados.find((x) => x.id === id);
        if (!s || !c || c.sessao_id !== s.id || c.status !== 'aberto') return;
        return patchIn('chamados', id, { status: 'cancelado' });
      },
      async listSessoes({ desde } = {}) {
        const db = read();
        const t = desde ? desde.getTime() : 0;
        return db.sessoes.filter((s) => new Date(s.criado_em).getTime() >= t).map(publica);
      },
      async decidirSessao(id, liberar, por) {
        const db = read();
        const s = db.sessoes.find((x) => x.id === id && x.status === 'pendente');
        if (!s) return;
        Object.assign(s, liberar
          ? { status: 'liberada', via: 'equipe', liberada_em: nowIso(), liberada_por: por || null }
          : { status: 'recusada', liberada_por: por || null });
        if (liberar) codigoDaMesa(db, s.mesa);
        write(db);
      },
      async fecharMesa(mesa) {
        const db = read();
        db.sessoes.forEach((s) => {
          if (s.mesa === mesa && (s.status === 'pendente' || s.status === 'liberada')) Object.assign(s, { status: 'encerrada', encerrada_em: nowIso() });
        });
        delete db.mesasAbertas[mesa];
        write(db);
      },
      async listMesasAbertas() {
        const db = read();
        expira(db);
        return Object.entries(db.mesasAbertas).map(([mesa, m]) => ({ mesa: +mesa, ...m }));
      },
      async listEtiquetas() {
        return read().etiquetas.slice().sort((a, b) => a.mesa - b.mesa || a.codigo.localeCompare(b.codigo));
      },
      async vincularEtiqueta(codigo, mesa, por) {
        codigo = normCodigo(codigo);
        if (!/^[A-Z0-9]{4,16}$/.test(codigo)) throw new Error('Código de plaquinha inválido.');
        const db = read();
        db.etiquetas = db.etiquetas.filter((e) => e.codigo !== codigo);
        db.etiquetas.push({ codigo, mesa, vinculada_em: nowIso(), vinculada_por: por || null });
        write(db);
      },
      async desvincularEtiqueta(codigo) {
        const db = read();
        db.etiquetas = db.etiquetas.filter((e) => e.codigo !== normCodigo(codigo));
        write(db);
      },
      async listFeedback() {
        return read().comentarios.slice().reverse();
      },
      async createFeedback(data) {
        const db = read();
        const row = { id: uid(), lido: false, criado_em: nowIso(), ...data };
        db.comentarios.push(row);
        db.comentarios = db.comentarios.slice(-400);
        write(db);
        return row;
      },
      async updateFeedback(id, patch) {
        return patchIn('comentarios', id, patch);
      },
      async reset() {
        // Preserva a configuração do restaurante — só limpa chamados e comentários.
        const db = read();
        write({ ...empty(), configuracao: db.configuracao, equipe: db.equipe, etiquetas: db.etiquetas });
      },
      async getSettings() {
        return mergeSettings(read().configuracao);
      },
      async updateSettings(patch) {
        const db = read();
        const novo = { ...mergeSettings(db.configuracao), ...patch };
        try {
          localStorage.setItem(KEY, JSON.stringify({ ...db, configuracao: novo }));
        } catch {
          throw new Error('Sem espaço para salvar. Use imagens menores.');
        }
        emit();
        channel && channel.postMessage('changed');
        return novo;
      },
      async uploadImage(blob) {
        return blobToDataUrl(blob);
      },
      auth: equipeLocal(read, write),
    };
  }

  /* Equipe no modo demonstração: tudo neste navegador. */
  function equipeLocal(read, write) {
    const SESSAO = 'nfc-equipe-sessao';
    const hash = async (t) => {
      const txt = 'vtx-tap:' + t;
      if (crypto.subtle) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt));
        return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
      }
      let h = 0;
      for (const c of txt) h = (h * 31 + c.charCodeAt(0)) | 0;
      return String(h);
    };
    const equipe = () => read().equipe || { senhaHash: null, membros: [] };
    const salvar = (eq) => write({ ...read(), equipe: eq });
    const falha = (msg) => { throw new Error(msg); };
    const getSess = () => { try { return JSON.parse(localStorage.getItem(SESSAO)); } catch { return null; } };
    const abrir = (m) => { try { localStorage.setItem(SESSAO, JSON.stringify({ id: m.id })); } catch {} };

    return {
      async estado() {
        return { temSenha: !!equipe().senhaHash };
      },
      async entrar(pin) {
        if (!/^\d{4,8}$/.test(pin)) falha('O PIN tem de 4 a 8 números.');
        const h = await hash('pin:' + pin);
        const m = equipe().membros.find((x) => x.pinHash === h);
        if (!m) falha('PIN não encontrado. Confira ou crie sua conta.');
        abrir(m);
        return { nome: m.nome };
      },
      async cadastrar({ nome, pin, senhaEquipe }) {
        nome = String(nome || '').trim().slice(0, 60);
        if (!nome) falha('Informe seu nome.');
        if (!/^\d{4,8}$/.test(pin)) falha('O PIN precisa ter de 4 a 8 números.');
        if (String(senhaEquipe || '').length < 6) falha('A senha da equipe tem pelo menos 6 caracteres.');
        const eq = equipe();
        const pinHash = await hash('pin:' + pin);
        if (eq.membros.some((x) => x.pinHash === pinHash)) falha('Esse PIN já está em uso. Escolha outro.');
        const senhaHash = await hash('senha:' + senhaEquipe);
        const primeiraConta = !eq.senhaHash;
        if (!primeiraConta && eq.senhaHash !== senhaHash) falha('Senha da equipe incorreta. Peça a senha para a gerência.');
        const m = { id: uid(), nome, pinHash, criado_em: nowIso() };
        salvar({ senhaHash: eq.senhaHash || senhaHash, membros: [...eq.membros, m] });
        abrir(m);
        return { nome, primeiraConta };
      },
      async sessao() {
        const s = getSess();
        const m = s && equipe().membros.find((x) => x.id === s.id);
        return m ? { nome: m.nome, id: m.id } : null;
      },
      async sair() {
        try { localStorage.removeItem(SESSAO); } catch {}
      },
      async membros() {
        const s = getSess();
        return equipe().membros.map((m) => ({ id: m.id, nome: m.nome, criado_em: m.criado_em, voce: !!s && s.id === m.id }));
      },
      async remover(id) {
        const eq = equipe();
        salvar({ ...eq, membros: eq.membros.filter((m) => m.id !== id) });
      },
      async trocarSenha(senha) {
        if (String(senha || '').length < 6) falha('A senha da equipe precisa ter pelo menos 6 caracteres.');
        salvar({ ...equipe(), senhaHash: await hash('senha:' + senha) });
      },
    };
  }

  /* ---------- Modo produção: Supabase (Postgres + Realtime) ----------
     Um banco para todos os restaurantes: tudo é filtrado pelo restaurante
     deste endereço (subdomínio), e as regras do banco garantem o isolamento. */
  function SupabaseAdapter() {
    const { supabaseUrl, supabaseAnonKey, slug } = cfg.backend;
    const listeners = new Set();
    let sb;
    let rid = null;

    const loadScript = (src) =>
      new Promise((ok, fail) => {
        if (window.supabase) return ok();
        const s = document.createElement('script');
        s.src = src;
        s.onload = ok;
        s.onerror = () => fail(new Error('Falha ao carregar o Supabase'));
        document.head.appendChild(s);
      });
    const must = ({ data, error }) => {
      if (error) throw error;
      return data;
    };

    return {
      mode: 'supabase',
      async init({ realtimeAll = false } = {}) {
        await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js');
        sb = window.supabase.createClient(supabaseUrl, supabaseAnonKey);
        const r = slug ? must(await sb.rpc('restaurante_publico', { p_slug: slug })) : null;
        if (!r) throw Object.assign(new Error('Restaurante não encontrado.'), { code: 'SEM_RESTAURANTE' });
        rid = r.id;
        this.restaurante = { id: r.id, slug: r.slug, nome: r.nome };
        if (realtimeAll) {
          const ch = sb.channel('painel-' + rid);
          for (const table of ['chamados', 'comentarios', 'sessoes', 'mesas_abertas', 'etiquetas']) {
            ch.on('postgres_changes', { event: '*', schema: 'public', table, filter: 'restaurante_id=eq.' + rid }, () => listeners.forEach((f) => f()));
          }
          ch.subscribe();
        }
      },
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      watchCall(id, fn) {
        this.getCall(id).then(fn).catch(() => fn(null));
        const ch = sb
          .channel('chamado-' + id)
          .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chamados', filter: 'id=eq.' + id }, (p) => fn(p.new))
          .subscribe();
        return () => sb.removeChannel(ch);
      },
      async listCalls({ desde } = {}) {
        let q = sb.from('chamados').select('*').eq('restaurante_id', rid).order('criado_em', { ascending: true });
        if (desde) q = q.gte('criado_em', desde.toISOString());
        return must(await q);
      },
      async getCall(id) {
        return must(await sb.from('chamados').select('*').eq('id', id).maybeSingle());
      },
      async updateCall(id, patch) {
        must(await sb.from('chamados').update({ ...patch, atualizado_em: nowIso() }).eq('id', id));
      },

      async mesaDaEtiqueta(codigo) {
        return must(await sb.rpc('mesa_da_etiqueta', { p_restaurante: rid, p_codigo: normCodigo(codigo) })) || null;
      },
      async sessaoAbrir({ mesa, nome, codigo }) {
        return must(await sb.rpc('sessao_abrir', { p_restaurante: rid, p_mesa: mesa, p_nome: nome, p_codigo: codigo || null }));
      },
      async sessaoStatus(token) {
        return must(await sb.rpc('sessao_status', { p_token: token }));
      },
      async sessaoSair(token) {
        must(await sb.rpc('sessao_sair', { p_token: token }));
      },
      async chamar(token, dados) {
        const { data, error } = await sb.rpc('chamar', {
          p_token: token,
          p_tipo: dados.tipo,
          p_nota: dados.nota || null,
          p_pagamento: dados.pagamento || null,
          p_itens: dados.itens || null,
        });
        if (error) throw error.code === 'VT401' ? bloqueado(error.message) : error;
        return { id: data, status: 'aberto', criado_em: nowIso(), ...dados };
      },
      async cancelarChamado(token, id) {
        must(await sb.rpc('chamado_cancelar', { p_token: token, p_id: id }));
      },
      async listSessoes({ desde } = {}) {
        let q = sb.from('sessoes').select('id, mesa, nome, status, via, liberada_por, criado_em, liberada_em, encerrada_em').eq('restaurante_id', rid).order('criado_em', { ascending: true });
        if (desde) q = q.gte('criado_em', desde.toISOString());
        return must(await q);
      },
      async decidirSessao(id, liberar) {
        must(await sb.rpc('sessao_decidir', { p_id: id, p_liberar: !!liberar }));
      },
      async fecharMesa(mesa) {
        must(await sb.rpc('mesa_fechar', { p_mesa: mesa }));
      },
      async listMesasAbertas() {
        return must(await sb.from('mesas_abertas').select('mesa, codigo, aberta_em').eq('restaurante_id', rid));
      },
      async listEtiquetas() {
        return must(await sb.from('etiquetas').select('codigo, mesa, vinculada_em, vinculada_por, ativada_em').eq('restaurante_id', rid).order('mesa').order('codigo'));
      },
      async vincularEtiqueta(codigo, mesa) {
        codigo = normCodigo(codigo);
        if (!/^[A-Z0-9]{4,16}$/.test(codigo)) throw new Error('Código de plaquinha inválido.');
        must(await sb.rpc('etiqueta_vincular', { p_codigo: codigo, p_mesa: mesa }));
      },
      async desvincularEtiqueta(codigo) {
        must(await sb.rpc('etiqueta_desvincular', { p_codigo: normCodigo(codigo) }));
      },
      async listFeedback() {
        return must(await sb.from('comentarios').select('*').eq('restaurante_id', rid).order('criado_em', { ascending: false }).limit(300));
      },
      async createFeedback(data) {
        must(await sb.from('comentarios').insert({ ...data, restaurante_id: rid }));
      },
      async updateFeedback(id, patch) {
        must(await sb.from('comentarios').update(patch).eq('id', id));
      },
      async getSettings() {
        const row = must(await sb.rpc('restaurante_publico', { p_slug: slug }));
        const s = mergeSettings(row);
        // Nome cadastrado na central até a equipe definir o dela.
        if (row && !(row.restaurante && row.restaurante.nome)) s.restaurante = { ...s.restaurante, nome: row.nome };
        return s;
      },
      async updateSettings(patch) {
        must(await sb.rpc('salvar_config', { p_patch: patch }));
        return this.getSettings();
      },
      async uploadImage(blob, nome) {
        const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
        const path = `${rid}/${nome}-${Date.now()}.${ext}`;
        must(await sb.storage.from('marca').upload(path, blob, { contentType: blob.type, cacheControl: '31536000', upsert: false }));
        return sb.storage.from('marca').getPublicUrl(path).data.publicUrl;
      },
      auth: {
        // Cadastro e login passam pela função "equipe" do Supabase, que confere PIN e senha da equipe.
        async chamar(acao, dados = {}, logado = false) {
          if (!rid) throw new Error('Sem conexão com o servidor. Confira a internet e recarregue a página.');
          const token = logado ? (await sb.auth.getSession()).data.session?.access_token : null;
          let r;
          try {
            r = await fetch(`${supabaseUrl}/functions/v1/equipe`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', apikey: supabaseAnonKey, Authorization: `Bearer ${token || supabaseAnonKey}` },
              body: JSON.stringify({ acao, restaurante: rid, ...dados }),
            });
          } catch {
            throw new Error('Sem conexão com o servidor. Confira a internet e tente de novo.');
          }
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.erro || 'Não foi possível concluir agora. Tente de novo.');
          return j;
        },
        async estado() {
          return this.chamar('estado');
        },
        async entrar(pin) {
          const r = await this.chamar('entrar', { pin });
          must(await sb.auth.setSession(r.sessao));
          return { nome: r.nome };
        },
        async cadastrar({ nome, pin, senhaEquipe }) {
          const r = await this.chamar('cadastrar', { nome, pin, senhaEquipe });
          must(await sb.auth.setSession(r.sessao));
          return { nome: r.nome, primeiraConta: r.primeiraConta };
        },
        async sessao() {
          const { data } = await sb.auth.getSession();
          if (!data.session) return null;
          // Confere no servidor: quem foi removido da equipe perde o acesso.
          const { data: u, error } = await sb.auth.getUser();
          if (error || !u.user) {
            await sb.auth.signOut();
            return null;
          }
          return { nome: (u.user.user_metadata && u.user.user_metadata.nome) || 'Equipe', id: u.user.id };
        },
        async sair() {
          await sb.auth.signOut();
        },
        async membros() {
          return (await this.chamar('membros', {}, true)).membros;
        },
        async remover(id) {
          await this.chamar('remover', { id }, true);
        },
        async trocarSenha(senha) {
          await this.chamar('trocar_senha', { senha }, true);
        },
      },
    };
  }

  window.Store = {
    create() {
      const b = cfg.backend || {};
      if (b.tipo === 'supabase' && b.supabaseUrl && b.supabaseAnonKey) return SupabaseAdapter();
      return LocalAdapter();
    },
  };
})();
