/*
 * Camada de dados. Mesma interface para os dois backends:
 *
 *   init()                       → prepara conexão
 *   subscribe(fn)                → fn() a cada mudança em chamados/comentários
 *   watchCall(id, fn)            → fn(chamado) quando um chamado específico muda
 *   listCalls({ desde })         → chamados criados depois de `desde` (Date)
 *   getCall(id) / createCall(d) / updateCall(id, patch)
 *   listFeedback() / createFeedback(d) / updateFeedback(id, patch)
 *   auth.*                       → login da equipe (apenas Supabase)
 */
(function () {
  const cfg = window.NFC_CONFIG;
  const uid = () =>
    (crypto.randomUUID && crypto.randomUUID()) ||
    Date.now().toString(36) + Math.random().toString(36).slice(2);
  const nowIso = () => new Date().toISOString();

  /* ---------- Modo demonstração: localStorage + BroadcastChannel ---------- */
  function LocalAdapter() {
    const KEY = 'nfc-demo-db-v1';
    const listeners = new Set();
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel('nfc-demo') : null;
    const empty = () => ({ chamados: [], comentarios: [], configuracao: null });

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
        // Preserva a configuração (mesas e widgets) — só limpa chamados e comentários.
        write({ ...empty(), configuracao: read().configuracao });
      },
      async getSettings() {
        const db = read();
        if (db.configuracao) return db.configuracao;
        const seed = { mesas: cfg.mesasPadrao, widgets: cfg.widgetsPadrao };
        write({ ...db, configuracao: seed });
        return seed;
      },
      async updateSettings(patch) {
        const db = read();
        const atual = db.configuracao || { mesas: cfg.mesasPadrao, widgets: cfg.widgetsPadrao };
        const novo = { ...atual, ...patch };
        write({ ...db, configuracao: novo });
        return novo;
      },
      auth: null,
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
        const row = must(await sb.from('configuracao').select('mesas, widgets').eq('id', 'geral').maybeSingle());
        if (row) return row;
        const seed = { mesas: cfg.mesasPadrao, widgets: cfg.widgetsPadrao };
        // Sem RLS de insert para anon nesta tabela: só a equipe semeia na primeira vez que abre o painel.
        try { must(await sb.from('configuracao').upsert({ id: 'geral', ...seed })); } catch {}
        return seed;
      },
      async updateSettings(patch) {
        must(await sb.from('configuracao').upsert({ id: 'geral', ...patch }));
        return this.getSettings();
      },
      auth: {
        async session() {
          return (await sb.auth.getSession()).data.session;
        },
        async signIn(email, password) {
          must(await sb.auth.signInWithPassword({ email, password }));
        },
        async signOut() {
          await sb.auth.signOut();
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
