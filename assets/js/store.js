/*
 * Camada de dados. Mesma interface para os dois backends:
 *
 *   init()                       → prepara conexão
 *   subscribe(fn)                → fn() a cada mudança em chamados/comentários
 *   watchCall(id, fn)            → fn(chamado) quando um chamado específico muda
 *   listCalls({ desde })         → chamados criados depois de `desde` (Date)
 *   getCall(id) / updateCall(id, patch)          (equipe)
 *
 *   Delivery: deliveryPedir(pedido) / deliveryAcompanhar(token)   (cliente)
 *             deliveryPedidos({ desde }) / deliveryMudar(id, status, entregador, motivo)   (equipe)
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
 *   auth.membros() / auth.remover(id) / auth.trocarSenha(senha)   (só administrador)
 *   auth.adicionar({ nome, pin, admin }) / auth.definirAdmin(id, admin) (só administrador) / auth.trocarPin(id|null, pin)
 *
 *   Programa de fidelidade (módulo liberado pela Vortex; regras em settings.fidelidade):
 *   cliente: fidPrograma() / fidConsultar(cpf) / fidIndicador(codigo) / fidCadastrar(dados) /
 *            fidEntrar(cpf, pin) / fidConta(token) / fidSair(token) /
 *            fidNotaSituacao({ cpf, qr }) / fidRegistrarNota({ cpf, qr, valor }) / fidSefaz({ cpf, qr }) / fidRanking(token) / fidResgatar(token, premioId) /
 *            fidDefinirAniversario(token, mes) / fidTransferirDestino(token, cpfOuCodigo) / fidTransferir(token, cpfOuCodigo, pontos, pin) /
 *            fidTorcer(token, eventoId, time)
 *            → sempre { status, ... } (status 'erro' traz a mensagem)
 *   equipe:  fidResumo() / fidPendencias() / fidClientes(busca) / fidCliente(cpf) / fidRecentes() /
 *            fidAprovarNota(chave, valor, emitidaIso) / fidRecusarNota(chave, motivo) /
 *            fidImportarXml(notas) / fidResgateDecidir(id, entregar) / fidLancar(cpf, valor, descricao) /
 *            fidRedefinirPin(cpf) / fidExcluirCliente(cpf) / fidEditarCliente(cpf, dados) /
 *            fidPremios() / fidSalvarPremio(p) / fidExcluirPremio(id) / fidExportar() / fidTopProdutos(cpf, dias) /
 *            fidEventos() / fidEventoSalvar(e) / fidEventoExcluir(id) / fidEventoResultado(id, vencedor|'empate')
 *            → erros viram exceção com a mensagem
 *
 *   Prorrogação (adicional; ajustes em settings.prorrogacao): happy hour que ganha minutos a cada chopp.
 *   todos:   hhStatus() → { disponivel, agora, nome, frase, produto, minutos, rodando, sessao, ultima_sessao, recorde, proxima }
 *   equipe:  hhPainel() (status + config, leituras, historico) / hhComecar(minutos?) / hhSomar(qtd) / hhDesfazer() / hhEncerrar()
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
    manual: false, regulamento: '', fuso: 'America/Sao_Paulo', indicacao: { ativo: true, indicador: 50, indicado: 20, quando: 'cadastro' },
    niveis: { ativo: false, base: 'sempre', meses: 12, lista: [] }, ranking: { ativo: true },
    // Mês do aniversário: pontos x mult no mês e bônus de presente (1 vez por ano).
    aniversario: { ativo: false, mult: 1, bonus: 0 },
    // Cliente manda pontos para outro cliente (CPF ou código), com o PIN.
    transferencia: { ativo: true, minimo: 10, maximoDia: 0 },
    // Pontos vencem depois de quantidade dias/meses (os mais antigos primeiro). desde = dia em que a regra foi ligada.
    validade: { ativo: false, quantidade: 12, unidade: 'meses', desde: null },
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
  // Valor total da nota, quando o QR traz (QR antigo com vNF=, ou NFC-e em contingência: chave|versão|amb|dia|vNF|...).
  // A NFC-e emitida online não traz o valor no QR.
  const valorDoQr = (t) => {
    const v1 = String(t || '').match(/[?&]vNF=(\d+(?:\.\d{1,2})?)(?:&|$)/i);
    if (v1 && +v1[1] > 0 && +v1[1] < 1e5) return +v1[1];
    const m = String(t || '').match(/[?&]p=([^&#]+)/);
    if (!m) return null;
    const p = decodeURIComponent(m[1]).split('|');
    if (p.length < 8 || !/^\d+(\.\d{1,2})?$/.test(p[4] || '')) return null;
    const v = +p[4];
    return v > 0 && v < 1e5 ? v : null;
  };
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
  // Pontos de uma compra: valor x pontos por real x (dia com mais pontos ou mês do aniversário, o maior)
  // x bônus do nível x clássico. extra = { aniversarioMes, eventoMult, eventoNome } (mesmas regras de public.fid_calcular).
  function fidCalcular(regras, valor, quando, nivel = null, extra = {}) {
    const ppr = Math.min(Math.max(Number(regras.pontosPorReal) || 0, 0), 1000);
    let b = fidBoost(regras, quando);
    const an = regras.aniversario || {};
    const am = Math.min(Math.max(Number(an.mult) || 1, 1), 10);
    if (an.ativo && extra.aniversarioMes && extra.aniversarioMes === new Date(quando).getMonth() + 1 && am > b.mult) b = { mult: am, nome: 'mês do aniversário' };
    const em = extra.eventoMult > 1 ? extra.eventoMult : 1;
    const mn = nivel ? nivel.mult : 1;
    const m = Math.round(b.mult * mn * em * 100) / 100;
    const nome = [b.nome, em > 1 ? extra.eventoNome : null].filter(Boolean).join(' · ') || null;
    return { pontos: Math.floor(Math.max(Number(valor) || 0, 0) * ppr * m + 1e-9), mult: m, boost: nome, nivel: mn > 1 ? nivel.nome : null };
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
    aniversario: { ativo: true, mult: 2, bonus: 50 },
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
    aniversario: { ...FID_PADRAO.aniversario, ...((f && f.aniversario) || {}) },
    transferencia: { ...FID_PADRAO.transferencia, ...((f && f.transferencia) || {}) },
    validade: { ...FID_PADRAO.validade, ...((f && f.validade) || {}) },
  });

  // Mensalidade do plano (assets/js/precos.js, a mesma tabela de public.plano_preco).
  const precoPlano = (p) => window.Precos.plano(p);
  /* Opções dos itens do cardápio (as mesmas regras de public.delivery_pedir):
     item.grupos = [{ id, nome, tipo: 'escolha' | 'extras', min, max, opcoes: [{ id, nome, preco }] }]
     'escolha': a pessoa escolhe uma (tamanho, carne…); o preço da opção soma ao preço do item.
     'extras': adicionais com quantidade; min/max contam o total do grupo (max 0 = sem limite).
     sel = [{ g: grupoId, o: opcaoId, q: quantidade }] */
  const gruposDe = (it) => (it && Array.isArray(it.grupos) ? it.grupos : []).filter((g) => g && Array.isArray(g.opcoes) && g.opcoes.length);
  const opcoes = {
    grupos: gruposDe,
    // Menor preço possível (para mostrar "a partir de").
    aPartir(it) {
      return (+it.preco || 0) + gruposDe(it).filter((g) => g.tipo === 'escolha' && +g.min >= 1)
        .reduce((t, g) => t + Math.min(...g.opcoes.map((o) => +o.preco || 0)), 0);
    },
    temVariacao: (it) => gruposDe(it).some((g) => g.opcoes.some((o) => +o.preco > 0)) ,
    calcular(it, sel = []) {
      let preco = +it.preco || 0;
      const rotulos = [];
      for (const g of gruposDe(it)) {
        const meus = sel.filter((x) => x.g === g.id);
        if (g.tipo === 'escolha') {
          if (meus.length > 1) return { erro: `Escolha só uma opção em "${g.nome}".` };
          if (!meus.length) { if (+g.min >= 1) return { erro: `Escolha: ${g.nome}.` }; continue; }
          const o = g.opcoes.find((x) => x.id === meus[0].o);
          if (!o) return { erro: 'Opção indisponível. Atualize a página.' };
          preco += +o.preco || 0;
          rotulos.push(o.nome);
        } else {
          let total = 0;
          for (const m of meus) {
            const o = g.opcoes.find((x) => x.id === m.o);
            const q = Math.min(Math.max(Math.round(+m.q || 0), 0), 20);
            if (!o) return { erro: 'Opção indisponível. Atualize a página.' };
            if (!q) continue;
            total += q;
            preco += (+o.preco || 0) * q;
            rotulos.push(q > 1 ? `${q}× ${o.nome}` : o.nome);
          }
          if (+g.max > 0 && total > +g.max) return { erro: `Em "${g.nome}", escolha até ${g.max}.` };
          if (total < (+g.min || 0)) return { erro: `Em "${g.nome}", escolha pelo menos ${g.min}.` };
        }
      }
      return { preco: Math.round(preco * 100) / 100, rotulos };
    },
  };
  // Distância em linha reta (km), a mesma conta de public.distancia_km.
  const distanciaKm = (a, b) => {
    const r = (x) => (x * Math.PI) / 180;
    const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
    return Math.round(6371 * 2 * Math.asin(Math.sqrt(h)) * 100) / 100;
  };
  // Taxa de entrega pela distância: a primeira faixa que cobre. null = fora da área.
  const taxaEntrega = (dcfg, km) => {
    const f = (dcfg.faixas || []).filter((x) => +x.ate > 0).sort((x, y) => x.ate - y.ate).find((x) => +x.ate >= km);
    return f ? +f.taxa || 0 : null;
  };
  // Valores iniciais, usados enquanto a equipe ainda não salvou nada pelo painel.
  // Demonstração: o restaurante de exemplo (Quintal Bistrô). Restaurante de verdade:
  // tudo em branco, e o que não for preenchido não aparece para o cliente.
  const RESTAURANTE_VAZIO = {
    nome: '', descricao: '', endereco: '', telefone: '', instagram: '', googleUrl: '', logo: '', capa: '', cor: '',
    taxaServico: 10, horarios: [],
  };
  // Delivery: taxa por distância (faixas até X km), pedido mínimo, tempo e formas de pagamento.
  const DELIVERY_PADRAO = {
    ativo: false, local: null, faixas: [{ ate: 3, taxa: 5 }, { ate: 6, taxa: 8 }, { ate: 10, taxa: 12 }],
    minimo: 0, tempo: '40 a 60', pagamentos: { pix: true, cartao: true, dinheiro: true }, pix: '', whatsapp: '',
  };
  // Prorrogação: os mesmos padrões e limites de public.hh_cfg.
  const PRORROGACAO_PADRAO = {
    ativo: false, nome: 'Prorrogação', frase: '', produto: 'chopp',
    duracao: 60, minutos: 1, teto: 0, limite: null, agenda: { ativo: false, dias: [], hora: '18:00' },
  };
  const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const hhCfg = (c) => {
    c = c || {};
    const ag = c.agenda || {};
    const lim = (v, pad, a, b) => Math.round(Math.min(Math.max(Number.isFinite(+v) && v !== '' && v != null ? +v : pad, a), b));
    return {
      ativo: c.ativo === true,
      nome: String(c.nome || '').trim().slice(0, 40) || PRORROGACAO_PADRAO.nome,
      // Vazia = a frase padrão (hhFrase), que acompanha o item e os minutos.
      frase: String(c.frase || '').trim().slice(0, 120),
      produto: String(c.produto || '').trim().slice(0, 30) || 'chopp',
      duracao: lim(c.duracao, 60, 5, 600), minutos: lim(c.minutos, 1, 1, 30), teto: lim(c.teto, 0, 0, 1440),
      limite: HORA_RE.test(c.limite || '') ? c.limite : null,
      agenda: { ativo: ag.ativo === true, dias: [...new Set((Array.isArray(ag.dias) ? ag.dias : []).map(String).filter((d) => /^[0-6]$/.test(d)).map(Number))].sort(),
        hora: HORA_RE.test(ag.hora || '') ? ag.hora : '18:00' },
    };
  };
  const hhFrase = (c) => c.frase || `Cada ${c.produto} é mais ${c.minutos} ${c.minutos === 1 ? 'minuto' : 'minutos'} de happy hour`;
  const seed = (demo = true) => (demo ? {
    restaurante: cfg.restaurante,
    wifi: cfg.wifi,
    // Demonstração: o cardápio de exemplo também vende no delivery.
    cardapio: cfg.cardapio.map((c) => ({ ...c, itens: c.itens.map((i) => ({ delivery: true, ...i })) })),
    mesas: cfg.mesasPadrao,
    widgets: cfg.widgetsPadrao,
    delivery: { ...DELIVERY_PADRAO, ativo: true, local: { lat: -23.5667, lng: -46.6849, endereco: 'Rua dos Pinheiros, 412 - Pinheiros, São Paulo' }, pix: 'pix@quintalbistro.com.br' },
    prorrogacao: { ...PRORROGACAO_PADRAO, ativo: true },
  } : {
    restaurante: RESTAURANTE_VAZIO,
    wifi: { rede: '', senha: '', seguranca: 'WPA' },
    cardapio: [],
    mesas: { total: 20, areas: [{ nome: 'Salão', de: 1, ate: 20 }] },
    // As informações (endereço, telefone, horários, Instagram) começam desligadas.
    widgets: cfg.widgetsPadrao.map((w) => (w.tipo === 'info' ? { ...w, ativo: false } : w)),
    delivery: DELIVERY_PADRAO,
    prorrogacao: PRORROGACAO_PADRAO,
  });
  // Completa o que foi salvo com os valores iniciais (campos novos em versões futuras).
  // Módulos: na demonstração vêm todos liberados; no servidor, a central libera.
  const mergeSettings = (saved, demo = false) => {
    const base = seed(demo);
    const out = { ...base };
    for (const k of Object.keys(base)) {
      const v = saved && saved[k];
      if (v == null) continue;
      out[k] = Array.isArray(v) || typeof v !== 'object' ? v : { ...base[k], ...v };
    }
    // Lista de atalhos salva antes de existir o de informações: ele entra no fim, desligado.
    if (!out.widgets.some((w) => w.tipo === 'info')) out.widgets = [...out.widgets, { id: 'info', tipo: 'info', label: 'Informações do restaurante', ativo: false, embutido: true }];
    out.modulos = { ...(demo ? { fidelidade: true } : {}), ...((saved && saved.modulos) || {}) };
    // Plano contratado: serviços e mesas. Sem plano definido = tudo liberado.
    const pl = saved && saved.plano;
    out.plano = {
      servicos: { pagina: true, garcom: true, fidelidade: !!out.modulos.fidelidade, delivery: !!demo, ...((pl && pl.servicos) || {}) },
      mesas: Math.min(Math.max(+((pl && pl.mesas) || 500), 1), 500),
      // Adicionais (cobrados à parte). Demonstração: todos ligados.
      adicionais: { prorrogacao: !!demo, ...((pl && pl.adicionais) || {}) },
    };
    out.prorrogacao = hhCfg(out.prorrogacao);
    out.modulos.fidelidade = !!out.plano.servicos.fidelidade;
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
        && (['compra', 'manual', 'evento'].includes(m.tipo) || (['estorno', 'ajuste'].includes(m.tipo) && !m.resgate_id)))
        .reduce((t, m) => t + m.pontos, 0), 0);
    }
    const nivelDe = (db, cpf) => fidNivelDe(fidNiveis(regras(db)), pontosNivel(db, cpf));
    // Produtos das notas (do XML), para os mais pedidos.
    function salvarItens(db, chave, cpf, emitida, itens) {
      if (!Array.isArray(itens)) return;
      const f = F(db);
      f.itens = (f.itens || []).filter((i) => i.chave !== chave);
      itens.slice(0, 300).forEach((i, n) => i.descricao && f.itens.push({ chave, n: n + 1, cpf: cpf || null, descricao: String(i.descricao).trim().slice(0, 120),
        quantidade: +i.quantidade || 1, unidade: i.unidade || '', valor: i.valor == null ? null : +i.valor, emitida_em: emitida || null }));
    }
    // Produtos das notas e dos pedidos entregues do delivery (o pedido com nota importada conta uma vez só).
    function itensComDelivery(db) {
      const comNota = new Set((F(db).itens || []).map((i) => i.chave));
      const doDelivery = (db.pedidos || []).filter((p) => p.status === 'entregue' && !(p.nota_chave && comNota.has(p.nota_chave)))
        .flatMap((p) => p.itens.map((x) => ({ chave: 'pedido:' + p.id, cpf: p.cpf || null, descricao: x.nome, quantidade: x.qtd, valor: x.preco * x.qtd, emitida_em: p.criado_em })));
      return [...(F(db).itens || []), ...doDelivery];
    }
    function topProdutos(db, cpf, dias = 90, limite = 20) {
      const desde = Date.now() - dias * DIA;
      const g = new Map();
      for (const i of itensComDelivery(db)) {
        if ((cpf && i.cpf !== cpf) || (i.emitida_em && new Date(i.emitida_em) < desde)) continue;
        const k = i.descricao.toLowerCase();
        const x = g.get(k) || { descricao: i.descricao, quantidade: 0, notas: new Set(), clientes: new Set(), valor: 0 };
        x.quantidade += i.quantidade; x.notas.add(i.chave); if (i.cpf) x.clientes.add(i.cpf); x.valor += i.valor || 0;
        g.set(k, x);
      }
      return [...g.values()].map((x) => ({ ...x, notas: x.notas.size, clientes: x.clientes.size }))
        .sort((a, b) => b.quantidade - a.quantidade || b.notas - a.notas).slice(0, limite);
    }
    const nomeCurto = (nome) => {
      const p = String(nome || '').trim().split(/\s+/);
      return p[0] + (p.length > 1 ? ` ${p[p.length - 1][0]}.` : '');
    };
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
        mover(db, c.indicado_por, 'indicacao', +r.indicador, { descricao: `Indicação: ${c.nome.split(' ')[0]} ${r.quando === 'compra' ? 'fez a primeira compra' : 'entrou no clube'}` });
      }
    }
    function creditar(db, n, valor, emitida, por) {
      if (!n || n.status !== 'pendente') return null;
      const quando = new Date(emitida || n.lida_em);
      const ped = (db.pedidos || []).find((p) => p.cpf === n.cpf && p.fid_situacao === 'creditado' && !p.nota_chave
        && (Math.abs(p.total - valor) <= 0.05 || Math.abs(p.subtotal - valor) <= 0.05)
        && quando >= new Date(p.criado_em) - 3600e3 && quando <= +new Date(p.criado_em) + 12 * 3600e3);
      if (ped) {
        ped.nota_chave = n.chave;
        Object.assign(n, { status: 'recusada', valor, emitida_em: quando.toISOString(), conferida_em: nowIso(), conferida_por: por,
          motivo: `Esta compra já ganhou pontos pelo pedido nº ${ped.numero} do delivery.` });
        return null;
      }
      const calc = fidCalcular(regras(db), valor, emitida || n.lida_em, nivelDe(db, n.cpf), extraDe(db, n.cpf, emitida || n.lida_em));
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
      const pts = creditar(db, n, x.valor, x.emitida_em, 'XML da nota');
      return pts == null ? { status: 'recusada', motivo: n.motivo } : { status: 'creditada', pontos: pts, valor: x.valor };
    }
    // Pedido entregue do delivery vira pontos (mesmas regras de public.fid_creditar_pedido).
    function creditarPedido(db, p) {
      if (!p || p.status !== 'entregue' || ['creditado', 'nota'].includes(p.fid_situacao)) return null;
      const f = F(db);
      let cpf = p.cpf;
      if (!cpf) {
        const achados = f.clientes.filter((c) => c.telefone === soDigitos(p.cliente.telefone));
        if (achados.length !== 1) return null;
        cpf = achados[0].cpf;
      }
      if (!noAr(db)) { p.fid_situacao = 'fora'; return { status: 'fora' }; }
      const c = cliDe(db, cpf);
      if (!c) { p.fid_situacao = 'sem_cadastro'; return { status: 'sem_cadastro' }; }
      const ini = inicio(db);
      const em = new Date(p.criado_em);
      if ((ini && em < ini) || em < new Date(c.criado_em) - prazo(db) * DIA) { Object.assign(p, { fid_situacao: 'fora', cpf }); return { status: 'fora' }; }
      const ligadas = new Set((db.pedidos || []).map((x) => x.nota_chave).filter(Boolean));
      const n = f.notas.find((x) => x.cpf === cpf && x.status === 'creditada' && !ligadas.has(x.chave)
        && (Math.abs(x.valor - p.total) <= 0.05 || Math.abs(x.valor - p.subtotal) <= 0.05)
        && new Date(x.emitida_em) >= em - 3600e3 && new Date(x.emitida_em) <= +em + 12 * 3600e3);
      if (n) { Object.assign(p, { fid_situacao: 'nota', cpf, nota_chave: n.chave, fid_pontos: n.pontos }); return { status: 'nota', pontos: n.pontos }; }
      const calc = fidCalcular(regras(db), p.total, p.criado_em, nivelDe(db, cpf), extraDe(db, cpf, p.criado_em));
      Object.assign(p, { fid_situacao: 'creditado', cpf, fid_pontos: calc.pontos });
      mover(db, cpf, 'compra', calc.pontos, {
        descricao: `Delivery nº ${p.numero} · ${brlTxt(p.total)}${calc.boost ? ` · ${calc.boost}` : ''}${calc.nivel ? ` · nível ${calc.nivel}` : ''}${calc.mult > 1 ? ` (${multTxt(calc.mult)}x)` : ''}`,
        valor: p.total, mult: calc.mult, por: 'Delivery',
      });
      bonusIndicacao(db, cpf);
      return { status: 'creditado', pontos: calc.pontos };
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
    /* ---- Aniversário, validade, transferência e clássico (mesmas regras do banco) ---- */
    const evs = (db) => { const f = F(db); f.eventos = f.eventos || []; f.torcidas = f.torcidas || []; return f; };
    const fechaEvento = (e) => new Date(`${e.data}T${e.hora || '23:59'}:00`);
    // Prorrogação na demonstração (horário deste aparelho).
    const HH = (db) => (db.hh = db.hh || { sessoes: [], leituras: [] });
    const hhAberta = (db) => HH(db).sessoes.find((x) => !x.encerrada_em);
    const emHora = (dia, hhmm) => new Date(`${dia}T${hhmm}:00`).getTime();
    const hhLimite = (c, inicio) => {
      if (!c.limite) return Infinity;
      let t = emHora(diaIso(new Date(inicio)), c.limite);
      if (t <= inicio) t += 864e5;
      return t;
    };
    const hhExigir = (db) => {
      const s = mergeSettings(db.configuracao, true);
      if (!s.plano.adicionais.prorrogacao) falha('A Prorrogação é um adicional e não está no plano deste restaurante. Contrate na aba Plano.');
      if (!s.prorrogacao.ativo) falha('Ligue a Prorrogação nos ajustes dela antes de usar.');
      return s.prorrogacao;
    };
    const hhTick = (db) => {
      const h = HH(db);
      h.sessoes.forEach((x) => { if (!x.encerrada_em && new Date(x.fim).getTime() <= Date.now()) Object.assign(x, { encerrada_em: x.fim, motivo: 'tempo' }); });
      h.sessoes = h.sessoes.slice(-60);
      h.leituras = h.leituras.filter((l) => h.sessoes.some((x) => x.id === l.sessao_id)).slice(-600);
      const s = mergeSettings(db.configuracao, true);
      const c = s.prorrogacao;
      const hoje = diaIso(new Date());
      if (!s.plano.adicionais.prorrogacao || !c.ativo || !c.agenda.ativo || !c.agenda.dias.includes(new Date().getDay())) return;
      if (h.sessoes.some((x) => x.agenda_dia === hoje)) return;
      const ini = emHora(hoje, c.agenda.hora);
      const ate = Math.min(ini + c.duracao * 60e3, hhLimite(c, ini));
      if (Date.now() < ini || Date.now() >= ate) return;
      const aberta = hhAberta(db);
      if (aberta) { if (!aberta.agenda_dia) aberta.agenda_dia = hoje; return; }
      h.sessoes.push({ id: uid(), nome: c.nome, inicio: new Date(ini).toISOString(), fim: new Date(ate).toISOString(), encerrada_em: null, motivo: null,
        leituras: 0, minutos_ganhos: 0, criado_por: 'Agenda', agenda_dia: hoje });
    };
    const hhStatusDe = (db) => {
      const s = mergeSettings(db.configuracao, true);
      const c = s.prorrogacao;
      if (!s.plano.adicionais.prorrogacao || !c.ativo) return { disponivel: false };
      hhTick(db);
      const h = HH(db);
      const a = hhAberta(db);
      const fechadas = h.sessoes.filter((x) => x.encerrada_em);
      const u = fechadas.slice().sort((x, y) => y.encerrada_em.localeCompare(x.encerrada_em))[0];
      const dur = (x) => new Date(x.encerrada_em) - new Date(x.inicio);
      const rec = fechadas.slice().sort((x, y) => dur(y) - dur(x))[0];
      let proxima = null;
      if (c.agenda.ativo) {
        for (let d = 0; d <= 7 && !proxima; d++) {
          const dia = new Date(); dia.setDate(dia.getDate() + d);
          const t = emHora(diaIso(dia), c.agenda.hora);
          if (c.agenda.dias.includes(dia.getDay()) && t > Date.now() && !h.sessoes.some((x) => x.agenda_dia === diaIso(dia))) proxima = new Date(t).toISOString();
        }
      }
      const lim = a ? hhLimite(c, new Date(a.inicio).getTime()) : Infinity;
      return {
        disponivel: true, agora: nowIso(), nome: c.nome, frase: hhFrase(c), produto: c.produto, minutos: c.minutos, teto: c.teto, rodando: !!a,
        sessao: a ? { id: a.id, inicio: a.inicio, fim: a.fim, leituras: a.leituras, minutos_ganhos: a.minutos_ganhos,
          limite_em: lim === Infinity ? null : new Date(lim).toISOString(),
          ultima: (h.leituras.filter((l) => l.sessao_id === a.id && !l.desfeita).pop() || {}).em || null } : null,
        ultima_sessao: u ? { inicio: u.inicio, fim: u.encerrada_em, leituras: u.leituras, minutos_ganhos: u.minutos_ganhos } : null,
        recorde: rec ? { minutos: Math.round(dur(rec) / 60e3), leituras: rec.leituras, em: rec.inicio } : null,
        proxima,
      };
    };
    // Mês do aniversário e clássico vencido pelo time do cliente no dia da compra.
    function extraDe(db, cpf, quando) {
      const c = cpf && cliDe(db, cpf);
      if (!c) return {};
      const f = evs(db);
      const dia = diaIso(new Date(quando));
      const e = f.eventos.filter((x) => x.data === dia && x.vencedor && f.torcidas.some((t) => t.evento_id === x.id && t.cpf === cpf && t.time === x.vencedor))
        .sort((a, b) => b.mult - a.mult)[0];
      return { aniversarioMes: c.aniversario_mes || null, eventoMult: e ? +e.mult : 1, eventoNome: e ? e.nome : null };
    }
    function bonusAniversario(db, cpf) {
      const a = regras(db).aniversario || {};
      const b = Math.round(Math.min(Math.max(+a.bonus || 0, 0), 1e5));
      const c = cliDe(db, cpf);
      const agora = new Date();
      if (!a.ativo || b <= 0 || !noAr(db) || !c || c.aniversario_mes !== agora.getMonth() + 1 || (c.aniversario_ano || 0) >= agora.getFullYear()) return 0;
      c.aniversario_ano = agora.getFullYear();
      mover(db, cpf, 'aniversario', b, { descricao: 'Presente de aniversário', por: 'Aniversário' });
      return b;
    }
    // Validade em ms (null = não vence) e o início da contagem.
    function validadeMs(db) {
      const v = regras(db).validade || {};
      if (!v.ativo) return null;
      return v.unidade === 'dias' ? Math.min(Math.max(+v.quantidade || 365, 1), 3650) * DIA : Math.min(Math.max(+v.quantidade || 12, 1), 120) * 30.44 * DIA;
    }
    const validadeDesde = (db) => { const d = (regras(db).validade || {}).desde; return /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? +new Date(d + 'T00:00:00') : null; };
    const venceEm = (db, m, iv) => Math.max(+new Date(m.criado_em), validadeDesde(db) || 0) + iv;
    function vencer(db, cpf) {
      const iv = validadeMs(db);
      const c = cliDe(db, cpf);
      if (!iv || !c || c.pontos <= 0) return 0;
      const ms = F(db).movimentos.filter((m) => m.cpf === cpf);
      const ganhos = ms.filter((m) => m.pontos > 0 && venceEm(db, m, iv) <= Date.now()).reduce((t, m) => t + m.pontos, 0);
      const saidas = -ms.filter((m) => m.pontos < 0).reduce((t, m) => t + m.pontos, 0);
      const v = Math.min(ganhos - saidas, c.pontos);
      if (v <= 0) return 0;
      mover(db, cpf, 'validade', -v, { descricao: 'Pontos vencidos', por: 'Validade' });
      return v;
    }
    function aVencer(db, cpf) {
      const iv = validadeMs(db);
      if (!iv) return null;
      const ms = F(db).movimentos.filter((m) => m.cpf === cpf);
      const saidas = -ms.filter((m) => m.pontos < 0).reduce((t, m) => t + m.pontos, 0);
      let acum = 0; let primeira = null; let total = 0;
      for (const m of ms.filter((x) => x.pontos > 0).map((x) => ({ pontos: x.pontos, vence: venceEm(db, x, iv) })).sort((a, b) => a.vence - b.vence)) {
        if (m.vence > Date.now() + 30 * DIA) break;
        acum += m.pontos;
        if (acum > saidas) { primeira = primeira || m.vence; total = acum - saidas; }
      }
      return total > 0 ? { pontos: total, em: new Date(primeira).toISOString() } : null;
    }
    // Destino da transferência: CPF ou código de indicação.
    function destinoDe(db, d) {
      const x = String(d || '').replace(/[^0-9A-Za-z]/g, '');
      return /^\d{11}$/.test(x) ? cliDe(db, x) : /^[A-Za-z0-9]{4,12}$/.test(x) ? F(db).clientes.find((c) => c.codigo === x.toUpperCase()) : null;
    }
    function eventosPublicos(db) {
      const hoje = diaIso(new Date());
      const limite = diaIso(new Date(Date.now() + 30 * DIA));
      const ontem = diaIso(new Date(Date.now() - DIA));
      return evs(db).eventos
        .filter((e) => (!e.vencedor && e.data >= ontem && e.data <= limite) || (e.resultado_em && Date.now() - new Date(e.resultado_em) < 3 * DIA))
        .sort((a, b) => (a.data + (a.hora || '')).localeCompare(b.data + (b.hora || '')))
        .map((e) => ({ id: e.id, nome: e.nome, data: e.data, hora: e.hora || null, times: e.times, mult: +e.mult, vencedor: e.vencedor || null, aberta: !e.vencedor && Date.now() < fechaEvento(e), hoje: e.data === hoje }));
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
        const atual = mergeSettings(db.configuracao, true);
        if (patch.prorrogacao && !atual.plano.adicionais.prorrogacao) {
          throw new Error('A Prorrogação é um adicional e não está no plano deste restaurante. Contrate na aba Plano.');
        }
        if (patch.mesas && +patch.mesas.total > atual.plano.mesas) {
          throw new Error(`Seu plano tem ${atual.plano.mesas} mesas. Para usar mais, aumente as mesas na aba Plano.`);
        }
        const novo = { ...atual, ...patch };
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
      // Plano na demonstração: mesmas regras de public.plano_aplicar (guardado neste navegador).
      async meuPlano() {
        const db = read();
        const p = mergeSettings(db.configuracao, true).plano;
        const plano = { ...p, dominio: 'sub', contrato: 6, definido: !!(db.planoHistorico || []).length };
        // Demonstração: sem consulta real na SEFAZ, o uso fica zerado.
        const r = regras(db);
        const mes = (k) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - k); return diaIso(d); };
        const sefaz = { ativo: !!(r.sefaz && r.sefaz.ativo), preco: window.Precos ? Precos.SEFAZ_NOTA : 0.25, meses: [0, 1].map((k) => ({ mes: mes(k), notas: 0, valor: 0 })) };
        // Maior implantação já paga (mesma regra de public.implantacao_paga): 0 enquanto o plano não foi definido.
        const hist = db.planoHistorico || [];
        const implantacao_paga = plano.definido && window.Precos ? Math.max(Precos.implantacao(plano.mesas), ...hist.map((h) => Precos.implantacao(h.depois.mesas))) : 0;
        return { plano, mensal: precoPlano(plano), sefaz, implantacao_paga, historico: hist };
      },
      async alterarPlano(p) {
        const db = read();
        const sv = (p && p.servicos) || {};
        const ids = window.Precos.SERVICOS.map((x) => x.id);
        if (!ids.some((k) => sv[k])) throw new Error('Escolha pelo menos um serviço.');
        const atual = await this.meuPlano();
        const antes = atual.plano;
        const ad = (p && p.adicionais) || antes.adicionais || {};
        const novo = { servicos: Object.fromEntries(ids.map((k) => [k, !!sv[k]])), mesas: Math.min(Math.max(Math.round(+p.mesas || 20), 1), 500),
          adicionais: Object.fromEntries(window.Precos.ADICIONAIS.map((x) => [x.id, !!ad[x.id]])), dominio: 'sub', contrato: 6, definido: true };
        const cfgAtual = mergeSettings(db.configuracao, true);
        const mesas = cfgAtual.mesas.total > novo.mesas
          ? { total: novo.mesas, areas: cfgAtual.mesas.areas.filter((a) => a.de <= novo.mesas).map((a) => ({ ...a, ate: Math.min(a.ate, novo.mesas) })) }
          : cfgAtual.mesas;
        db.configuracao = { ...(db.configuracao || {}), plano: novo, mesas, modulos: { ...((db.configuracao && db.configuracao.modulos) || {}), fidelidade: novo.servicos.fidelidade } };
        (db.planoHistorico = db.planoHistorico || []).unshift({ criado_em: nowIso(), origem: 'restaurante', por: quem(db), antes: antes.definido ? antes : null, depois: novo,
          mensal_antes: antes.definido ? precoPlano(antes) : null, mensal_depois: precoPlano(novo),
          taxa_unica: window.Precos ? Precos.taxaMesas(atual.implantacao_paga, novo.mesas, novo.contrato) : 0 });
        write(db);
        return { ...novo, taxa_unica: db.planoHistorico[0].taxa_unica };
      },

      /* ---------- Fidelidade: cliente ---------- */
      async fidPrograma() {
        const db = read();
        if (!noAr(db)) return { ativo: false };
        const r = regras(db);
        const hoje = diaIso(new Date());
        return {
          ativo: true, nome: r.nome || 'Clube de pontos', pontosPorReal: +r.pontosPorReal || 0, prazoDias: prazo(db), regulamento: r.regulamento || '',
          sefaz: !!(r.sefaz && r.sefaz.ativo),
          indicacao: r.indicacao && r.indicacao.ativo ? { ativo: true, indicador: +r.indicacao.indicador || 0, indicado: +r.indicacao.indicado || 0, quando: r.indicacao.quando === 'compra' ? 'compra' : 'cadastro' } : { ativo: false },
          boosts: (r.boosts || []).filter((b) => b.ativo !== false && +b.mult > 1 && !(b.fim && b.fim < hoje))
            .map(({ nome, mult, dias, de, ate, inicio: ini, fim }) => ({ nome, mult: +mult, dias: dias || [], de: de || '', ate: ate || '', inicio: ini || '', fim: fim || '' })),
          niveis: fidNiveis(r).length ? { ativo: true, base: r.niveis.base === 'meses' ? 'meses' : 'sempre', meses: Math.min(Math.max(+r.niveis.meses || 12, 1), 60), lista: fidNiveis(r) } : { ativo: false },
          aniversario: r.aniversario && r.aniversario.ativo ? { ativo: true, mult: Math.min(Math.max(+r.aniversario.mult || 1, 1), 10), bonus: Math.max(+r.aniversario.bonus || 0, 0) } : { ativo: false },
          transferencia: r.transferencia && r.transferencia.ativo ? { ativo: true, minimo: Math.max(+r.transferencia.minimo || 1, 1), maximoDia: Math.max(+r.transferencia.maximoDia || 0, 0) } : { ativo: false },
          validade: validadeMs(db) ? { ativo: true, quantidade: +r.validade.quantidade || 12, unidade: r.validade.unidade === 'dias' ? 'dias' : 'meses' } : { ativo: false },
          eventos: eventosPublicos(db),
          premios: F(db).premios.filter((p) => p.ativo && (!p.aniversario || (r.aniversario && r.aniversario.ativo)))
            .sort((a, b) => (b.aniversario ? 1 : 0) - (a.aniversario ? 1 : 0) || a.ordem - b.ordem || a.pontos - b.pontos)
            .map(({ id, nome, descricao, pontos, imagem, nivel_min, aniversario }) => ({ id, nome, descricao, pontos, imagem, nivel_min: nivel_min || null, aniversario: !!aniversario })),
        };
      },
      async fidConsultar(cpf) {
        const db = read();
        cpf = soDigitos(cpf);
        if (!noAr(db)) return { status: 'inativo' };
        if (!cpfValido(cpf)) return { status: 'erro', mensagem: 'CPF inválido. Confira os números.' };
        const c = cliDe(db, cpf);
        if (!c) return { status: 'novo' };
        if (vencer(db, cpf) + bonusAniversario(db, cpf)) write(db);
        return { status: 'ok', nome: c.nome.split(' ')[0], pontos: c.pontos, nivel: nivelDe(db, cpf), pendentes: F(db).notas.filter((n) => n.cpf === cpf && n.status === 'pendente').length, tem_pin: !!F(db).pins[cpf] };
      },
      async fidIndicador(codigo) {
        const c = F(read()).clientes.find((x) => x.codigo === String(codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
        return c ? { status: 'ok', nome: c.nome.split(' ')[0] } : { status: 'nao' };
      },
      async fidCadastrar({ cpf, nome, email, telefone, pin, marketing, indicacao, aniversario }) {
        const db = read();
        if (!noAr(db)) return { status: 'inativo' };
        aniversario = Math.round(+aniversario);
        cpf = soDigitos(cpf);
        nome = String(nome || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        email = String(email || '').trim().toLowerCase();
        telefone = soDigitos(telefone);
        if ([12, 13].includes(telefone.length) && telefone.startsWith('55')) telefone = telefone.slice(2);
        const erro = !cpfValido(cpf) ? 'CPF inválido. Confira os números.'
          : !/^\S{2,}( \S+)+$/.test(nome) ? 'Informe seu nome completo (nome e sobrenome).'
          : email.length > 120 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? 'E-mail inválido.'
          : !/^[1-9]\d{9,10}$/.test(telefone) ? 'Telefone inválido. Use DDD + número.'
          : !/^\d{4}$/.test(pin || '') ? 'O PIN tem 4 números.'
          : !(aniversario >= 1 && aniversario <= 12) ? 'Escolha o mês do seu aniversário.' : null;
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
        f.clientes.push({ cpf, nome, email, telefone, pontos: 0, codigo, indicado_por, bonus_indicacao: false, marketing: !!marketing, aniversario_mes: aniversario, aniversario_ano: null, criado_em: nowIso() });
        f.pins[cpf] = await hashTxt(cpf + ':' + pin);
        if (regras(db).indicacao.quando !== 'compra') bonusIndicacao(db, cpf);
        f.xml.filter((x) => x.cpf === cpf).forEach((x) => autoCreditar(db, x.chave));
        (db.pedidos || []).filter((p) => p.status === 'entregue' && (!p.fid_situacao || p.fid_situacao === 'sem_cadastro')
          && (p.cpf === cpf || (!p.cpf && soDigitos(p.cliente.telefone) === telefone)) && Date.now() - new Date(p.criado_em) < prazo(db) * DIA)
          .forEach((p) => creditarPedido(db, p));
        bonusAniversario(db, cpf);
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
        const f = evs(db);
        vencer(db, cpf);
        bonusAniversario(db, cpf);
        const c = cliDe(db, cpf);
        const desc = (a, b) => (a < b ? 1 : a > b ? -1 : 0);
        const nivel = atualizarNivel(db, cpf, false);
        write(db);
        const ano = new Date().getFullYear();
        return {
          status: 'ok', ...c, nivel, indicacoes: f.clientes.filter((x) => x.indicado_por === cpf).length,
          aniversariante: c.aniversario_mes === new Date().getMonth() + 1,
          a_vencer: aVencer(db, cpf),
          torcidas: Object.fromEntries(f.torcidas.filter((t) => t.cpf === cpf).map((t) => [t.evento_id, t.time])),
          presentes_ano: [...new Set(f.resgates.filter((x) => x.cpf === cpf && x.status !== 'cancelado' && new Date(x.criado_em).getFullYear() === ano
            && (f.premios.find((p) => p.id === x.premio_id) || {}).aniversario).map((x) => x.premio_id))],
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
      async fidNotaSituacao({ cpf, qr }) {
        const db = read();
        if (!noAr(db)) return { status: 'inativo' };
        const chave = chaveDoTexto(qr);
        if (!chave) return { status: 'nova' };
        const n = F(db).notas.find((x) => x.chave === chave);
        if (n) return n.cpf !== soDigitos(cpf) ? { status: 'erro', mensagem: 'Esta nota já foi registrada em outra conta.' } : { status: 'repetida', nota: n.status, pontos: n.pontos, motivo: n.motivo };
        const prob = chaveProblema(db, chave);
        return prob ? { status: 'erro', mensagem: prob } : { status: 'nova' };
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
      /* ---------- Delivery ---------- */
      async deliveryPedir(p) {
        const db = read();
        const conf = mergeSettings(db.configuracao, true);
        const d = conf.delivery;
        const erro = (mensagem) => ({ status: 'erro', mensagem });
        if (!conf.plano.servicos.delivery) return erro('Este restaurante não faz delivery por aqui.');
        if (!d.ativo) return erro('O delivery está fechado agora.');
        const nome = String(p.cliente && p.cliente.nome || '').trim().slice(0, 60);
        const tel = soDigitos(p.cliente && p.cliente.telefone).replace(/^55(?=\d{10,11}$)/, '');
        let e = p.endereco || {};
        if (nome.length < 2) return erro('Informe seu nome.');
        if (!/^[1-9]\d{9,10}$/.test(tel)) return erro('Informe um celular com DDD.');
        let cpf = soDigitos(p.cpf) || null;
        if (cpf && !cpfValido(cpf)) return erro('CPF inválido. Confira os números ou deixe em branco.');
        if (!cpf && p.fid_token) cpf = F(db).sessoes[p.fid_token] || null;
        // Endereço salvo: só com o mesmo celular do pedido de onde ele veio.
        if (e.ref) {
          const ant = (db.pedidos || []).find((x) => x.id === e.ref && soDigitos(x.cliente.telefone) === tel);
          if (!ant) return erro('Endereço salvo não encontrado. Preencha o endereço.');
          e = { ...ant.endereco, ...(String(e.referencia || '').trim() ? { referencia: e.referencia } : {}) };
        }
        if (!String(e.rua || '').trim() || !String(e.numero || '').trim() || !String(e.bairro || '').trim()) return erro('Complete o endereço: rua, número e bairro.');
        if (!Array.isArray(p.itens) || !p.itens.length) return erro('O carrinho está vazio.');
        const todos = conf.cardapio.flatMap((c) => c.itens);
        const itens = [];
        for (const x of p.itens) {
          const it = todos.find((i) => i.id === x.id && i.delivery);
          if (!it) return erro('Um item do carrinho não está mais disponível. Atualize a página.');
          const c = opcoes.calcular(it, Array.isArray(x.opcoes) ? x.opcoes : []);
          if (c.erro) return erro(`${it.nome}: ${c.erro}`);
          itens.push({ id: it.id, nome: it.nome, preco: c.preco, qtd: Math.min(Math.max(Math.round(+x.qtd || 1), 1), 50), obs: String(x.obs || '').trim().slice(0, 140) || null, opcoes: c.rotulos });
        }
        const subtotal = Math.round(itens.reduce((t, i) => t + i.preco * i.qtd, 0) * 100) / 100;
        if (subtotal < (+d.minimo || 0)) return erro(`O pedido mínimo é ${brlTxt(+d.minimo)}.`);
        if (!(e.lat && e.lng) || !d.local) return erro('Não conseguimos localizar o endereço. Confira o CEP e o número.');
        const km = distanciaKm(d.local, e);
        const taxa = taxaEntrega(d, km);
        if (taxa == null) return erro(`Seu endereço está fora da área de entrega (${String(km).replace('.', ',')} km).`);
        const pg = p.pagamento || {};
        if (!['pix', 'cartao', 'dinheiro'].includes(pg.forma) || !d.pagamentos[pg.forma]) return erro('Escolha uma forma de pagamento.');
        const total = Math.round((subtotal + taxa) * 100) / 100;
        if (pg.forma === 'dinheiro' && pg.troco && +pg.troco < total) return erro('O troco precisa ser para um valor maior que o total.');
        const hoje = new Date().toDateString();
        db.pedidos = db.pedidos || [];
        const numero = db.pedidos.filter((x) => new Date(x.criado_em).toDateString() === hoje).reduce((m, x) => Math.max(m, x.numero), 0) + 1;
        const token = uid();
        db.pedidos.push({ id: uid(), token, numero, status: 'recebido', cliente: { nome, telefone: tel },
          endereco: { cep: soDigitos(e.cep).slice(0, 8), rua: e.rua, numero: e.numero, complemento: e.complemento || '', bairro: e.bairro, cidade: e.cidade || '', referencia: e.referencia || '', lat: +e.lat, lng: +e.lng },
          itens, subtotal, taxa, total, pagamento: { forma: pg.forma, troco: pg.forma === 'dinheiro' && pg.troco ? +pg.troco : null },
          obs: String(p.obs || '').trim().slice(0, 300) || null, distancia_km: km, entregador: null, motivo: null,
          historico: [{ status: 'recebido', em: nowIso() }], criado_em: nowIso(), atualizado_em: nowIso(), cpf });
        write(db);
        return { status: 'ok', token, numero, total };
      },
      async deliveryAcompanhar(token) {
        const db = read();
        const p = (db.pedidos || []).find((x) => x.token === token);
        if (!p) return null;
        const conf = mergeSettings(db.configuracao, true);
        const { lat, lng, ...endereco } = p.endereco;
        return { status: 'ok', pedido: { ...p, endereco, token: undefined, cliente: undefined, cpf: undefined, fid: { cpf: !!p.cpf, situacao: p.fid_situacao || null, pontos: p.fid_pontos ?? null } },
          restaurante: { nome: conf.restaurante.nome, telefone: conf.restaurante.telefone, whatsapp: conf.delivery.whatsapp, pix: p.pagamento.forma === 'pix' ? conf.delivery.pix : null, tempo: conf.delivery.tempo } };
      },
      /* ---------- Domínio próprio: demonstração (sem DNS de verdade, avança um passo a cada conferência) ---------- */
      async dominio() {
        const db = read();
        const d = db.dominio || {};
        return { slug: 'demo', dominio: d.dominio || null, status: d.status || null, mensagem: d.mensagem || null, ativo_em: d.ativo_em || null,
          alvo: 'tap.vortexsystems.tech', base: 'vortexsystems.tech', admin: true, plano_dominio: d.status === 'ativo' ? 'proprio' : 'sub' };
      },
      async dominioDefinir(dominio) {
        const v = String(dominio || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#:@\s].*$/, '').replace(/\.+$/, '');
        if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(v)) throw new Error('Domínio inválido. Use só o endereço, sem https:// (ex.: cardapio.seurestaurante.com.br).');
        if (v === 'vortexsystems.tech' || v.endsWith('.vortexsystems.tech')) throw new Error('Esse endereço já é da VTX Tap. Use um domínio do restaurante (ex.: cardapio.seurestaurante.com.br).');
        const db = read();
        if (!db.dominio || db.dominio.dominio !== v) db.dominio = { dominio: v, status: 'dns' };
        write(db);
        return this.dominio();
      },
      async dominioRemover() {
        const db = read();
        delete db.dominio;
        write(db);
        return this.dominio();
      },
      async dominioVerificar() {
        const db = read();
        const d = db.dominio;
        if (!d) return { status: 'ok', ...(await this.dominio()), registros: [] };
        const p = d.dominio.split('.');
        const zona = ['com.br', 'net.br', 'org.br'].includes(p.slice(-2).join('.')) ? p.slice(-3).join('.') : p.slice(-2).join('.');
        const raiz = zona === d.dominio;
        // A primeira conferência (ao abrir a tela) ainda não acha o registro, como na vida real.
        d.checks = (d.checks || 0) + 1;
        if (d.checks > 1) d.status = { dns: 'certificado', certificado: 'ativo', ativo: 'ativo' }[d.status];
        d.mensagem = d.status === 'certificado' ? 'DNS certo. Estamos gerando o certificado HTTPS: costuma levar poucos minutos.' : null;
        if (d.status === 'ativo') d.ativo_em = d.ativo_em || nowIso();
        write(db);
        const ok = d.status !== 'dns';
        return { status: 'ok', ...(await this.dominio()), raiz, zona, encontrado: ok ? 'CNAME apontando para tap.vortexsystems.tech' : 'nenhum registro ainda',
          registros: raiz ? [{ tipo: 'A', nome: '@', valor: '187.0.0.10', ok }] : [{ tipo: 'CNAME', nome: d.dominio.slice(0, -(zona.length + 1)), valor: 'tap.vortexsystems.tech', ok }] };
      },
      // Mesmas regras de public.delivery_enderecos.
      async deliveryEnderecos(telefone) {
        const db = read();
        const conf = mergeSettings(db.configuracao, true);
        let tel = soDigitos(telefone);
        if (/^55\d{10,11}$/.test(tel)) tel = tel.slice(2);
        if (!/^[1-9]\d{9,10}$/.test(tel)) return { status: 'erro', mensagem: 'Informe um celular com DDD.' };
        const vistos = new Set();
        const lista = [];
        let nome = null;
        for (const p of [...(db.pedidos || [])].sort((a, b) => (a.criado_em < b.criado_em ? 1 : -1))) {
          if (soDigitos(p.cliente.telefone) !== tel) continue;
          const e = p.endereco;
          const k = `${String(e.rua).toLowerCase()}|${e.numero}|${String(e.complemento || '').toLowerCase()}`;
          if (vistos.has(k)) continue;
          vistos.add(k);
          nome = nome || String(p.cliente.nome).split(' ')[0];
          const km = conf.delivery.local && e.lat ? distanciaKm(conf.delivery.local, e) : null;
          lista.push({ ref: p.id, rua: String(e.rua).slice(0, Math.max(3, Math.ceil(String(e.rua).length * 0.6))).trimEnd() + '•••',
            numero: String(e.numero).slice(0, 1) + (String(e.numero).length > 1 ? '•••' : ''), complemento: !!e.complemento,
            bairro: e.bairro, distancia: km, taxa: km == null ? null : taxaEntrega(conf.delivery, km) });
          if (lista.length === 3) break;
        }
        return lista.length ? { status: 'ok', nome, enderecos: lista } : { status: 'nenhum' };
      },
      // Demonstração: sem servidor de push; os avisos saem da própria página enquanto ela está aberta.
      async deliveryPushChave() {
        return null;
      },
      async deliveryPushInscrever() {
        return { status: 'ok' };
      },
      async deliveryPedidos({ desde } = {}) {
        const d = desde ? new Date(desde) : new Date(Date.now() - 24 * 3600e3);
        return (read().pedidos || []).filter((x) => new Date(x.criado_em) >= d).sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em));
      },
      async deliveryMudar(id, status, entregador, motivo) {
        const db = read();
        const p = (db.pedidos || []).find((x) => x.id === id);
        if (!p) throw new Error('Pedido não encontrado.');
        if (['entregue', 'cancelado'].includes(p.status) && status !== p.status) throw new Error('Este pedido já foi finalizado.');
        const antes = p.status;
        Object.assign(p, { status, entregador: (entregador || '').trim().slice(0, 60) || p.entregador, motivo: status === 'cancelado' ? (motivo || '').trim().slice(0, 160) || null : p.motivo, atualizado_em: nowIso() });
        p.historico.push({ status, em: nowIso(), por: quem(db) });
        // Entregue: os pontos do clube entram sozinhos.
        if (status === 'entregue' && antes !== 'entregue') creditarPedido(db, p);
        write(db);
      },
      async fidSefaz() {
        return { status: 'indisponivel' };
      },
      async fidRanking(token) {
        const db = read();
        if (!noAr(db) || (regras(db).ranking || {}).ativo === false) return { ativo: false };
        const f = F(db);
        const ganhos = new Map();
        for (const m of f.movimentos) {
          if (m.tipo === 'resgate' || (m.tipo === 'estorno' && m.resgate_id)) continue;
          ganhos.set(m.cpf, (ganhos.get(m.cpf) || 0) + m.pontos);
        }
        const lista = [...ganhos].filter(([, p]) => p > 0).map(([cpf, pontos]) => ({ cpf, pontos, nome: nomeCurto((cliDe(db, cpf) || {}).nome) }))
          .sort((a, b) => b.pontos - a.pontos || a.nome.localeCompare(b.nome));
        lista.forEach((x, i) => (x.pos = i && lista[i - 1].pontos === x.pontos ? lista[i - 1].pos : i + 1));
        const eu = token && f.sessoes[token];
        return {
          ativo: true,
          top: lista.slice(0, 10).map((x) => ({ pos: x.pos, nome: x.nome, pontos: x.pontos, voce: x.cpf === eu })),
          eu: eu ? { pos: (lista.find((x) => x.cpf === eu) || {}).pos || null, pontos: (lista.find((x) => x.cpf === eu) || {}).pontos || 0,
            favoritos: topProdutos(db, eu, 3650, 3).map((x) => x.descricao) } : null,
        };
      },
      async fidResgatar(token, premioId) {
        const db = read();
        const cpf = sessaoDe(db, token);
        if (!cpf) return { status: 'sem_sessao' };
        if (!noAr(db)) return { status: 'inativo' };
        const f = F(db);
        const p = f.premios.find((x) => x.id === premioId && x.ativo);
        if (!p) return { status: 'erro', mensagem: 'Este prêmio não está mais disponível.' };
        vencer(db, cpf);
        if (p.aniversario) {
          const cl = cliDe(db, cpf);
          if (!(regras(db).aniversario || {}).ativo) return { status: 'erro', mensagem: 'Este prêmio não está mais disponível.' };
          if (!cl.aniversario_mes) return { status: 'erro', mensagem: 'Informe o mês do seu aniversário na sua conta para liberar o presente.' };
          if (cl.aniversario_mes !== new Date().getMonth() + 1) return { status: 'erro', mensagem: 'Este presente é só no mês do seu aniversário.' };
          if (f.resgates.some((x) => x.cpf === cpf && x.premio_id === p.id && x.status !== 'cancelado' && new Date(x.criado_em).getFullYear() === new Date().getFullYear())) {
            return { status: 'erro', mensagem: 'Você já pegou este presente de aniversário este ano.' };
          }
        }
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
        if (p.pontos > 0) mover(db, cpf, 'resgate', -p.pontos, { descricao: `Resgate: ${p.nome}`, resgate_id: x.id, por: 'Cliente' });
        write(db);
        return { status: 'ok', pontos: c.pontos, resgate: { id: x.id, premio: p.nome, pontos: p.pontos, codigo: x.codigo, status: 'pendente', criado_em: x.criado_em } };
      },

      async fidDefinirAniversario(token, mes) {
        const db = read();
        const cpf = sessaoDe(db, token);
        if (!cpf) return { status: 'sem_sessao' };
        mes = Math.round(+mes);
        if (!(mes >= 1 && mes <= 12)) return { status: 'erro', mensagem: 'Escolha o mês.' };
        const c = cliDe(db, cpf);
        if (c.aniversario_mes) return { status: 'erro', mensagem: 'O mês do aniversário já está salvo. Para mudar, fale com a equipe.' };
        c.aniversario_mes = mes;
        bonusAniversario(db, cpf);
        write(db);
        return { status: 'ok' };
      },
      async fidTransferirDestino(token, destino) {
        const db = read();
        const cpf = sessaoDe(db, token);
        if (!cpf) return { status: 'sem_sessao' };
        if (!noAr(db)) return { status: 'inativo' };
        if (!(regras(db).transferencia || {}).ativo) return { status: 'erro', mensagem: 'A transferência de pontos está desligada neste restaurante.' };
        const d = destinoDe(db, destino);
        if (!d) return { status: 'erro', mensagem: 'Não achamos ninguém no clube com esse CPF ou código. A pessoa precisa estar cadastrada.' };
        if (d.cpf === cpf) return { status: 'erro', mensagem: 'Esse é você. Digite o CPF ou o código de outra pessoa.' };
        return { status: 'ok', nome: nomeCurto(d.nome) };
      },
      async fidTransferir(token, destino, pontos, pin) {
        const db = read();
        const cpf = sessaoDe(db, token);
        if (!cpf) return { status: 'sem_sessao' };
        if (!noAr(db)) return { status: 'inativo' };
        const t = regras(db).transferencia || {};
        if (!t.ativo) return { status: 'erro', mensagem: 'A transferência de pontos está desligada neste restaurante.' };
        const min = Math.max(+t.minimo || 1, 1);
        const max = Math.max(+t.maximoDia || 0, 0);
        pontos = Math.round(+pontos);
        if (!(pontos >= min)) return { status: 'erro', mensagem: `O mínimo para transferir é ${min} ${min === 1 ? 'ponto' : 'pontos'}.` };
        if (!/^\d{4}$/.test(pin || '')) return { status: 'erro', mensagem: 'O PIN tem 4 números.' };
        if (F(db).pins[cpf] !== await hashTxt(cpf + ':' + pin)) return { status: 'erro', mensagem: 'PIN incorreto.' };
        const d = destinoDe(db, destino);
        if (!d) return { status: 'erro', mensagem: 'Não achamos ninguém no clube com esse CPF ou código.' };
        if (d.cpf === cpf) return { status: 'erro', mensagem: 'Esse é você. Digite o CPF ou o código de outra pessoa.' };
        vencer(db, cpf);
        const eu = cliDe(db, cpf);
        if (eu.pontos < pontos) return { status: 'erro', mensagem: `Você tem ${Math.max(eu.pontos, 0)} pontos. Escolha uma quantidade menor.` };
        if (max > 0) {
          const hoje = diaIso(new Date());
          const ja = -F(db).movimentos.filter((m) => m.cpf === cpf && m.tipo === 'transferencia' && m.pontos < 0 && diaIso(new Date(m.criado_em)) === hoje).reduce((s2, m) => s2 + m.pontos, 0);
          if (ja + pontos > max) return { status: 'erro', mensagem: `O limite é ${max} pontos transferidos por dia. Hoje ainda dá para mandar ${Math.max(max - ja, 0)}.` };
        }
        mover(db, cpf, 'transferencia', -pontos, { descricao: `Transferência para ${nomeCurto(d.nome)}`, por: 'Cliente' });
        mover(db, d.cpf, 'transferencia', pontos, { descricao: `Transferência de ${nomeCurto(eu.nome)}`, por: 'Cliente' });
        write(db);
        return { status: 'ok', pontos: eu.pontos, nome: nomeCurto(d.nome) };
      },
      async fidTorcer(token, eventoId, time) {
        const db = read();
        const cpf = sessaoDe(db, token);
        if (!cpf) return { status: 'sem_sessao' };
        const f = evs(db);
        const e = f.eventos.find((x) => x.id === eventoId);
        if (!e) return { status: 'erro', mensagem: 'Evento não encontrado.' };
        const ja = f.torcidas.find((t) => t.evento_id === e.id && t.cpf === cpf);
        if (ja) return { status: ja.time === time ? 'ok' : 'erro', mensagem: `Você já escolheu ${ja.time}.` };
        if (e.vencedor || Date.now() >= fechaEvento(e)) return { status: 'erro', mensagem: 'A escolha do time já fechou: o jogo começou.' };
        if (!e.times.includes(time)) return { status: 'erro', mensagem: 'Escolha um dos times.' };
        f.torcidas.push({ evento_id: e.id, cpf, time, criado_em: nowIso() });
        write(db);
        return { status: 'ok' };
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
      async fidTopProdutos(cpf, dias) {
        return topProdutos(read(), cpf ? soDigitos(cpf) : null, dias || 90);
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
        return pts ?? 0;
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
          salvarItens(db, it.chave, cpf, it.emitida_em, it.itens);
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
            const calc = fidCalcular(r, x.valor, x.emitida_em, nivelDe(db, n.cpf), extraDe(db, n.cpf, x.emitida_em));
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
        if (!entregar && x.pontos > 0) mover(db, x.cpf, 'estorno', x.pontos, { descricao: `Resgate cancelado: ${x.premio_nome}`, resgate_id: x.id, por: quem(db) });
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
        const calc = fidCalcular(r, valor, nowIso(), nivelDe(db, cpf), extraDe(db, cpf, nowIso()));
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
      async fidEditarCliente(cpf, { nome, email, telefone, marketing, aniversario }) {
        const db = read();
        const c = cliDe(db, cpf);
        if (!c) falha('Cliente não encontrado.');
        nome = String(nome || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        email = String(email || '').trim().toLowerCase();
        telefone = soDigitos(telefone);
        if (!/^\S{2,}( \S+)+$/.test(nome)) falha('Informe o nome completo.');
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) falha('E-mail inválido.');
        if (!/^[1-9]\d{9,10}$/.test(telefone)) falha('Telefone inválido. Use DDD + número.');
        if (aniversario != null && aniversario !== '' && !(+aniversario >= 1 && +aniversario <= 12)) falha('Mês do aniversário inválido.');
        Object.assign(c, { nome, email, telefone, marketing: marketing == null ? c.marketing : !!marketing,
          aniversario_mes: aniversario != null && aniversario !== '' ? +aniversario : c.aniversario_mes || null });
        write(db);
      },
      async fidEventos() {
        const f = evs(read());
        return f.eventos.slice().sort((a, b) => (b.data + (b.hora || '')).localeCompare(a.data + (a.hora || ''))).slice(0, 40).map((e) => ({
          ...e, aberta: !e.vencedor && Date.now() < fechaEvento(e),
          torcida: f.torcidas.filter((t) => t.evento_id === e.id).reduce((o, t) => ({ ...o, [t.time]: (o[t.time] || 0) + 1 }), {}),
        }));
      },
      async fidEventoSalvar(ev) {
        const db = read();
        const f = evs(db);
        const vistos = new Set();
        const times = (ev.times || []).map((t) => String(t || '').trim().slice(0, 30)).filter((t) => t && !vistos.has(t.toLowerCase()) && vistos.add(t.toLowerCase()));
        if (times.length < 2 || times.length > 4) falha('Informe os dois times (até quatro).');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.data || '')) falha('Informe o dia do jogo.');
        const hora = String(ev.hora || '').trim() || null;
        if (!hora) falha('Informe a hora do jogo: a escolha do time fecha nessa hora.');
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) falha('Hora inválida (ex.: 16:00).');
        const dados = { nome: String(ev.nome || '').trim().slice(0, 60) || times.join(' x ').slice(0, 60), data: ev.data, hora, times,
          mult: Math.round(Math.min(Math.max(+ev.mult || 2, 1.1), 10) * 100) / 100 };
        const atual = ev.id && f.eventos.find((x) => x.id === ev.id);
        if (atual) {
          if (atual.vencedor) falha('Este evento já tem resultado.');
          if (f.torcidas.some((t) => t.evento_id === atual.id && !times.includes(t.time))) falha('Já tem torcedores escolhendo os times: não dá para trocar os times.');
          Object.assign(atual, dados);
        } else {
          if (ev.data < diaIso(new Date())) falha('O dia do jogo já passou.');
          f.eventos.push({ id: uid(), ...dados, vencedor: null, premiados: null, pontos_pagos: null, resultado_em: null, criado_em: nowIso() });
        }
        write(db);
      },
      async fidEventoExcluir(id) {
        const db = read();
        const f = evs(db);
        const e = f.eventos.find((x) => x.id === id && !x.vencedor);
        if (!e) falha('Evento não encontrado ou já com resultado.');
        f.eventos = f.eventos.filter((x) => x !== e);
        f.torcidas = f.torcidas.filter((t) => t.evento_id !== id);
        write(db);
      },
      async fidEventoResultado(id, vencedor) {
        const db = read();
        const f = evs(db);
        const e = f.eventos.find((x) => x.id === id);
        if (!e) falha('Evento não encontrado.');
        if (e.vencedor) falha('O resultado já foi lançado.');
        if (Date.now() < fechaEvento(e)) falha('O jogo ainda não começou.');
        if (!(e.times.includes(vencedor) || vencedor === 'empate')) falha('Escolha o time vencedor ou empate.');
        Object.assign(e, { vencedor, resultado_em: nowIso(), resultado_por: quem(db) });
        let n = 0; let total = 0;
        if (vencedor !== 'empate') {
          for (const t of f.torcidas.filter((x) => x.evento_id === e.id && x.time === vencedor)) {
            const doDia = (iso) => iso && diaIso(new Date(iso)) === e.data;
            const base = f.notas.filter((x) => x.cpf === t.cpf && x.status === 'creditada' && doDia(x.emitida_em)).reduce((s2, x) => s2 + (x.pontos || 0), 0)
              + (db.pedidos || []).filter((x) => x.cpf === t.cpf && x.fid_situacao === 'creditado' && doDia(x.criado_em)).reduce((s2, x) => s2 + (x.fid_pontos || 0), 0)
              + f.movimentos.filter((x) => x.cpf === t.cpf && x.tipo === 'manual' && doDia(x.criado_em)).reduce((s2, x) => s2 + x.pontos, 0);
            const b = Math.floor(base * (e.mult - 1));
            if (b > 0) {
              mover(db, t.cpf, 'evento', b, { descricao: `${e.nome}: ${vencedor} venceu (${String(e.mult).replace('.', ',')}x)`, mult: e.mult, por: quem(db) });
              n++; total += b;
            }
          }
        }
        Object.assign(e, { premiados: n, pontos_pagos: total });
        write(db);
        return { premiados: n, pontos: total };
      },
      async fidPremios() {
        return F(read()).premios.slice().sort((a, b) => a.ordem - b.ordem || a.pontos - b.pontos);
      },
      async fidSalvarPremio(p) {
        const db = read();
        const f = F(db);
        const dados = { nome: String(p.nome || '').trim().slice(0, 60), descricao: String(p.descricao || '').trim().slice(0, 160), pontos: Math.round(+p.pontos || 0), imagem: p.imagem || '', ativo: p.ativo !== false, ordem: +p.ordem || 0, nivel_min: p.nivel_min || null, aniversario: !!p.aniversario };
        if (!dados.nome) falha('Informe o nome do prêmio.');
        if (!(dados.pontos >= (dados.aniversario ? 0 : 1) && dados.pontos <= 1e6)) falha(dados.aniversario ? 'Informe quantos pontos custa o presente (0 = de graça).' : 'Informe quantos pontos vale o prêmio.');
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

      /* ---------- Prorrogação (mesmas regras de public.hh_*) ---------- */
      async hhStatus() {
        const db = read();
        const st = hhStatusDe(db);
        write(db);
        return st;
      },
      async hhPainel() {
        const db = read();
        const st = hhStatusDe(db);
        write(db);
        const h = HH(db);
        const atual = st.sessao ? st.sessao.id : (h.sessoes[h.sessoes.length - 1] || {}).id;
        return { ...st, config: mergeSettings(db.configuracao, true).prorrogacao,
          leituras: h.leituras.filter((l) => l.sessao_id === atual).slice(-15).reverse(),
          historico: h.sessoes.slice(-20).reverse().map((x) => ({ id: x.id, nome: x.nome, inicio: x.inicio, fim: x.encerrada_em || x.fim, aberta: !x.encerrada_em,
            motivo: x.motivo, leituras: x.leituras, minutos_ganhos: x.minutos_ganhos, criado_por: x.criado_por })) };
      },
      async hhComecar(min) {
        const db = read();
        const c = hhExigir(db);
        hhTick(db);
        if (hhAberta(db)) falha(`Já tem uma ${c.nome} rolando.`);
        const m = Math.min(Math.max(Math.round(+min || c.duracao), 1), 600);
        const agora = Date.now();
        HH(db).sessoes.push({ id: uid(), nome: c.nome, inicio: new Date(agora).toISOString(), fim: new Date(Math.min(agora + m * 60e3, hhLimite(c, agora))).toISOString(),
          encerrada_em: null, motivo: null, leituras: 0, minutos_ganhos: 0, criado_por: quem(db), agenda_dia: null });
        write(db);
        return this.hhPainel();
      },
      async hhSomar(qtd = 1) {
        const db = read();
        const c = hhExigir(db);
        hhTick(db);
        const s = hhAberta(db);
        if (!s) falha(`A ${c.nome} não está rolando agora.`);
        const q = Math.min(Math.max(Math.round(+qtd || 1), 1), 50);
        const pedido = q * c.minutos;
        let m = c.teto > 0 ? Math.min(pedido, Math.max(c.teto - s.minutos_ganhos, 0)) : pedido;
        const fim = new Date(s.fim).getTime();
        m = Math.max(Math.round(((Math.min(fim + m * 60e3, hhLimite(c, new Date(s.inicio).getTime())) - fim) / 60e3) * 100) / 100, 0);
        Object.assign(s, { fim: new Date(fim + m * 60e3).toISOString(), leituras: s.leituras + q, minutos_ganhos: Math.round((s.minutos_ganhos + m) * 100) / 100 });
        HH(db).leituras.push({ id: uid(), sessao_id: s.id, em: nowIso(), qtd: q, minutos: m, por: quem(db), desfeita: false });
        write(db);
        return { ...(await this.hhPainel()), adicionados: m, travado: m < pedido };
      },
      async hhDesfazer() {
        const db = read();
        hhExigir(db);
        hhTick(db);
        const s = hhAberta(db);
        if (!s) falha('Não tem nada rolando para desfazer.');
        const l = HH(db).leituras.filter((x) => x.sessao_id === s.id && !x.desfeita).pop();
        if (!l) falha('Nenhuma leitura para desfazer.');
        Object.assign(l, { desfeita: true, desfeita_em: nowIso(), desfeita_por: quem(db) });
        Object.assign(s, { fim: new Date(new Date(s.fim).getTime() - l.minutos * 60e3).toISOString(), leituras: s.leituras - l.qtd,
          minutos_ganhos: Math.round((s.minutos_ganhos - l.minutos) * 100) / 100 });
        hhTick(db);
        write(db);
        return this.hhPainel();
      },
      async hhEncerrar() {
        const db = read();
        hhTick(db);
        const s = hhAberta(db);
        if (!s) falha('Não tem nada rolando agora.');
        Object.assign(s, { encerrada_em: nowIso(), fim: new Date(Math.min(new Date(s.fim).getTime(), Date.now())).toISOString(), motivo: 'equipe' });
        write(db);
        return this.hhPainel();
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
    const equipe = () => {
      const eq = read().equipe || { senhaHash: null, membros: [] };
      // Equipes salvas antes dos administradores: a primeira conta vira administradora.
      if (eq.membros.length && !eq.membros.some((m) => m.admin)) eq.membros = eq.membros.map((m, i) => (i ? m : { ...m, admin: true }));
      return eq;
    };
    const salvar = (eq) => write({ ...read(), equipe: eq });
    const falha = (msg) => { throw new Error(msg); };
    const getSess = () => { try { return JSON.parse(localStorage.getItem(SESSAO)); } catch { return null; } };
    const abrir = (m) => { try { localStorage.setItem(SESSAO, JSON.stringify({ id: m.id })); } catch {} };

    const eu = () => { const x = getSess(); return x && equipe().membros.find((m) => m.id === x.id); };
    const soAdmin = () => { const m = eu(); if (!m) falha('Entre com seu PIN para continuar.'); if (!m.admin) falha('Só o administrador do restaurante pode fazer isso.'); return m; };
    const pinLivre = async (pin, menos) => {
      const h = await hash('pin:' + pin);
      if (equipe().membros.some((x) => x.pinHash === h && x.id !== menos)) falha('Esse PIN já está em uso. Escolha outro.');
      return h;
    };

    return {
      async estado() {
        return { temSenha: !!equipe().senhaHash, temEquipe: equipe().membros.length > 0 };
      },
      async entrar(pin) {
        if (!/^\d{4,8}$/.test(pin)) falha('O PIN tem de 4 a 8 números.');
        const h = await hash('pin:' + pin);
        const m = equipe().membros.find((x) => x.pinHash === h);
        if (!m) falha('PIN não encontrado. Confira o número ou peça ao administrador.');
        abrir(m);
        return { nome: m.nome, admin: !!m.admin };
      },
      // Cadastro com o código da equipe: a primeira conta vira administradora; as outras entram como equipe.
      async cadastrar({ nome, pin, senhaEquipe }) {
        nome = String(nome || '').trim().slice(0, 60);
        if (!nome) falha('Informe seu nome.');
        if (!/^\d{4,8}$/.test(pin)) falha('O PIN precisa ter de 4 a 8 números.');
        if (String(senhaEquipe || '').length < 6) falha('O código da equipe tem pelo menos 6 caracteres.');
        const eq = equipe();
        const senhaHash = await hash('senha:' + senhaEquipe);
        if (eq.senhaHash && eq.senhaHash !== senhaHash) falha('Código da equipe incorreto. Peça o código ao administrador do restaurante.');
        const pinHash = await pinLivre(pin);
        const primeira = !eq.membros.length;
        const m = { id: uid(), nome, pinHash, admin: primeira, criado_em: nowIso() };
        salvar({ senhaHash: eq.senhaHash || senhaHash, membros: [...eq.membros, m] });
        abrir(m);
        return { nome, admin: primeira, primeiraConta: primeira };
      },
      async sessao() {
        const m = eu();
        return m ? { nome: m.nome, id: m.id, admin: !!m.admin } : null;
      },
      async sair() {
        try { localStorage.removeItem(SESSAO); } catch {}
      },
      async membros() {
        const x = eu();
        return equipe().membros.map((m) => ({ id: m.id, nome: m.nome, criado_em: m.criado_em, admin: !!m.admin, voce: !!x && x.id === m.id }));
      },
      async adicionar({ nome, pin, admin }) {
        soAdmin();
        nome = String(nome || '').trim().slice(0, 60);
        if (!nome) falha('Informe o nome da pessoa.');
        if (!/^\d{4,8}$/.test(pin)) falha('O PIN precisa ter de 4 a 8 números.');
        const pinHash = await pinLivre(pin);
        const eq = equipe();
        salvar({ ...eq, membros: [...eq.membros, { id: uid(), nome, pinHash, admin: !!admin, criado_em: nowIso() }] });
      },
      async trocarPin(id, pin) {
        const x = eu();
        if (!x) falha('Entre com seu PIN para continuar.');
        id = id || x.id;
        if (id !== x.id && !x.admin) falha('Só o administrador troca o PIN de outra pessoa.');
        if (!/^\d{4,8}$/.test(pin)) falha('O PIN precisa ter de 4 a 8 números.');
        const pinHash = await pinLivre(pin, id);
        const eq = equipe();
        salvar({ ...eq, membros: eq.membros.map((m) => (m.id === id ? { ...m, pinHash } : m)) });
      },
      async definirAdmin(id, admin) {
        soAdmin();
        const eq = equipe();
        if (!admin && eq.membros.filter((m) => m.admin && m.id !== id).length === 0) falha('O restaurante precisa de pelo menos um administrador.');
        salvar({ ...eq, membros: eq.membros.map((m) => (m.id === id ? { ...m, admin: !!admin } : m)) });
      },
      async remover(id) {
        const x = soAdmin();
        if (id === x.id) falha('Você não pode remover a si mesmo.');
        const eq = equipe();
        salvar({ ...eq, membros: eq.membros.filter((m) => m.id !== id) });
      },
      async trocarSenha(senha) {
        soAdmin();
        if (String(senha || '').length < 6) falha('O código da equipe precisa ter pelo menos 6 caracteres.');
        salvar({ ...equipe(), senhaHash: await hash('senha:' + senha) });
      },
    };
  }

  /* ---------- Modo produção: Supabase (Postgres + Realtime) ----------
     Um banco para todos os restaurantes: tudo é filtrado pelo restaurante
     deste endereço (subdomínio), e as regras do banco garantem o isolamento. */
  function SupabaseAdapter() {
    const { supabaseUrl, supabaseAnonKey } = cfg.backend;
    // Restaurante deste endereço: o subdomínio (ou ?r=). Num domínio próprio, sai de restaurante_por_dominio no init.
    let slug = cfg.backend.slug;
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
        let r = null;
        // Domínio próprio (ex.: cardapio.seurestaurante.com.br): o restaurante sai do endereço cadastrado.
        if (cfg.backend.dominio) {
          r = must(await sb.rpc('restaurante_por_dominio', { p_host: cfg.backend.dominio }));
          if (r) slug = cfg.backend.slug = r.slug;
        }
        if (!r && slug) r = must(await sb.rpc('restaurante_publico', { p_slug: slug }));
        if (!r) throw Object.assign(new Error('Restaurante não encontrado.'), { code: 'SEM_RESTAURANTE' });
        rid = r.id;
        this.restaurante = { id: r.id, slug: r.slug, nome: r.nome };
        if (realtimeAll) {
          const ch = sb.channel('painel-' + rid);
          for (const table of ['chamados', 'comentarios', 'sessoes', 'mesas_abertas', 'etiquetas', 'fid_notas', 'fid_resgates', 'pedidos']) {
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
        // Mesas ainda não configuradas: começa com as contratadas no plano.
        if (row && !row.mesas && s.plano.mesas < 500) s.mesas = { total: s.plano.mesas, areas: [{ nome: 'Salão', de: 1, ate: s.plano.mesas }] };
        // Nome cadastrado na central até a equipe definir o dela.
        if (row && !(row.restaurante && row.restaurante.nome)) s.restaurante = { ...s.restaurante, nome: row.nome };
        return s;
      },
      async updateSettings(patch) {
        must(await sb.rpc('salvar_config', { p_patch: patch }));
        return this.getSettings();
      },
      async meuPlano() {
        return must(await sb.rpc('meu_plano'));
      },
      async alterarPlano(plano) {
        return must(await sb.rpc('meu_plano_alterar', { p_plano: plano }));
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
      async fidCadastrar({ cpf, nome, email, telefone, pin, marketing, indicacao, aniversario }) {
        return must(await sb.rpc('fid_cadastrar', {
          p_restaurante: rid, p_cpf: soDigitos(cpf), p_nome: nome, p_email: email, p_telefone: telefone,
          p_pin: pin, p_marketing: !!marketing, p_indicacao: indicacao || null, p_aniversario: +aniversario || null,
        }));
      },
      async fidDefinirAniversario(token, mes) {
        return must(await sb.rpc('fid_definir_aniversario', { p_token: token, p_mes: +mes || null }));
      },
      async fidTransferirDestino(token, destino) {
        return must(await sb.rpc('fid_transferir_destino', { p_token: token, p_destino: destino }));
      },
      async fidTransferir(token, destino, pontos, pin) {
        return must(await sb.rpc('fid_transferir', { p_token: token, p_destino: destino, p_pontos: Math.round(+pontos) || 0, p_pin: pin }));
      },
      async fidTorcer(token, eventoId, time) {
        return must(await sb.rpc('fid_torcer', { p_token: token, p_evento: eventoId, p_time: time }));
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
      async fidNotaSituacao({ cpf, qr }) {
        try {
          return must(await sb.rpc('fid_nota_situacao', { p_restaurante: rid, p_cpf: soDigitos(cpf), p_qr: qr }));
        } catch {
          return { status: 'nova' }; // na dúvida segue; o registro confere de novo
        }
      },
      async fidRegistrarNota({ cpf, qr, valor }) {
        return must(await sb.rpc('fid_registrar_nota', { p_restaurante: rid, p_cpf: soDigitos(cpf), p_qr: qr, p_valor: valor || null }));
      },
      // Conferência automática na SEFAZ (função "nfce"). 'indisponivel' / 'falhou' / 'limite' / 'xml': segue o fluxo com a equipe.
      async fidSefaz({ cpf, qr }) {
        if (!rid) return { status: 'indisponivel' };
        try {
          const r = await fetch(`${supabaseUrl}/functions/v1/nfce`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: supabaseAnonKey, Authorization: `Bearer ${supabaseAnonKey}` },
            body: JSON.stringify({ restaurante: rid, cpf: soDigitos(cpf), qr }),
            signal: AbortSignal.timeout ? AbortSignal.timeout(75000) : undefined,
          });
          if (!r.ok) return { status: 'indisponivel' };
          return await r.json();
        } catch {
          return { status: 'falhou' };
        }
      },
      async fidRanking(token) {
        return must(await sb.rpc('fid_ranking', { p_restaurante: rid, p_token: token || null }));
      },
      async fidTopProdutos(cpf, dias) {
        return must(await sb.rpc('fid_top_produtos', { p_cpf: cpf || null, p_dias: dias || 90 }));
      },

      /* ---------- Delivery ---------- */
      async deliveryPedir(pedido) {
        return must(await sb.rpc('delivery_pedir', { p_restaurante: rid, p_pedido: pedido }));
      },
      async deliveryAcompanhar(token) {
        return must(await sb.rpc('delivery_acompanhar', { p_token: token }));
      },
      /* ---------- Domínio próprio (Ajustes › Endereço) ---------- */
      async dominio() {
        return must(await sb.rpc('meu_dominio'));
      },
      async dominioDefinir(dominio) {
        return must(await sb.rpc('dominio_definir', { p_dominio: dominio }));
      },
      async dominioRemover() {
        return must(await sb.rpc('dominio_remover'));
      },
      // Confere o DNS e o HTTPS agora (função "dominio") e devolve os registros a criar.
      async dominioVerificar() {
        const token = (await sb.auth.getSession()).data.session?.access_token;
        const r = await fetch(`${supabaseUrl}/functions/v1/dominio`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: supabaseAnonKey, Authorization: `Bearer ${token || supabaseAnonKey}` },
          body: JSON.stringify({ acao: 'verificar' }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.mensagem || 'Não foi possível conferir agora. Tente de novo em instantes.');
        return j;
      },
      // Endereços já usados, achados pelo celular (resumo mascarado + taxa; para pedir vai só a referência).
      async deliveryEnderecos(telefone) {
        return must(await sb.rpc('delivery_enderecos', { p_restaurante: rid, p_telefone: soDigitos(telefone) }));
      },
      // Avisos do pedido (Web Push): chave pública VAPID da função "push" e inscrição do aparelho.
      async deliveryPushChave() {
        const r = await fetch(`${supabaseUrl}/functions/v1/push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: supabaseAnonKey, Authorization: `Bearer ${supabaseAnonKey}` },
          body: JSON.stringify({ acao: 'chave' }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.chave) throw new Error('Os avisos não estão disponíveis agora.');
        return j.chave;
      },
      async deliveryPushInscrever(token, inscricao, url) {
        return must(await sb.rpc('delivery_push', { p_token: token, p_sub: inscricao, p_url: url }));
      },
      async deliveryPedidos({ desde } = {}) {
        const d = desde ? new Date(desde) : new Date(Date.now() - 24 * 3600e3);
        return must(await sb.from('pedidos').select('*').eq('restaurante_id', rid).gte('criado_em', d.toISOString()).order('criado_em', { ascending: false }).limit(300));
      },
      async deliveryMudar(id, status, entregador, motivo) {
        must(await sb.rpc('delivery_mudar', { p_id: id, p_status: status, p_entregador: entregador || null, p_motivo: motivo || null }));
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
      async fidEditarCliente(cpf, { nome, email, telefone, marketing, aniversario }) {
        must(await sb.rpc('fid_editar_cliente', { p_cpf: cpf, p_nome: nome, p_email: email, p_telefone: telefone, p_marketing: marketing == null ? null : !!marketing,
          p_aniversario: +aniversario || null }));
      },
      async fidEventos() {
        return must(await sb.rpc('fid_eventos_lista'));
      },
      async hhStatus() {
        return must(await sb.rpc('hh_status', { p_restaurante: rid }));
      },
      async hhPainel() {
        return must(await sb.rpc('hh_painel'));
      },
      async hhComecar(minutos) {
        return must(await sb.rpc('hh_comecar', { p_minutos: +minutos || null }));
      },
      async hhSomar(qtd = 1) {
        return must(await sb.rpc('hh_somar', { p_qtd: +qtd || 1 }));
      },
      async hhDesfazer() {
        return must(await sb.rpc('hh_desfazer'));
      },
      async hhEncerrar() {
        return must(await sb.rpc('hh_encerrar'));
      },
      async fidEventoSalvar(e) {
        return must(await sb.rpc('fid_evento_salvar', { p: e }));
      },
      async fidEventoExcluir(id) {
        must(await sb.rpc('fid_evento_excluir', { p_id: id }));
      },
      async fidEventoResultado(id, vencedor) {
        return must(await sb.rpc('fid_evento_resultado', { p_id: id, p_vencedor: vencedor }));
      },
      async fidPremios() {
        return must(await sb.from('fid_premios').select('*').eq('restaurante_id', rid).order('ordem').order('pontos'));
      },
      async fidSalvarPremio(p) {
        const dados = {
          nome: String(p.nome || '').trim().slice(0, 60), descricao: String(p.descricao || '').trim().slice(0, 160),
          pontos: Math.round(+p.pontos || 0), imagem: p.imagem || '', ativo: p.ativo !== false, ordem: +p.ordem || 0, nivel_min: p.nivel_min || null,
          aniversario: !!p.aniversario,
        };
        if (!dados.nome) throw new Error('Informe o nome do prêmio.');
        if (!(dados.pontos >= (dados.aniversario ? 0 : 1) && dados.pontos <= 1e6)) {
          throw new Error(dados.aniversario ? 'Informe quantos pontos custa o presente (0 = de graça).' : 'Informe quantos pontos vale o prêmio.');
        }
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
          return { nome: r.nome, admin: !!r.admin };
        },
        async cadastrar({ nome, pin, senhaEquipe }) {
          const r = await this.chamar('cadastrar', { nome, pin, senhaEquipe });
          must(await sb.auth.setSession(r.sessao));
          return { nome: r.nome, admin: !!r.admin, primeiraConta: r.primeiraConta };
        },
        async sessao() {
          const { data } = await sb.auth.getSession();
          if (!data.session) return null;
          // Confere no servidor: quem foi removido da equipe perde o acesso.
          const { data: u, error } = await sb.auth.getUser();
          if (error && !(error.status >= 400 && error.status < 500)) throw error; // sem internet: mantém a sessão
          if (error || !u.user) {
            await sb.auth.signOut();
            return null;
          }
          const { data: m, error: e2 } = await sb.rpc('eu_membro');
          if (e2) throw e2; // falha de rede/servidor: não derruba a sessão
          if (!m || (rid && m.restaurante_id !== rid)) {
            await sb.auth.signOut();
            return null;
          }
          return { nome: m.nome || 'Equipe', id: u.user.id, admin: !!m.admin };
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
        async adicionar({ nome, pin, admin }) {
          await this.chamar('adicionar', { nome, pin, admin: !!admin }, true);
        },
        async trocarPin(id, pin) {
          await this.chamar('trocar_pin', { id: id || undefined, pin }, true);
        },
        async definirAdmin(id, admin) {
          await this.chamar('admin', { id, admin: !!admin }, true);
        },
        async trocarSenha(senha) {
          await this.chamar('trocar_senha', { senha }, true);
        },
      },
    };
  }

  window.Store = {
    // Ajustes iniciais (antes de carregar o que foi salvo): demonstração ou restaurante em branco.
    padrao: (demo) => mergeSettings(null, demo),
    precoPlano,
    // Regras do programa de fidelidade usadas também pelas telas (validação e simulação).
    delivery: { PADRAO: DELIVERY_PADRAO, distanciaKm, taxa: taxaEntrega },
    prorrogacao: { PADRAO: PRORROGACAO_PADRAO, cfg: hhCfg, frase: hhFrase },
    opcoes,
    fid: { PADRAO: FID_PADRAO, cpfValido, chaveValida, chaveDoTexto, valorDoQr, boost: fidBoost, calcular: fidCalcular, niveis: fidNiveis, nivelDe: fidNivelDe, soDigitos },
    create() {
      const b = cfg.backend || {};
      if (b.tipo === 'supabase' && b.supabaseUrl && b.supabaseAnonKey) return SupabaseAdapter();
      return LocalAdapter();
    },
  };
})();
