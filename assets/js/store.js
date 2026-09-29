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
 *   listEtiquetas() / vincularEtiqueta(codigo, mesa) / desvincularEtiqueta(codigo) (equipe)
 *
 *   listFeedback() / createFeedback(d) / updateFeedback(id, patch)
 *   getSettings() / updateSettings(patch)
 *                                → restaurante, wifi, cardápio, mesas e widgets (editados no painel)
 *   uploadImage(blob, nome)      → URL pública da imagem (logo, capa)
 *   auth.estado()                → { temSenha } — se a senha da equipe já foi criada
 *   auth.entrar(pin) / auth.cadastrar({ nome, pin, senhaEquipe }) / auth.sessao() / auth.sair()
 *   auth.membros() / auth.remover(id) / auth.trocarSenha(senha)
 *
 *   Programa de fidelidade (módulo liberado pela Vortex; regras em settings.fidelidade):
 *   cliente: fidPrograma() / fidConsultar(cpf) / fidIndicador(codigo) / fidCadastrar(dados) /
 *            fidEntrar(cpf, pin) / fidConta(token) / fidSair(token) /
 *            fidRegistrarNota({ cpf, qr, valor }) / fidResgatar(token, premioId)
 *            → sempre { status, ... } (status 'erro' traz a mensagem)
 *   equipe:  fidResumo() / fidPendencias() / fidClientes(busca) / fidCliente(cpf) / fidRecentes() /
 *            fidAprovarNota(chave, valor, emitidaIso) / fidRecusarNota(chave, motivo) /
 *            fidImportarXml(notas) / fidResgateDecidir(id, entregar) / fidLancar(cpf, valor, descricao) /
 *            fidRedefinirPin(cpf) / fidExcluirCliente(cpf) / fidEditarCliente(cpf, dados) /
 *            fidPremios() / fidSalvarPremio(p) / fidExcluirPremio(id) / fidExportar()
 *            → erros viram exceção com a mensagem
 */
