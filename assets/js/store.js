/*
 * Camada de dados. Mesma interface para os dois backends:
 *
 *   init()                       → prepara conexão
 *   subscribe(fn)                → fn() a cada mudança em chamados/comentários
 *   watchCall(id, fn)            → fn(chamado) quando um chamado específico muda
 *   listCalls({ desde })         → chamados criados depois de `desde` (Date)
 *   getCall(id) / createCall(d) / updateCall(id, patch)
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
    const empty = () => ({ chamados: [], comentarios: [], configuracao: null, equipe: null });

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
        write({ ...empty(), configuracao: db.configuracao, equipe: db.equipe });
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

  /* ---------- Modo produção: Supabase (Postgres + Realtime) ---------- */
  function SupabaseAdapter() {
    const { supabaseUrl, supabaseAnonKey } = cfg.backend;
    const listeners = new Set();
    let sb;

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
        if (realtimeAll) {
          sb.channel('painel')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'chamados' }, () => listeners.forEach((f) => f()))
            .on('postgres_changes', { event: '*', schema: 'public', table: 'comentarios' }, () => listeners.forEach((f) => f()))
            .subscribe();
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
        let q = sb.from('chamados').select('*').order('criado_em', { ascending: true });
        if (desde) q = q.gte('criado_em', desde.toISOString());
        return must(await q);
      },
      async getCall(id) {
        return must(await sb.from('chamados').select('*').eq('id', id).maybeSingle());
      },
      async createCall(data) {
        // O id é gerado aqui para que o cliente anônimo não precise ler a linha de volta.
        const row = { id: uid(), ...data };
        must(await sb.from('chamados').insert(row));
        return { ...row, status: 'aberto', criado_em: nowIso() };
      },
      async updateCall(id, patch) {
        must(await sb.from('chamados').update({ ...patch, atualizado_em: nowIso() }).eq('id', id));
      },
      async listFeedback() {
        return must(await sb.from('comentarios').select('*').order('criado_em', { ascending: false }).limit(300));
      },
      async createFeedback(data) {
        must(await sb.from('comentarios').insert(data));
      },
      async updateFeedback(id, patch) {
        must(await sb.from('comentarios').update(patch).eq('id', id));
      },
      async getSettings() {
        const row = must(await sb.from('configuracao').select('restaurante, wifi, cardapio, mesas, widgets').eq('id', 'geral').maybeSingle());
        return mergeSettings(row);
      },
      async updateSettings(patch) {
        must(await sb.from('configuracao').upsert({ id: 'geral', ...patch }));
        return this.getSettings();
      },
      async uploadImage(blob, nome) {
        const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
        const path = `${nome}-${Date.now()}.${ext}`;
        must(await sb.storage.from('marca').upload(path, blob, { contentType: blob.type, cacheControl: '31536000', upsert: false }));
        return sb.storage.from('marca').getPublicUrl(path).data.publicUrl;
      },
      auth: {
        // Cadastro e login passam pela função "equipe" do Supabase, que confere PIN e senha da equipe.
        async chamar(acao, dados = {}, logado = false) {
          const token = logado ? (await sb.auth.getSession()).data.session?.access_token : null;
          let r;
          try {
            r = await fetch(`${supabaseUrl}/functions/v1/equipe`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', apikey: supabaseAnonKey, Authorization: `Bearer ${token || supabaseAnonKey}` },
              body: JSON.stringify({ acao, ...dados }),
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