(function () {
  const cfg = window.NFC_CONFIG;
  const uid = () =>
    (crypto.randomUUID && crypto.randomUUID()) ||
    Date.now().toString(36) + Math.random().toString(36).slice(2);
  const nowIso = () => new Date().toISOString();

  /* ---------- Fidelidade: regras puras (as mesmas de public.fid_* no schema.sql) ---------- */
  const FID_PADRAO = {
    ativo: false, nome: 'Clube de pontos', pontosPorReal: 1, boosts: [], cnpjs: [], prazoDias: 7, inicio: null,
    manual: false, regulamento: '', fuso: 'America/Sao_Paulo', indicacao: { ativo: true, indicador: 50, indicado: 20 },
    niveis: { ativo: false, base: 'sempre', meses: 12, lista: [] },
  };
  const soDigitos = (s) => String(s || '').replace(/\D/g, '');
  function cpfValido(c) {
    c = soDigitos(c);
    if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
    for (const n of [9, 10]) {
      let s = 0;
      for (let i = 0; i < n; i++) s += +c[i] * (n + 1 - i);
      if (((s * 10) % 11) % 10 !== +c[n]) return false;
    }
    return true;
  }
  function chaveValida(k) {
    if (!/^\d{44}$/.test(k || '')) return false;
    let s = 0;
    let w = 2;
    for (let i = 42; i >= 0; i--) {
      s += +k[i] * w;
      w = w === 9 ? 2 : w + 1;
    }
    let dv = 11 - (s % 11);
    if (dv >= 10) dv = 0;
    const mes = +k.slice(4, 6);
    return dv === +k[43] && mes >= 1 && mes <= 12;
  }
  // Chave de acesso dentro do texto do QR (URL da SEFAZ) ou digitada com espaços.
  const chaveDoTexto = (t) => (String(t || '').replace(/[\s.-]/g, '').match(/\d{44}/) || [])[0] || null;
  const minutos = (hhmm) => (/^\d{1,2}:\d{2}$/.test(hhmm || '') ? +hhmm.split(':')[0] * 60 + +hhmm.split(':')[1] : null);
  const diaIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // Maior multiplicador que vale no momento (hora local do aparelho).
  function fidBoost(regras, quando) {
    const d = new Date(quando);
    const dia = d.getDay();
    const min = d.getHours() * 60 + d.getMinutes();
    let melhor = { mult: 1, nome: null };
    for (const b of regras.boosts || []) {
      if (b.ativo === false) continue;
      const m = Math.min(Math.max(Number(b.mult) || 1, 1), 10);
      if (m <= melhor.mult) continue;
      if (/^\d{4}-\d{2}-\d{2}$/.test(b.inicio || '') && diaIso(d) < b.inicio) continue;
      if (/^\d{4}-\d{2}-\d{2}$/.test(b.fim || '') && diaIso(d) > b.fim) continue;
      const dias = Array.isArray(b.dias) ? b.dias.map(Number) : [];
      const noDia = (x) => !dias.length || dias.includes(x);
      const ini = minutos(b.de);
      const fim = minutos(b.ate);
      const ok = ini == null || fim == null
        ? noDia(dia)
        : fim > ini
          ? noDia(dia) && min >= ini && min < fim
          : (noDia(dia) && min >= ini) || (noDia((dia + 6) % 7) && min < fim);
      if (ok) melhor = { mult: m, nome: String(b.nome || '').trim().slice(0, 60) || null };
    }
    return melhor;
  }
  // Pontos de uma compra: valor x pontos por real x dia com mais pontos x bônus do nível.
  function fidCalcular(regras, valor, quando, nivel = null) {
    const ppr = Math.min(Math.max(Number(regras.pontosPorReal) || 0, 0), 1000);
    const b = fidBoost(regras, quando);
    const mn = nivel ? nivel.mult : 1;
    const m = Math.round(b.mult * mn * 100) / 100;
    return { pontos: Math.floor(Math.max(Number(valor) || 0, 0) * ppr * m + 1e-9), mult: m, boost: b.nome, nivel: mn > 1 ? nivel.nome : null };
  }
  // Níveis do clube (mesma arrumação de public.fid_niveis): ordem pelo mínimo, o primeiro começa em 0.
  function fidNiveis(regras) {
    const n = regras && regras.niveis;
    if (!n || !n.ativo || !Array.isArray(n.lista)) return [];
    const lista = n.lista.slice(0, 6).filter((x) => x && String(x.nome || '').trim() && /[A-Za-z0-9]/.test(x.id || ''))
      .map((x) => ({
        id: String(x.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24), nome: String(x.nome).trim().slice(0, 30),
        descricao: String(x.descricao || '').trim().slice(0, 80), cor: /^#[0-9a-f]{6}$/i.test(x.cor || '') ? x.cor : '#8C6416',
        minimo: Math.round(Math.min(Math.max(+x.minimo || 0, 0), 1e7)), mult: Math.round(Math.min(Math.max(+x.mult || 1, 1), 5) * 100) / 100,
        bonus: Math.round(Math.min(Math.max(+x.bonus || 0, 0), 1e5)),
        beneficios: (Array.isArray(x.beneficios) ? x.beneficios : []).map((b) => String(b).trim().slice(0, 80)).filter(Boolean).slice(0, 8),
      }))
      .sort((a, b) => a.minimo - b.minimo);
    if (lista.length) lista[0].minimo = 0;
    return lista;
  }
  // Nível para uma quantidade de pontos de nível, com quanto falta para o próximo.
  function fidNivelDe(lista, pontosNivel) {
    if (!lista.length) return null;
    let i = 0;
    while (i + 1 < lista.length && lista[i + 1].minimo <= pontosNivel) i++;
    const prox = lista[i + 1];
    return { ...lista[i], indice: i, pontos_nivel: pontosNivel,
      proximo: prox ? { id: prox.id, nome: prox.nome, cor: prox.cor, minimo: prox.minimo, falta: prox.minimo - pontosNivel } : null };
  }
  // Na demonstração o programa já vem no ar, para dar para experimentar.
  const FID_DEMO = {
    ativo: true, nome: 'Clube de pontos', pontosPorReal: 1,
    boosts: [
      { id: 'b1', nome: 'Terça em dobro', mult: 2, dias: [2], de: '', ate: '', inicio: '', fim: '', ativo: true },
      { id: 'b2', nome: 'Happy hour', mult: 1.5, dias: [1, 2, 3, 4, 5], de: '17:00', ate: '19:00', inicio: '', fim: '', ativo: true },
    ],
    regulamento: 'Demonstração: 1 ponto a cada R$ 1 gasto com CPF na nota. Os pontos valem por 12 meses.',
    niveis: {
      ativo: true, base: 'sempre', meses: 12,
      lista: [
        { id: 'bronze', nome: 'Bronze', descricao: 'Todo mundo começa aqui', cor: '#b45309', minimo: 0, mult: 1, bonus: 0, beneficios: ['Pontos em todas as compras'] },
        { id: 'prata', nome: 'Prata', descricao: 'Cliente da casa', cor: '#64748b', minimo: 300, mult: 1.1, bonus: 30, beneficios: ['Sobremesa no aniversário'] },
        { id: 'ouro', nome: 'Ouro', descricao: 'Os mais fiéis', cor: '#ca8a04', minimo: 1000, mult: 1.25, bonus: 100, beneficios: ['Prêmios exclusivos', 'Mesa garantida no fim de semana'] },
      ],
    },
  };
  const mergeFid = (f) => ({
    ...FID_PADRAO, ...(f || {}),
    indicacao: { ...FID_PADRAO.indicacao, ...((f && f.indicacao) || {}) },
    niveis: { ...FID_PADRAO.niveis, ...((f && f.niveis) || {}) },
  });

  // Valores iniciais, usados enquanto a equipe ainda não salvou nada pelo painel.
  const seed = () => ({
    restaurante: cfg.restaurante,
    wifi: cfg.wifi,
    cardapio: cfg.cardapio,
    mesas: cfg.mesasPadrao,
    widgets: cfg.widgetsPadrao,
  });
  // Completa o que foi salvo com os valores iniciais (campos novos em versões futuras).
  // Módulos: na demonstração vêm todos liberados; no servidor, a central libera.
  const mergeSettings = (saved, demo = false) => {
    const base = seed();
    const out = { ...base };
    for (const k of Object.keys(base)) {
      const v = saved && saved[k];
      if (v == null) continue;
      out[k] = Array.isArray(v) || typeof v !== 'object' ? v : { ...base[k], ...v };
    }
    out.modulos = { ...(demo ? { fidelidade: true } : {}), ...((saved && saved.modulos) || {}) };
    out.fidelidade = mergeFid(saved && saved.fidelidade ? saved.fidelidade : demo ? FID_DEMO : null);
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
    const empty = () => ({ chamados: [], comentarios: [], configuracao: null, equipe: null, sessoes: [], mesasAbertas: {}, etiquetas: [], fid: null });

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

    /* Fidelidade na demonstração: mesmas regras de public.fid_*, guardadas neste navegador. */
    const F = (db) => (db.fid = db.fid || {
      clientes: [], movimentos: [], notas: [], xml: [], resgates: [], pins: {}, sessoes: {},
      premios: [
        { id: 'p1', nome: 'Caipirinha da casa', descricao: 'Limão, morango ou maracujá.', pontos: 150, imagem: null, ativo: true, ordem: 1, criado_em: nowIso() },
        { id: 'p2', nome: 'Sobremesa do dia', descricao: '', pontos: 220, imagem: null, ativo: true, ordem: 2, criado_em: nowIso() },
        { id: 'p3', nome: 'Porção de fritas', descricao: 'Com maionese da casa.', pontos: 300, imagem: null, ativo: true, ordem: 3, criado_em: nowIso() },
        { id: 'p4', nome: 'Drink autoral', descricao: 'Criação do bartender.', pontos: 400, imagem: null, ativo: true, ordem: 4, nivel_min: 'ouro', criado_em: nowIso() },
      ],
    });
    const regras = (db) => mergeSettings(db.configuracao, true).fidelidade;
    const noAr = (db) => { const s = mergeSettings(db.configuracao, true); return !!(s.modulos.fidelidade && s.fidelidade.ativo); };
    const hashTxt = async (t) => {
      if (!crypto.subtle) return 'h' + [...t].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('vtx-fid:' + t));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    };
    const brlTxt = (v) => 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const cliDe = (db, cpf) => F(db).clientes.find((c) => c.cpf === cpf);
    const prazo = (db) => Math.min(Math.max(Number(regras(db).prazoDias) || 7, 1), 365);
    const inicio = (db) => (/^\d{4}-\d{2}-\d{2}$/.test(regras(db).inicio || '') ? new Date(regras(db).inicio + 'T00:00:00') : null);
    const DIA = 864e5;
    function mover(db, cpf, tipo, pontos, extra = {}) {
      F(db).movimentos.push({ id: uid(), cpf, tipo, pontos, criado_em: nowIso(), valor: null, mult: null, descricao: null, nota_chave: null, resgate_id: null, por: null, ...extra });
      const c = cliDe(db, cpf);
      if (c) c.pontos += pontos;
      if (['compra', 'manual', 'estorno', 'ajuste'].includes(tipo)) atualizarNivel(db, cpf);
    }
    // Pontos que contam para o nível (compras, com estornos e ajustes), desde sempre ou nos últimos N meses.
    function pontosNivel(db, cpf) {
      const n = regras(db).niveis || {};
      const desde = n.base === 'meses' ? Date.now() - Math.min(Math.max(+n.meses || 12, 1), 60) * 30.44 * DIA : 0;
      return Math.max(F(db).movimentos.filter((m) => m.cpf === cpf && new Date(m.criado_em) > desde
        && (['compra', 'manual'].includes(m.tipo) || (['estorno', 'ajuste'].includes(m.tipo) && !m.resgate_id)))
        .reduce((t, m) => t + m.pontos, 0), 0);
    }
    const nivelDe = (db, cpf) => fidNivelDe(fidNiveis(regras(db)), pontosNivel(db, cpf));
    function atualizarNivel(db, cpf, bonus = true) {
      const c = cliDe(db, cpf);
      const nv = nivelDe(db, cpf);
      if (!c) return nv;
      c.nivel = nv ? nv.id : null;
      if (!nv || !bonus) return nv;
      c.niveis_bonus = c.niveis_bonus || [];
      for (const l of fidNiveis(regras(db))) {
        if (l.minimo <= nv.pontos_nivel && l.bonus > 0 && !c.niveis_bonus.includes(l.id)) {
          c.niveis_bonus.push(l.id);
          mover(db, cpf, 'nivel', l.bonus, { descricao: `Bônus: chegou ao nível ${l.nome}` });
        }
      }
      return nv;
    }
    const multTxt = (m) => String(m).replace('.', ',');
    function bonusIndicacao(db, cpf) {
      const r = regras(db).indicacao || {};
      const c = cliDe(db, cpf);
      if (!r.ativo || !c || !c.indicado_por || c.bonus_indicacao) return;
      c.bonus_indicacao = true;
      if (+r.indicado > 0) mover(db, cpf, 'boas_vindas', +r.indicado, { descricao: 'Bônus de boas-vindas (indicação)' });
      if (+r.indicador > 0 && cliDe(db, c.indicado_por)) {
        mover(db, c.indicado_por, 'indicacao', +r.indicador, { descricao: `Indicação: ${c.nome.split(' ')[0]} fez a primeira compra` });
      }
    }
    function creditar(db, n, valor, emitida, por) {
      if (!n || n.status !== 'pendente') return null;
      const calc = fidCalcular(regras(db), valor, emitida || n.lida_em, nivelDe(db, n.cpf));
      Object.assign(n, { status: 'creditada', valor, emitida_em: emitida || n.emitida_em || n.lida_em, pontos: calc.pontos, mult: calc.mult, conferida_em: nowIso(), conferida_por: por, motivo: null });
      mover(db, n.cpf, 'compra', calc.pontos, {
        descricao: `Compra de ${brlTxt(valor)}${calc.boost ? ` · ${calc.boost}` : ''}${calc.nivel ? ` · nível ${calc.nivel}` : ''}${calc.mult > 1 ? ` (${multTxt(calc.mult)}x)` : ''}`,
        valor, mult: calc.mult, nota_chave: n.chave, por,
      });
      bonusIndicacao(db, n.cpf);
      return calc.pontos;
    }
    function conferirXml(db, chave) {
      const f = F(db);
      const n = f.notas.find((x) => x.chave === chave);
      if (!n) return { status: 'inexistente' };
      if (n.status !== 'pendente') return { status: n.status, pontos: n.pontos };
      const x = f.xml.find((y) => y.chave === chave);
      if (!x || (!x.cancelada && (x.valor == null || !x.emitida_em))) return { status: 'pendente' };
      if (!x.cancelada && (!x.cpf || x.cpf !== n.cpf)) {
        f.notas = f.notas.filter((y) => y.chave !== chave);
        return { status: 'recusada', motivo: x.cpf ? 'O CPF desta nota é de outra pessoa.' : 'A nota foi emitida sem CPF. Peça o CPF na nota da próxima vez.' };
      }
      const ini = inicio(db);
      const motivo = x.cancelada ? 'Esta nota foi cancelada.'
        : ini && new Date(x.emitida_em) < ini ? 'A compra foi antes do início do programa.'
        : new Date(n.lida_em) - new Date(x.emitida_em) > prazo(db) * DIA ? `A nota foi registrada depois do prazo de ${prazo(db)} dias.` : null;
      if (motivo) {
        Object.assign(n, { status: 'recusada', motivo, valor: x.valor, emitida_em: x.emitida_em, conferida_em: nowIso(), conferida_por: 'XML da nota' });
        return { status: 'recusada', motivo };
      }
      return { status: 'creditada', pontos: creditar(db, n, x.valor, x.emitida_em, 'XML da nota'), valor: x.valor };
    }
    function autoCreditar(db, chave) {
      const f = F(db);
      const x = f.xml.find((y) => y.chave === chave);
      if (!x || x.cancelada || !x.cpf || x.valor == null || !x.emitida_em || f.notas.some((n) => n.chave === chave)) return null;
      const c = cliDe(db, x.cpf);
      if (!c) return { status: 'sem_cadastro' };
      const ini = inicio(db);
      if ((ini && new Date(x.emitida_em) < ini) || new Date(x.emitida_em) < new Date(c.criado_em) - prazo(db) * DIA) return null;
      f.notas.push({ chave, cpf: x.cpf, url: null, status: 'pendente', valor_informado: null, valor: null, emitida_em: null, pontos: null, mult: null, lida_em: x.emitida_em, lida_por: 'XML da nota', conferida_em: null, conferida_por: null, motivo: null });
      return conferirXml(db, chave);
    }
    function chaveProblema(db, chave) {
      const r = regras(db);
      if (!chaveValida(chave)) return 'Chave de acesso inválida. Confira os 44 números da nota.';
      if (!['65', '59'].includes(chave.slice(20, 22))) return 'Esta não é uma nota fiscal de consumidor (NFC-e).';
      // Demonstração sem CNPJ cadastrado: aceita a nota de qualquer lugar.
      if ((r.cnpjs || []).length && !r.cnpjs.includes(chave.slice(6, 20))) return 'Esta nota é de outro estabelecimento.';
      const mes = new Date(2000 + +chave.slice(2, 4), +chave.slice(4, 6) - 1, 1);
      const fimMes = new Date(mes.getFullYear(), mes.getMonth() + 1, 1);
      if (mes > new Date()) return 'Chave de acesso inválida. Confira os 44 números da nota.';
      if (+fimMes + prazo(db) * DIA < Date.now()) return 'Esta nota passou do prazo para ganhar pontos.';
      const ini = inicio(db);
      if (ini && fimMes <= ini) return 'A compra foi antes do início do programa.';
      return null;
    }
    const sessaoDe = (db, token) => {
      const s = token && F(db).sessoes[token];
      return s && cliDe(db, s) ? s : null;
    };
    const falha = (m) => { throw new Error(m); };
    const quem = (db) => {
      try {
        const s = JSON.parse(localStorage.getItem('nfc-equipe-sessao')) || {};
        const m = ((db.equipe || {}).membros || []).find((x) => x.id === s.id);
        return m ? m.nome : 'Equipe';
      } catch {
        return 'Equipe';
      }
    };
    const comNome = (db, row) => ({ ...row, fid_clientes: (({ nome, telefone }) => ({ nome, telefone }))(cliDe(db, row.cpf) || { nome: '—', telefone: '' }) });

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
        const e = db.etiquetas.find((x) => x.codigo === normCodigo(codigo));
        if (e) Object.assign(e, { mesa: null, vinculada_em: null, vinculada_por: null });
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
        return mergeSettings(read().configuracao, true);
      },
      async updateSettings(patch) {
        const db = read();
        if (patch.fidelidade && patch.fidelidade.ativo && !(patch.fidelidade.cnpjs || []).length) {
          throw new Error('Informe o CNPJ que sai nas notas fiscais antes de ativar o programa.');
        }
        const novo = { ...mergeSettings(db.configuracao, true), ...patch };
        db.configuracao = novo;
        // Regras novas: atualiza o nível guardado de cada cliente.
        if (patch.fidelidade) F(db).clientes.forEach((c) => atualizarNivel(db, c.cpf, false));
        try {
          localStorage.setItem(KEY, JSON.stringify(db));
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

      /* ---------- Fidelidade: cliente ---------- */
      async fidPrograma() {
        const db = read();
        if (!noAr(db)) return { ativo: false };
        const r = regras(db);
        const hoje = diaIso(new Date());
        return {
          ativo: true, nome: r.nome || 'Clube de pontos', pontosPorReal: +r.pontosPorReal || 0, prazoDias: prazo(db), regulamento: r.regulamento || '',
          indicacao: r.indicacao && r.indicacao.ativo ? { ativo: true, indicador: +r.indicacao.indicador || 0, indicado: +r.indicacao.indicado || 0 } : { ativo: false },
          boosts: (r.boosts || []).filter((b) => b.ativo !== false && +b.mult > 1 && !(b.fim && b.fim < hoje))
            .map(({ nome, mult, dias, de, ate, inicio: ini, fim }) => ({ nome, mult: +mult, dias: dias || [], de: de || '', ate: ate || '', inicio: ini || '', fim: fim || '' })),
          niveis: fidNiveis(r).length ? { ativo: true, base: r.niveis.base === 'meses' ? 'meses' : 'sempre', meses: Math.min(Math.max(+r.niveis.meses || 12, 1), 60), lista: fidNiveis(r) } : { ativo: false },
          premios: F(db).premios.filter((p) => p.ativo).sort((a, b) => a.ordem - b.ordem || a.pontos - b.pontos)
            .map(({ id, nome, descricao, pontos, imagem, nivel_min }) => ({ id, nome, descricao, pontos, imagem, nivel_min: nivel_min || null })),
        };
      },
      async fidConsultar(cpf) {
        const db = read();
        cpf = soDigitos(cpf);
        if (!noAr(db)) return { status: 'inativo' };
        if (!cpfValido(cpf)) return { status: 'erro', mensagem: 'CPF inválido. Confira os números.' };
        const c = cliDe(db, cpf);
        if (!c) return { status: 'novo' };
        return { status: 'ok', nome: c.nome.split(' ')[0], pontos: c.pontos, nivel: nivelDe(db, cpf), pendentes: F(db).notas.filter((n) => n.cpf === cpf && n.status === 'pendente').length, tem_pin: !!F(db).pins[cpf] };
      },
      async fidIndicador(codigo) {
        const c = F(read()).clientes.find((x) => x.codigo === String(codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
        return c ? { status: 'ok', nome: c.nome.split(' ')[0] } : { status: 'nao' };
      },
      async fidCadastrar({ cpf, nome, email, telefone, pin, marketing, indicacao }) {
        const db = read();
        if (!noAr(db)) return { status: 'inativo' };
        cpf = soDigitos(cpf);
        nome = String(nome || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        email = String(email || '').trim().toLowerCase();
        telefone = soDigitos(telefone);
        if ([12, 13].includes(telefone.length) && telefone.startsWith('55')) telefone = telefone.slice(2);
        const erro = !cpfValido(cpf) ? 'CPF inválido. Confira os números.'
          : !/^\S{2,}( \S+)+$/.test(nome) ? 'Informe seu nome completo (nome e sobrenome).'
          : email.length > 120 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? 'E-mail inválido.'
          : !/^[1-9]\d{9,10}$/.test(telefone) ? 'Telefone inválido. Use DDD + número.'
          : !/^\d{4}$/.test(pin || '') ? 'O PIN tem 4 números.' : null;
        if (erro) return { status: 'erro', mensagem: erro };
        const f = F(db);
        if (cliDe(db, cpf)) return { status: 'erro', mensagem: 'Este CPF já tem cadastro. Entre com o seu PIN.', existe: true };
        let indicado_por = null;
        const ind = String(indicacao || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (ind && regras(db).indicacao.ativo) {
          const quemIndicou = f.clientes.find((x) => x.codigo === ind);
          if (!quemIndicou) return { status: 'erro', mensagem: 'Código de indicação não encontrado. Confira ou deixe em branco.' };
          indicado_por = quemIndicou.cpf;
        }
        const ALF = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
        let codigo;
        do codigo = Array.from({ length: 6 }, () => ALF[Math.floor(Math.random() * ALF.length)]).join('');
        while (f.clientes.some((x) => x.codigo === codigo));
        f.clientes.push({ cpf, nome, email, telefone, pontos: 0, codigo, indicado_por, bonus_indicacao: false, marketing: !!marketing, criado_em: nowIso() });
        f.pins[cpf] = await hashTxt(cpf + ':' + pin);
        f.xml.filter((x) => x.cpf === cpf).forEach((x) => autoCreditar(db, x.chave));
        const token = uid();
        f.sessoes[token] = cpf;
        write(db);
        return { status: 'ok', token };
      },
      async fidEntrar(cpf, pin) {
        const db = read();
        cpf = soDigitos(cpf);
        if (!noAr(db)) return { status: 'inativo' };
        if (!cpfValido(cpf)) return { status: 'erro', mensagem: 'CPF inválido. Confira os números.' };
        if (!/^\d{4}$/.test(pin || '')) return { status: 'erro', mensagem: 'O PIN tem 4 números.' };
        if (!cliDe(db, cpf)) return { status: 'novo' };
        const f = F(db);
        const h = await hashTxt(cpf + ':' + pin);
        const novo = !f.pins[cpf];
        if (novo) f.pins[cpf] = h;
        else if (f.pins[cpf] !== h) return { status: 'erro', mensagem: 'PIN incorreto.' };
        const token = uid();
        f.sessoes[token] = cpf;
        write(db);
        return { status: 'ok', token, pin_novo: novo };
      },
      async fidConta(token) {
        const db = read();
        const cpf = sessaoDe(db, token);
        if (!cpf) return { status: 'sem_sessao' };
        const f = F(db);
        const c = cliDe(db, cpf);
        const desc = (a, b) => (a < b ? 1 : a > b ? -1 : 0);
        const nivel = atualizarNivel(db, cpf, false);
        write(db);
        return {
          status: 'ok', ...c, nivel, indicacoes: f.clientes.filter((x) => x.indicado_por === cpf).length,
          notas: f.notas.filter((n) => n.cpf === cpf).sort((a, b) => desc(a.lida_em, b.lida_em)).slice(0, 20)
            .map((n) => ({ chave: n.chave, status: n.status, valor: n.valor ?? n.valor_informado, pontos: n.pontos, lida_em: n.lida_em, motivo: n.motivo })),
          movimentos: f.movimentos.filter((m) => m.cpf === cpf).slice(-40).reverse()
            .map(({ tipo, pontos, descricao, criado_em }) => ({ tipo, pontos, descricao, criado_em })),
          resgates: f.resgates.filter((x) => x.cpf === cpf && (x.status === 'pendente' || Date.now() - new Date(x.criado_em) < 60 * DIA))
            .sort((a, b) => desc(a.criado_em, b.criado_em)).slice(0, 15)
            .map((x) => ({ id: x.id, premio: x.premio_nome, pontos: x.pontos, codigo: x.codigo, status: x.status, criado_em: x.criado_em })),
        };
      },
      async fidSair(token) {
        const db = read();
        delete F(db).sessoes[token];
        write(db);
      },
      async fidRegistrarNota({ cpf, qr, valor }) {
        const db = read();
        if (!noAr(db)) return { status: 'inativo' };
        cpf = soDigitos(cpf);
        if (!cpfValido(cpf)) return { status: 'erro', mensagem: 'CPF inválido. Confira os números.' };
        if (!cliDe(db, cpf)) return { status: 'sem_cadastro' };
        const chave = chaveDoTexto(qr);
        if (!chave) return { status: 'erro', mensagem: 'Não achamos a chave da nota. Leia o QR Code impresso na nota fiscal.' };
        const prob = chaveProblema(db, chave);
        if (prob) return { status: 'erro', mensagem: prob };
        const f = F(db);
        const n = f.notas.find((x) => x.chave === chave);
        if (n) return n.cpf !== cpf ? { status: 'erro', mensagem: 'Esta nota já foi registrada em outra conta.' } : { status: 'repetida', nota: n.status, pontos: n.pontos, motivo: n.motivo };
        const url = /^https?:\/\/[a-z0-9.-]+\.gov\.br\//i.test(String(qr).trim()) ? String(qr).trim().slice(0, 600) : null;
        f.notas.push({ chave, cpf, url, status: 'pendente', valor_informado: valor > 0 && valor < 1e5 ? Math.round(valor * 100) / 100 : null, valor: null, emitida_em: null, pontos: null, mult: null, lida_em: nowIso(), lida_por: 'Cliente', conferida_em: null, conferida_por: null, motivo: null });
        const r = f.xml.some((x) => x.chave === chave) ? conferirXml(db, chave) : { status: 'pendente' };
        write(db);
        return r;
      },
      async fidResgatar(token, premioId) {
        const db = read();
        const cpf = sessaoDe(db, token);
        if (!cpf) return { status: 'sem_sessao' };
        if (!noAr(db)) return { status: 'inativo' };
        const f = F(db);
        const p = f.premios.find((x) => x.id === premioId && x.ativo);
        if (!p) return { status: 'erro', mensagem: 'Este prêmio não está mais disponível.' };
        // Prêmio exclusivo de um nível (se o nível não existe mais, vale para todos).
        const lista = fidNiveis(regras(db));
        const iMin = p.nivel_min ? lista.findIndex((l) => l.id === p.nivel_min) : -1;
        if (iMin >= 0 && ((nivelDe(db, cpf) || {}).indice ?? -1) < iMin) {
          return { status: 'erro', mensagem: `Este prêmio é exclusivo do nível ${lista[iMin].nome} em diante.` };
        }
        const c = cliDe(db, cpf);
        if (c.pontos < p.pontos) return { status: 'erro', mensagem: `Faltam ${p.pontos - c.pontos} pontos para este prêmio.` };
        if (f.resgates.filter((x) => x.cpf === cpf && x.status === 'pendente').length >= 3) {
          return { status: 'erro', mensagem: 'Você já tem 3 resgates esperando a entrega. Mostre os códigos ao garçom.' };
        }
        const x = { id: uid(), cpf, premio_id: p.id, premio_nome: p.nome, pontos: p.pontos, codigo: String(Math.floor(Math.random() * 1e4)).padStart(4, '0'), status: 'pendente', criado_em: nowIso(), resolvido_em: null, resolvido_por: null };
        f.resgates.push(x);
        mover(db, cpf, 'resgate', -p.pontos, { descricao: `Resgate: ${p.nome}`, resgate_id: x.id, por: 'Cliente' });
        write(db);
        return { status: 'ok', pontos: c.pontos, resgate: { id: x.id, premio: p.nome, pontos: p.pontos, codigo: x.codigo, status: 'pendente', criado_em: x.criado_em } };
      },

      /* ---------- Fidelidade: equipe ---------- */
      async fidResumo() {
        const db = read();
        const f = F(db);
        const mes = Date.now() - 30 * DIA;
        const cred = f.notas.filter((n) => n.status === 'creditada' && new Date(n.emitida_em) > mes);
        return {
          clientes: f.clientes.length, novos_30d: f.clientes.filter((c) => new Date(c.criado_em) > mes).length,
          pontos: f.clientes.reduce((t, c) => t + Math.max(c.pontos, 0), 0),
          notas_pendentes: f.notas.filter((n) => n.status === 'pendente').length,
          resgates_pendentes: f.resgates.filter((x) => x.status === 'pendente').length,
          compras_30d: cred.length, valor_30d: cred.reduce((t, n) => t + (+n.valor || 0), 0),
          entregues_30d: f.resgates.filter((x) => x.status === 'entregue' && new Date(x.resolvido_em) > mes).length,
          ultimo_xml: f.xml.map((x) => x.importada_em).sort().pop() || null,
        };
      },
      async fidPendencias() {
        const db = read();
        const f = F(db);
        return {
          notas: f.notas.filter((n) => n.status === 'pendente').sort((a, b) => (a.lida_em < b.lida_em ? 1 : -1)).map((n) => comNome(db, n)),
          resgates: f.resgates.filter((x) => x.status === 'pendente').sort((a, b) => (a.criado_em > b.criado_em ? 1 : -1)).map((x) => comNome(db, x)),
        };
      },
      async fidClientes(busca = '') {
        const f = F(read());
        const b = String(busca || '').trim().toLowerCase();
        const d = soDigitos(b);
        return f.clientes
          .filter((c) => !b || (d && d.length >= 3 ? c.cpf.includes(d) || c.telefone.includes(d) : c.nome.toLowerCase().includes(b)))
          .sort((a, c) => (a.criado_em < c.criado_em ? 1 : -1)).slice(0, 300);
      },
      async fidCliente(cpf) {
        const db = read();
        const f = F(db);
        const c = cliDe(db, cpf);
        if (!c) return null;
        return {
          cliente: { ...c, nivel_atual: atualizarNivel(db, cpf, false), tem_pin: !!f.pins[cpf], indicado_por_nome: c.indicado_por ? (cliDe(db, c.indicado_por) || {}).nome || null : null },
          movimentos: f.movimentos.filter((m) => m.cpf === cpf).slice(-60).reverse(),
          notas: f.notas.filter((n) => n.cpf === cpf).sort((a, b) => (a.lida_em < b.lida_em ? 1 : -1)).slice(0, 40),
          resgates: f.resgates.filter((x) => x.cpf === cpf).sort((a, b) => (a.criado_em < b.criado_em ? 1 : -1)).slice(0, 30),
        };
      },
      async fidRecentes() {
        const db = read();
        return F(db).movimentos.slice(-40).reverse().map((m) => comNome(db, m));
      },
      async fidAprovarNota(chave, valor, emitida) {
        const db = read();
        const n = F(db).notas.find((x) => x.chave === chave);
        if (!n || n.status !== 'pendente') falha('Esta nota não está mais esperando conferência.');
        if (!(valor > 0 && valor < 1e5)) falha('Informe o valor total da nota.');
        const pts = creditar(db, n, Math.round(valor * 100) / 100, emitida || n.lida_em, quem(db));
        write(db);
        return pts;
      },
      async fidRecusarNota(chave, motivo) {
        const db = read();
        const n = F(db).notas.find((x) => x.chave === chave && x.status === 'pendente');
        if (!n) falha('Esta nota não está mais esperando conferência.');
        Object.assign(n, { status: 'recusada', motivo: String(motivo || '').trim().slice(0, 160) || 'Recusada pela equipe.', conferida_em: nowIso(), conferida_por: quem(db) });
        write(db);
      },
      async fidImportarXml(notas) {
        const db = read();
        const f = F(db);
        const r = regras(db);
        const k = { recebidas: 0, invalidas: 0, outro_cnpj: 0, creditadas: 0, pontos: 0, recusadas: 0, canceladas: 0, estornadas: 0, sem_cadastro: 0, sem_cpf: 0, ja_conferidas: 0, ajustadas: 0 };
        const conta = (st) => {
          if (!st) return;
          if (st.status === 'creditada') { k.creditadas++; k.pontos += st.pontos || 0; }
          else if (st.status === 'recusada') k.recusadas++;
          else if (st.status === 'sem_cadastro') k.sem_cadastro++;
        };
        for (const it of notas || []) {
          k.recebidas++;
          if (!chaveValida(it.chave)) { k.invalidas++; continue; }
          if (!(r.cnpjs || []).includes(it.chave.slice(6, 20))) { k.outro_cnpj++; continue; }
          let x = f.xml.find((y) => y.chave === it.chave);
          if (it.cancelada) {
            if (x) x.cancelada = true;
            else f.xml.push({ chave: it.chave, cpf: null, valor: null, emitida_em: null, cancelada: true, importada_em: nowIso(), importada_por: quem(db) });
            k.canceladas++;
            const n = f.notas.find((y) => y.chave === it.chave);
            if (n && n.status === 'creditada') {
              Object.assign(n, { status: 'estornada', motivo: 'Nota cancelada pelo restaurante.' });
              mover(db, n.cpf, 'estorno', -(n.pontos || 0), { descricao: `Nota cancelada: ${brlTxt(n.valor)}`, valor: n.valor, nota_chave: n.chave, por: quem(db) });
              k.estornadas++;
            } else if (n && n.status === 'pendente') conferirXml(db, it.chave);
            continue;
          }
          const cpf = cpfValido(it.cpf) ? soDigitos(it.cpf) : null;
          const valor = Number(it.valor);
          if (!(valor >= 0) || !it.emitida_em || isNaN(new Date(it.emitida_em))) { k.invalidas++; continue; }
          if (x) Object.assign(x, { cpf, valor, emitida_em: it.emitida_em, importada_em: nowIso() });
          else f.xml.push((x = { chave: it.chave, cpf, valor: Math.round(valor * 100) / 100, emitida_em: it.emitida_em, cancelada: false, importada_em: nowIso(), importada_por: quem(db) }));
          if (!cpf) k.sem_cpf++;
          const n = f.notas.find((y) => y.chave === it.chave);
          if (n && n.status === 'pendente') {
            let st = conferirXml(db, it.chave);
            if (st.status === 'recusada' && cpf && !f.notas.some((y) => y.chave === it.chave)) st = autoCreditar(db, it.chave) || st;
            conta(st);
          } else if (n && n.status === 'creditada' && n.conferida_por !== 'XML da nota') {
            if (cpf !== n.cpf) {
              Object.assign(n, { status: 'estornada', motivo: 'O CPF do XML é diferente do cadastro.', conferida_em: nowIso(), conferida_por: 'XML da nota' });
              mover(db, n.cpf, 'ajuste', -(n.pontos || 0), { descricao: 'Ajuste pelo XML: a nota tem outro CPF', valor: n.valor, nota_chave: n.chave, por: quem(db) });
              k.ajustadas++;
              if (cpf) {
                f.notas = f.notas.filter((y) => y.chave !== it.chave);
                conta(autoCreditar(db, it.chave));
              }
              continue;
            }
            const calc = fidCalcular(r, x.valor, x.emitida_em, nivelDe(db, n.cpf));
            const dif = calc.pontos - (n.pontos || 0);
            const antes = n.valor;
            Object.assign(n, { valor: x.valor, emitida_em: x.emitida_em, pontos: calc.pontos, mult: calc.mult, conferida_em: nowIso(), conferida_por: 'XML da nota' });
            if (dif) {
              mover(db, n.cpf, 'ajuste', dif, { descricao: `Ajuste pelo XML: valor da nota ${brlTxt(x.valor)} (lançado ${brlTxt(antes)})`, valor: x.valor, mult: calc.mult, nota_chave: n.chave, por: quem(db) });
              k.ajustadas++;
            }
            k.ja_conferidas++;
          } else if (n) k.ja_conferidas++;
          else if (cpf) conta(autoCreditar(db, it.chave));
        }
        write(db);
        return k;
      },
      async fidResgateDecidir(id, entregar) {
        const db = read();
        const x = F(db).resgates.find((y) => y.id === id && y.status === 'pendente');
        if (!x) falha('Este resgate já foi resolvido.');
        Object.assign(x, { status: entregar ? 'entregue' : 'cancelado', resolvido_em: nowIso(), resolvido_por: quem(db) });
        if (!entregar) mover(db, x.cpf, 'estorno', x.pontos, { descricao: `Resgate cancelado: ${x.premio_nome}`, resgate_id: x.id, por: quem(db) });
        write(db);
      },
      async fidLancar(cpf, valor, descricao) {
        const db = read();
        const r = regras(db);
        if (!noAr(db)) falha('O programa de fidelidade não está ativo.');
        if (!r.manual) falha('O lançamento manual está desligado nas regras do programa.');
        if (!cliDe(db, cpf)) falha('Cliente não encontrado.');
        if (!(valor > 0 && valor < 1e5)) falha('Informe o valor da compra.');
        descricao = String(descricao || '').trim().slice(0, 100);
        if (!descricao) falha('Informe o motivo (ex.: pedido do delivery nº 123).');
        const calc = fidCalcular(r, valor, nowIso(), nivelDe(db, cpf));
        mover(db, cpf, 'manual', calc.pontos, { descricao: `Lançado: ${descricao} · ${brlTxt(valor)}`, valor, mult: calc.mult, por: quem(db) });
        bonusIndicacao(db, cpf);
        write(db);
        return calc.pontos;
      },
      async fidRedefinirPin(cpf) {
        const db = read();
        const f = F(db);
        delete f.pins[cpf];
        for (const [t, c] of Object.entries(f.sessoes)) if (c === cpf) delete f.sessoes[t];
        write(db);
      },
      async fidExcluirCliente(cpf) {
        const db = read();
        const f = F(db);
        f.clientes.forEach((c) => { if (c.indicado_por === cpf) c.indicado_por = null; });
        f.clientes = f.clientes.filter((c) => c.cpf !== cpf);
        for (const col of ['movimentos', 'notas', 'resgates']) f[col] = f[col].filter((x) => x.cpf !== cpf);
        delete f.pins[cpf];
        for (const [t, c] of Object.entries(f.sessoes)) if (c === cpf) delete f.sessoes[t];
        write(db);
      },
      async fidEditarCliente(cpf, { nome, email, telefone, marketing }) {
        const db = read();
        const c = cliDe(db, cpf);
        if (!c) falha('Cliente não encontrado.');
        nome = String(nome || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        email = String(email || '').trim().toLowerCase();
        telefone = soDigitos(telefone);
        if (!/^\S{2,}( \S+)+$/.test(nome)) falha('Informe o nome completo.');
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) falha('E-mail inválido.');
        if (!/^[1-9]\d{9,10}$/.test(telefone)) falha('Telefone inválido. Use DDD + número.');
        Object.assign(c, { nome, email, telefone, marketing: marketing == null ? c.marketing : !!marketing });
        write(db);
      },
      async fidPremios() {
        return F(read()).premios.slice().sort((a, b) => a.ordem - b.ordem || a.pontos - b.pontos);
      },
      async fidSalvarPremio(p) {
        const db = read();
        const f = F(db);
        const dados = { nome: String(p.nome || '').trim().slice(0, 60), descricao: String(p.descricao || '').trim().slice(0, 160), pontos: Math.round(+p.pontos), imagem: p.imagem || '', ativo: p.ativo !== false, ordem: +p.ordem || 0, nivel_min: p.nivel_min || null };
        if (!dados.nome) falha('Informe o nome do prêmio.');
        if (!(dados.pontos >= 1 && dados.pontos <= 1e6)) falha('Informe quantos pontos vale o prêmio.');
        const atual = p.id && f.premios.find((x) => x.id === p.id);
        if (atual) Object.assign(atual, dados);
        else f.premios.push({ id: uid(), criado_em: nowIso(), ...dados });
        try {
          localStorage.setItem(KEY, JSON.stringify(db));
        } catch {
          throw new Error('Sem espaço para salvar. Use imagens menores.');
        }
        emit();
        channel && channel.postMessage('changed');
      },
      async fidExcluirPremio(id) {
        const db = read();
        F(db).premios = F(db).premios.filter((x) => x.id !== id);
        write(db);
      },
      async fidExportar() {
        return F(read()).clientes.slice();
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
          for (const table of ['chamados', 'comentarios', 'sessoes', 'mesas_abertas', 'etiquetas', 'fid_notas', 'fid_resgates']) {
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
        const s = mergeSettings(row, false);
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

      /* ---------- Fidelidade: cliente (funções do banco que devolvem { status }) ---------- */
      async fidPrograma() {
        return must(await sb.rpc('fid_programa', { p_restaurante: rid }));
      },
      async fidConsultar(cpf) {
        return must(await sb.rpc('fid_consultar', { p_restaurante: rid, p_cpf: soDigitos(cpf) }));
      },
      async fidIndicador(codigo) {
        return must(await sb.rpc('fid_indicador', { p_restaurante: rid, p_codigo: codigo }));
      },
      async fidCadastrar({ cpf, nome, email, telefone, pin, marketing, indicacao }) {
        return must(await sb.rpc('fid_cadastrar', {
          p_restaurante: rid, p_cpf: soDigitos(cpf), p_nome: nome, p_email: email, p_telefone: telefone,
          p_pin: pin, p_marketing: !!marketing, p_indicacao: indicacao || null,
        }));
      },
      async fidEntrar(cpf, pin) {
        return must(await sb.rpc('fid_entrar', { p_restaurante: rid, p_cpf: soDigitos(cpf), p_pin: pin }));
      },
      async fidConta(token) {
        return must(await sb.rpc('fid_conta', { p_token: token }));
      },
      async fidSair(token) {
        must(await sb.rpc('fid_sair', { p_token: token }));
      },
      async fidRegistrarNota({ cpf, qr, valor }) {
        return must(await sb.rpc('fid_registrar_nota', { p_restaurante: rid, p_cpf: soDigitos(cpf), p_qr: qr, p_valor: valor || null }));
      },
      async fidResgatar(token, premioId) {
        return must(await sb.rpc('fid_resgatar', { p_token: token, p_premio: premioId }));
      },

      /* ---------- Fidelidade: equipe (leitura pelas regras de acesso, mudanças pelas funções) ---------- */
      async fidResumo() {
        return must(await sb.rpc('fid_resumo'));
      },
      async fidPendencias() {
        const [notas, resgates] = await Promise.all([
          sb.from('fid_notas').select('chave, cpf, url, valor_informado, lida_em, lida_por, fid_clientes(nome, telefone)')
            .eq('restaurante_id', rid).eq('status', 'pendente').order('lida_em', { ascending: false }).limit(200),
          sb.from('fid_resgates').select('id, cpf, premio_nome, pontos, codigo, criado_em, fid_clientes(nome, telefone)')
            .eq('restaurante_id', rid).eq('status', 'pendente').order('criado_em').limit(200),
        ]);
        return { notas: must(notas), resgates: must(resgates) };
      },
      async fidClientes(busca = '') {
        let q = sb.from('fid_clientes').select('cpf, nome, email, telefone, pontos, codigo, marketing, criado_em, indicado_por, nivel')
          .eq('restaurante_id', rid).order('criado_em', { ascending: false }).limit(300);
        const b = String(busca || '').trim();
        const d = soDigitos(b);
        if (d.length >= 3) q = q.or(`cpf.like.*${d}*,telefone.like.*${d}*`);
        else if (b) q = q.ilike('nome', `%${b.replace(/[%_,()*\\]/g, ' ').trim()}%`);
        return must(await q);
      },
      async fidCliente(cpf) {
        const [c, m, n, x] = await Promise.all([
          sb.from('fid_clientes').select('*').eq('restaurante_id', rid).eq('cpf', cpf).maybeSingle(),
          sb.from('fid_movimentos').select('*').eq('restaurante_id', rid).eq('cpf', cpf).order('criado_em', { ascending: false }).order('id', { ascending: false }).limit(60),
          sb.from('fid_notas').select('*').eq('restaurante_id', rid).eq('cpf', cpf).order('lida_em', { ascending: false }).limit(40),
          sb.from('fid_resgates').select('*').eq('restaurante_id', rid).eq('cpf', cpf).order('criado_em', { ascending: false }).limit(30),
        ]);
        const cliente = must(c);
        if (!cliente) return null;
        cliente.nivel_atual = must(await sb.rpc('fid_nivel_cliente', { p_cpf: cpf }));
        if (cliente.indicado_por) {
          const i = must(await sb.from('fid_clientes').select('nome').eq('restaurante_id', rid).eq('cpf', cliente.indicado_por).maybeSingle());
          cliente.indicado_por_nome = i ? i.nome : null;
        }
        return { cliente, movimentos: must(m), notas: must(n), resgates: must(x) };
      },
      async fidRecentes() {
        return must(await sb.from('fid_movimentos').select('*, fid_clientes(nome, telefone)').eq('restaurante_id', rid)
          .order('criado_em', { ascending: false }).order('id', { ascending: false }).limit(40));
      },
      async fidAprovarNota(chave, valor, emitida) {
        return must(await sb.rpc('fid_aprovar_nota', { p_chave: chave, p_valor: valor, p_emitida: emitida || null }));
      },
      async fidRecusarNota(chave, motivo) {
        must(await sb.rpc('fid_recusar_nota', { p_chave: chave, p_motivo: motivo || '' }));
      },
      async fidImportarXml(notas) {
        const total = {};
        for (let i = 0; i < notas.length; i += 400) {
          const r = must(await sb.rpc('fid_importar_xml', { p_notas: notas.slice(i, i + 400) }));
          for (const [k, v] of Object.entries(r)) total[k] = (total[k] || 0) + v;
        }
        return total;
      },
      async fidResgateDecidir(id, entregar) {
        must(await sb.rpc('fid_resgate_decidir', { p_id: id, p_entregar: !!entregar }));
      },
      async fidLancar(cpf, valor, descricao) {
        return must(await sb.rpc('fid_lancar', { p_cpf: cpf, p_valor: valor, p_descricao: descricao }));
      },
      async fidRedefinirPin(cpf) {
        must(await sb.rpc('fid_redefinir_pin', { p_cpf: cpf }));
      },
      async fidExcluirCliente(cpf) {
        must(await sb.rpc('fid_excluir_cliente', { p_cpf: cpf }));
      },
      async fidEditarCliente(cpf, { nome, email, telefone, marketing }) {
        must(await sb.rpc('fid_editar_cliente', { p_cpf: cpf, p_nome: nome, p_email: email, p_telefone: telefone, p_marketing: marketing == null ? null : !!marketing }));
      },
      async fidPremios() {
        return must(await sb.from('fid_premios').select('*').eq('restaurante_id', rid).order('ordem').order('pontos'));
      },
      async fidSalvarPremio(p) {
        const dados = {
          nome: String(p.nome || '').trim().slice(0, 60), descricao: String(p.descricao || '').trim().slice(0, 160),
          pontos: Math.round(+p.pontos), imagem: p.imagem || '', ativo: p.ativo !== false, ordem: +p.ordem || 0, nivel_min: p.nivel_min || null,
        };
        if (!dados.nome) throw new Error('Informe o nome do prêmio.');
        if (!(dados.pontos >= 1 && dados.pontos <= 1e6)) throw new Error('Informe quantos pontos vale o prêmio.');
        if (p.id) must(await sb.from('fid_premios').update(dados).eq('id', p.id));
        else must(await sb.from('fid_premios').insert({ ...dados, restaurante_id: rid }));
      },
      async fidExcluirPremio(id) {
        must(await sb.from('fid_premios').delete().eq('id', id));
      },
      async fidExportar() {
        const todos = [];
        for (let de = 0; ; de += 1000) {
          const parte = must(await sb.from('fid_clientes').select('cpf, nome, email, telefone, pontos, codigo, marketing, criado_em')
            .eq('restaurante_id', rid).order('criado_em').range(de, de + 999));
          todos.push(...parte);
          if (parte.length < 1000) return todos;
        }
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
    // Regras do programa de fidelidade usadas também pelas telas (validação e simulação).
    fid: { PADRAO: FID_PADRAO, cpfValido, chaveValida, chaveDoTexto, boost: fidBoost, calcular: fidCalcular, niveis: fidNiveis, nivelDe: fidNivelDe, soDigitos },
    create() {
      const b = cfg.backend || {};
      if (b.tipo === 'supabase' && b.supabaseUrl && b.supabaseAnonKey) return SupabaseAdapter();
      return LocalAdapter();
    },
  };
})();
