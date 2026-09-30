/*
 * Programa de fidelidade na página da mesa.
 * O CPF acha a conta (primeiro nome e saldo); o PIN de 4 números libera o
 * extrato, o resgate de prêmios e o código de indicação. O aparelho lembra.
 * Pontos entram pela nota fiscal: o cliente lê o QR da NFC-e (com CPF na nota)
 * e o restaurante confere pelo XML ou à mão.
 *
 *   Fidelidade.iniciar({ store, slug, nomeRestaurante }) → programa (ou null)
 *   Fidelidade.tile() → HTML do atalho na página
 *   Fidelidade.abrir()
 */
(function () {
  const { $, esc, brl, icon, toast, copyText, openSheet } = UI;
  const F = Store.fid;
  const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

  let store = null;
  let prog = null;
  let chave = 'fid';
  let nomeRest = '';
  const S = { cpf: null, nome: null, pontos: null, nivel: null, pendentes: 0, token: null, conta: null, tela: 'inicio', indicacao: '', indicador: null, aviso: null, premio: null, resgate: null, ocupado: false };

  const ler = () => { try { return JSON.parse(localStorage.getItem(chave)) || {}; } catch { return {}; } };
  const gravar = () => { try { localStorage.setItem(chave, JSON.stringify({ cpf: S.cpf, nome: S.nome, pontos: S.pontos, nivel: S.nivel, token: S.token })); } catch {} };
  const esquecer = () => { Object.assign(S, { cpf: null, nome: null, pontos: null, nivel: null, pendentes: 0, token: null, conta: null }); try { localStorage.removeItem(chave); } catch {} };

  const fmtCpf = (c) => F.soDigitos(c).slice(0, 11).replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  const fmtTel = (t) => {
    const d = F.soDigitos(t).slice(0, 11);
    if (d.length <= 2) return d;
    if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  };
  const num = (n) => Number(n || 0).toLocaleString('pt-BR');
  const pts = (n) => `${num(n)} ${Math.abs(n) === 1 ? 'ponto' : 'pontos'}`;
  const dataCurta = (iso) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

  // "1 ponto a cada R$ 1", "2 pontos a cada R$ 1", "1 ponto a cada R$ 2".
  function regraTexto() {
    const p = Number(prog.pontosPorReal) || 0;
    if (p >= 1) return `${num(p)} ${p === 1 ? 'ponto' : 'pontos'} a cada R$ 1`;
    if (p > 0) return `1 ponto a cada ${brl(1 / p).replace(',00', '')}`;
    return 'pontos nas suas compras';
  }
  const PLURAL = ['domingos', 'segundas', 'terças', 'quartas', 'quintas', 'sextas', 'sábados'];
  // "às terças", "de segunda a sexta", "às segundas, quartas e sextas", "todo dia".
  function diasTexto(dias) {
    const d = [...new Set(dias || [])].sort();
    if (!d.length || d.length === 7) return 'todo dia';
    if (d.length === 1) return `${d[0] === 0 || d[0] === 6 ? 'aos' : 'às'} ${PLURAL[d[0]]}`;
    if (d.length > 2 && d[d.length - 1] - d[0] === d.length - 1) return `de ${DIAS[d[0]]} a ${DIAS[d[d.length - 1]]}`;
    const n = d.map((x) => PLURAL[x]);
    return `${d[0] === 0 || d[0] === 6 ? 'aos' : 'às'} ${n.slice(0, -1).join(', ')} e ${n[n.length - 1]}`;
  }
  const multTexto = (m) => (m === 2 ? 'pontos em dobro' : m === 3 ? 'pontos em triplo' : `${String(m).replace('.', ',')}x pontos`);
  function boostTexto(b) {
    const hora = b.de && b.ate ? `, das ${b.de.replace(':00', 'h')} às ${b.ate.replace(':00', 'h')}` : '';
    const periodo = b.fim ? `, até ${b.fim.split('-').reverse().slice(0, 2).join('/')}` : '';
    return `${multTexto(b.mult)} ${diasTexto(b.dias)}${hora}${periodo}`;
  }
  const boostAgora = () => {
    const b = F.boost({ boosts: prog.boosts }, new Date());
    return b.mult > 1 ? b : null;
  };

  /* ---------- Atalho na página ---------- */
  function tile() {
    if (!prog || !prog.ativo) return '';
    const agora = boostAgora();
    const conhecido = S.cpf && S.pontos != null;
    return `<button type="button" class="tile tile--fid" data-fid-abrir>
      <span class="tile-fid-top">${icon('gift')} ${esc(prog.nome)}${conhecido && S.nivel ? ` <span class="fid-selo" style="--nv:${esc(S.nivel.cor)}">${esc(S.nivel.nome)}</span>` : ''}</span>
      <div><h3>${conhecido ? pts(S.pontos) : 'Ganhe pontos'}</h3>
        <p>${conhecido ? `Olá, ${esc(S.nome || '')}! Leia a nota e troque por prêmios.` : `${esc(regraTexto())} e troque por prêmios.`}${agora ? ` <b>Agora: ${multTexto(agora.mult)}!</b>` : ''}</p></div>
      <span class="tile-go">${icon('arrow')}</span>
    </button>`;
  }
  const atualizarTile = () => {
    const t = document.querySelector('[data-fid-abrir]');
    if (t) t.outerHTML = tile();
  };

  /* ---------- Telas ---------- */
  const corpo = () => $('#fidBody');
  function render() {
    const html = {
      inicio: tInicio, cadastro: tCadastro, conta: tConta, pin: tPin, resultado: tResultado, valor: tValor, ranking: tRanking,
      resgatar: tResgatar, codigo: tCodigo, indicar: tIndicar, regulamento: tRegulamento, niveis: tNiveis,
    }[S.tela]();
    corpo().innerHTML = html;
    $('#fidTitle').textContent = S.tela === 'inicio' ? nomeRest || 'Fidelidade' : S.tela === 'niveis' ? 'Níveis do clube' : S.tela === 'ranking' ? 'Ranking do clube' : prog.nome;
    const foco = corpo().querySelector('[data-foco]');
    if (foco) setTimeout(() => foco.focus(), 60);
  }
  const ir = (tela) => { if (tela !== 'valor') pararOcr(); S.tela = tela; render(); corpo().scrollTop = 0; };

  const boosts = () => (prog.boosts || []).length
    ? `<ul class="fid-boosts">${prog.boosts.map((b) => `<li>${icon('sparkle')}<span>${b.nome ? `<b>${esc(b.nome)}</b> · ` : ''}${esc(boostTexto(b))}</span></li>`).join('')}</ul>` : '';

  /* ---------- Níveis do clube ---------- */
  const temNiveis = () => !!(prog.niveis && prog.niveis.ativo && (prog.niveis.lista || []).length);
  const pct = (m) => Math.round((m - 1) * 100);
  const vantagens = (l) => [
    ...(l.mult > 1 ? [`${pct(l.mult)}% a mais de pontos em cada compra`] : []),
    ...(l.bonus > 0 ? [`${pts(l.bonus)} de bônus ao chegar`] : []),
    ...(l.beneficios || []),
  ];
  const nivelDoId = (id) => (prog.niveis.lista || []).findIndex((l) => l.id === id);
  // Cartão do nível atual com a barra até o próximo.
  function meuNivel(link = true) {
    const n = S.nivel;
    if (!temNiveis() || !n) return '';
    const prox = n.proximo;
    const feito = prox ? Math.max(3, Math.min(100, Math.round(((n.pontos_nivel - n.minimo) / Math.max(prox.minimo - n.minimo, 1)) * 100))) : 100;
    const tag = link ? 'button' : 'div';
    return `<${tag} ${link ? 'type="button" data-fid-ir="niveis"' : ''} class="fid-nivel" style="--nv:${esc(n.cor)}">
      <span class="fid-nivel-top"><span class="fid-selo">${esc(n.nome)}</span>${n.descricao ? `<small>${esc(n.descricao)}</small>` : ''}${link ? icon('arrow') : ''}</span>
      ${prox ? `<span class="fid-barra fid-barra--nv"><i style="width:${feito}%"></i></span>
        <small>Faltam <b>${pts(prox.falta)}</b> para <b style="color:${esc(prox.cor)}">${esc(prox.nome)}</b></small>`
        : '<small>Você está no nível mais alto do clube. Obrigado pela preferência!</small>'}
    </${tag}>`;
  }
  function tNiveis() {
    const n = prog.niveis;
    const atual = S.nivel ? S.nivel.id : null;
    return `<div class="stack-lg fid">
      <p class="muted">Os níveis sobem com os pontos que você ganha nas compras${n.base === 'meses' ? ` nos últimos ${n.meses} ${n.meses === 1 ? 'mês' : 'meses'}` : ''}. Trocar pontos por prêmios não faz você cair de nível.${n.base === 'meses' ? ' Compras mais antigas deixam de contar.' : ''}</p>
      ${meuNivel(false)}
      <ol class="fid-niveis">${n.lista.map((l) => `<li class="${l.id === atual ? 'is-atual' : ''}" style="--nv:${esc(l.cor)}">
        <div class="fid-niveis-h"><span class="fid-selo">${esc(l.nome)}</span><small>${l.minimo ? `a partir de ${pts(l.minimo)}` : 'ao se cadastrar'}</small>${l.id === atual ? '<b class="fid-voce">Você</b>' : ''}</div>
        ${l.descricao ? `<p>${esc(l.descricao)}</p>` : ''}
        ${vantagens(l).length ? `<ul>${vantagens(l).map((v) => `<li>${icon('check')} ${esc(v)}</li>`).join('')}</ul>` : ''}
      </li>`).join('')}</ol>
      <button type="button" class="btn btn-quiet btn-block" data-fid-ir="${S.cpf && S.nome ? 'conta' : 'inicio'}">Voltar</button>
    </div>`;
  }

  function premiosHtml(comBotao) {
    const lista = prog.premios || [];
    if (!lista.length) return '<p class="muted fid-vazio">Os prêmios aparecem aqui em breve.</p>';
    const saldo = S.pontos || 0;
    const meuIdx = S.nivel ? S.nivel.indice : -1;
    return `<div class="fid-premios">${lista.map((p) => {
      const falta = p.pontos - saldo;
      const iMin = temNiveis() && p.nivel_min ? nivelDoId(p.nivel_min) : -1;
      const nvMin = iMin >= 0 ? prog.niveis.lista[iMin] : null;
      const bloqueado = nvMin && meuIdx < iMin;
      const pct = Math.max(4, Math.min(100, Math.round((saldo / p.pontos) * 100)));
      return `<article class="fid-premio">
        <div class="fid-premio-img ${p.imagem ? '' : 'is-vazia'}">${p.imagem ? `<img src="${esc(p.imagem)}" alt="" loading="lazy">` : icon('gift')}</div>
        <div class="fid-premio-info">${nvMin ? `<span class="fid-selo fid-selo--sm" style="--nv:${esc(nvMin.cor)}">${icon('lock')} ${esc(nvMin.nome)}</span>` : ''}<h4>${esc(p.nome)}</h4>${p.descricao ? `<p>${esc(p.descricao)}</p>` : ''}
          <b class="fid-premio-pts">${pts(p.pontos)}</b>
          ${comBotao && bloqueado ? `<small class="muted">Exclusivo do nível ${esc(nvMin.nome)} em diante</small>` : comBotao ? (falta > 0
            ? `<span class="fid-barra" aria-label="Faltam ${falta} pontos"><i style="width:${pct}%"></i></span><small class="muted">Faltam ${pts(falta)}</small>`
            : `<button type="button" class="btn btn-cobalt btn-sm" data-fid-resgatar="${esc(p.id)}">Trocar</button>`) : ''}
        </div>
      </article>`;
    }).join('')}</div>`;
  }

  function tInicio() {
    return `<div class="stack-lg fid">
      <div class="plate fid-hero"><span class="rivet r1"></span><span class="rivet r2"></span>
        <small>Programa de fidelidade</small><b>${esc(prog.nome)}</b><p>Ganhe ${esc(regraTexto())} e troque por prêmios.</p></div>
      ${boosts()}
      <div id="fidRankSlot">${rankingCartao()}</div>
      ${S.indicador ? `<p class="note">${icon('users')}<span>Você foi indicado por <b>${esc(S.indicador)}</b>. Cadastre-se e ganhe pontos de boas-vindas${prog.indicacao && prog.indicacao.quando === 'compra' ? ' na primeira compra' : ''}.</span></p>` : ''}
      <form class="stack" id="fidCpfForm" novalidate>
        <label class="field"><span>Seu CPF</span><input class="input mono" id="fidCpf" inputmode="numeric" autocomplete="off" maxlength="14" placeholder="000.000.000-00" data-foco value="${esc(fmtCpf(S.cpf || ''))}"></label>
        <p class="form-error" id="fidErro" role="alert">${esc(S.aviso || '')}</p>
        <button type="submit" class="btn btn-cobalt btn-block">Entrar ou cadastrar</button>
      </form>
      <ol class="fid-como">
        <li><b>Cadastre-se</b> com o seu CPF (uma vez só).</li>
        <li>Na hora de pagar, <b>peça CPF na nota</b>.</li>
        <li><b>Leia o QR Code</b> da nota aqui. Os pontos entram depois que o restaurante confere a nota.</li>
        <li>Troque os pontos por <b>prêmios</b>.</li>
      </ol>
      ${temNiveis() ? `<section class="stack"><h3 class="fid-h3">Níveis do clube</h3>
        <div class="fid-niveis-mini">${prog.niveis.lista.map((l) => `<span class="fid-selo" style="--nv:${esc(l.cor)}">${esc(l.nome)}</span>`).join('<span aria-hidden="true">›</span>')}</div>
        <button type="button" class="link fid-link" data-fid-ir="niveis">Ver as vantagens de cada nível</button></section>` : ''}
      <section class="stack"><h3 class="fid-h3">Prêmios</h3>${premiosHtml(false)}</section>
      ${prog.regulamento ? '<button type="button" class="link fid-link" data-fid-ir="regulamento">Regulamento do programa</button>' : ''}
    </div>`;
  }

  function tCadastro() {
    return `<form class="stack fid" id="fidCadForm" novalidate>
      <p class="muted">Cadastro no <b>${esc(prog.nome)}</b> de ${esc(nomeRest)}. Leva um minuto.</p>
      <div class="fid-cpf-fixo"><span>CPF</span><b class="mono">${esc(fmtCpf(S.cpf))}</b><button type="button" class="link" data-fid-ir="inicio">Trocar</button></div>
      <label class="field"><span>Nome completo</span><input class="input" id="fcNome" autocomplete="name" maxlength="80" data-foco required></label>
      <label class="field"><span>E-mail</span><input class="input" id="fcEmail" type="email" autocomplete="email" maxlength="120" required></label>
      <label class="field"><span>Celular com DDD</span><input class="input" id="fcTel" type="tel" inputmode="tel" autocomplete="tel" maxlength="16" placeholder="(31) 99999-9999" required></label>
      <label class="field"><span>Crie um PIN de 4 números</span><input class="input mono pin-input" id="fcPin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="new-password" required>
        <small class="help">Você usa o PIN para trocar os pontos por prêmios.</small></label>
      ${prog.indicacao && prog.indicacao.ativo ? `<label class="field"><span>Código de quem indicou (opcional)</span><input class="input mono" id="fcInd" maxlength="12" autocapitalize="characters" autocomplete="off" value="${esc(S.indicacao || '')}"></label>` : ''}
      <label class="check"><input type="checkbox" id="fcAceite"> <span>Li e aceito o ${prog.regulamento ? '<button type="button" class="link" data-fid-ir="regulamento">regulamento</button>' : 'regulamento'} e autorizo o uso dos meus dados (nome, CPF, e-mail e celular) no programa de fidelidade de ${esc(nomeRest)}.</span></label>
      <label class="check"><input type="checkbox" id="fcMkt"> <span>Quero receber novidades e promoções.</span></label>
      <p class="form-error" id="fidErro" role="alert">${esc(S.aviso || '')}</p>
      <button type="submit" class="btn btn-cobalt btn-block">Criar minha conta</button>
    </form>`;
  }

  function tConta() {
    const c = S.conta;
    const agora = boostAgora();
    const pendRes = c ? c.resgates.filter((x) => x.status === 'pendente') : [];
    const notasPend = c ? c.notas.filter((n) => n.status === 'pendente').length : S.pendentes;
    return `<div class="stack-lg fid">
      <div class="plate fid-saldo"><span class="rivet r1"></span><span class="rivet r2"></span>
        <small>Olá, ${esc(S.nome || '')}</small>
        <b class="fid-pontos">${num(S.pontos)}<span>${Math.abs(S.pontos) === 1 ? 'ponto' : 'pontos'}</span></b>
        ${notasPend ? `<p>${notasPend} ${notasPend === 1 ? 'nota em conferência' : 'notas em conferência'}</p>` : ''}
      </div>
      ${meuNivel()}
      ${agora ? `<p class="note fid-agora">${icon('sparkle')}<span><b>Agora vale ${agora.mult === 2 ? 'o dobro' : `${String(agora.mult).replace('.', ',')}x`}!</b>${agora.nome ? ` ${esc(agora.nome)}.` : ''}</span></p>` : ''}
      <div class="fid-acoes">
        <button type="button" class="btn btn-cobalt" data-fid-nota>${icon('receipt')} Ler nota fiscal</button>
        ${prog.indicacao && prog.indicacao.ativo ? `<button type="button" class="btn btn-line" data-fid-ir="indicar">${icon('users')} Indicar amigos</button>` : ''}
      </div>
      <div id="fidRankSlot">${rankingCartao()}${favoritos()}</div>
      ${pendRes.length ? `<section class="stack"><h3 class="fid-h3">Mostre ao garçom</h3>${pendRes.map((x) => `<div class="fid-cod"><span>${esc(x.premio)}</span><b class="mono">${esc(x.codigo)}</b></div>`).join('')}</section>` : ''}
      <section class="stack"><h3 class="fid-h3">Troque seus pontos</h3>${premiosHtml(true)}</section>
      ${c ? extrato(c) : `<button type="button" class="btn btn-line btn-block" data-fid-ir="pin">${icon('lock')} Ver extrato (PIN)</button>`}
      <p class="fid-rodape">${prog.regulamento ? '<button type="button" class="link" data-fid-ir="regulamento">Regulamento</button> · ' : ''}<button type="button" class="link" data-fid-sair>Não é você? Sair</button></p>
    </div>`;
  }

  /* ---------- Ranking do clube: top 10, os três primeiros no pódio ---------- */
  let ranking = null;
  async function carregarRanking() {
    ranking = store.fidRanking ? await store.fidRanking(S.token).catch(() => null) : null;
    if (S.tela === 'ranking') return render();
    // Nas outras telas, troca só o cartão do ranking (sem apagar o que a pessoa está digitando).
    const slot = $('#fidRankSlot');
    if (slot) slot.innerHTML = rankingCartao() + favoritos();
  }
  const favoritos = () => (S.tela === 'conta' && ranking && ranking.eu && ranking.eu.favoritos && ranking.eu.favoritos.length
    ? `<p class="note fid-fav">${icon('star')}<span>Você mais pede: <b>${ranking.eu.favoritos.map(esc).join(', ')}</b></span></p>` : '');
  const temRanking = () => ranking && ranking.ativo && ranking.top && ranking.top.length;
  const inicialDe = (n) => esc((String(n || '?').trim()[0] || '?').toUpperCase());
  function podio(top, grande) {
    // Ordem no pódio: 2º, 1º, 3º.
    return `<ol class="podio ${grande ? 'podio--grande' : ''}" aria-label="Os três primeiros do ranking">${[1, 0, 2].map((i) => {
      const x = top[i];
      if (!x) return `<li class="pd pd--${i + 1} is-vazio" aria-hidden="true"><span class="pd-av">?</span><b>—</b><span class="pd-degrau">${i + 1}º</span></li>`;
      return `<li class="pd pd--${i + 1} ${x.voce ? 'is-voce' : ''}">
        ${i === 0 ? `<span class="pd-coroa" aria-hidden="true">${icon('trophy')}</span>` : ''}
        <span class="pd-av">${inicialDe(x.nome)}</span>
        <b>${esc(x.nome)}${x.voce ? ' <em>(você)</em>' : ''}</b>
        <small>${num(x.pontos)} pts</small>
        <span class="pd-degrau">${x.pos}º</span>
      </li>`;
    }).join('')}</ol>`;
  }
  function rankingCartao() {
    if (!temRanking()) return '';
    const eu = ranking.eu;
    return `<button type="button" class="fid-rank-cartao" data-fid-ir="ranking">
      <span class="fid-rank-topo">${icon('trophy')} <b>Ranking do clube</b><span class="link">Ver top 10</span></span>
      ${podio(ranking.top, false)}
      ${eu ? `<span class="fid-rank-eu">${eu.pos ? (eu.pos <= 10 ? `Você está em <b>${eu.pos}º lugar</b>!` : `Você está em ${eu.pos}º. Faltam <b>${num(Math.max(1, ranking.top[ranking.top.length - 1].pontos - eu.pontos + 1))} pontos</b> para entrar no top 10.`) : 'Leia sua primeira nota para entrar no ranking.'}</span>` : ''}
    </button>`;
  }
  function tRanking() {
    if (!temRanking()) return `<div class="stack-lg fid"><p class="muted">O ranking aparece quando os primeiros clientes ganharem pontos.</p>
      <button type="button" class="btn btn-quiet btn-block" data-fid-ir="${S.cpf && S.nome ? 'conta' : 'inicio'}">Voltar</button></div>`;
    const resto = ranking.top.slice(3);
    const eu = ranking.eu;
    return `<div class="stack-lg fid fid-ranking">
      ${podio(ranking.top, true)}
      ${resto.length ? `<ol class="rk-lista">${resto.map((x) => `<li class="${x.voce ? 'is-voce' : ''}"><span class="rk-pos">${x.pos}º</span><span class="pd-av">${inicialDe(x.nome)}</span><b>${esc(x.nome)}${x.voce ? ' <em>(você)</em>' : ''}</b><span class="rk-pts">${num(x.pontos)} pts</span></li>`).join('')}</ol>` : ''}
      ${eu && eu.pos && eu.pos > 10 ? `<p class="note">${icon('trophy')}<span>Você está em <b>${eu.pos}º lugar</b>, com ${num(eu.pontos)} pontos.</span></p>` : ''}
      <p class="muted fid-rank-regra">Contam todos os pontos ganhos (compras, bônus e indicações). Trocar pontos por prêmios não tira ninguém do ranking.</p>
      <button type="button" class="btn btn-quiet btn-block" data-fid-ir="${S.cpf && S.nome ? 'conta' : 'inicio'}">Voltar</button>
    </div>`;
  }

  // Extrato do cliente: só pontos, nunca valores gastos.
  function rotuloMov(m) {
    const d = String(m.descricao || '');
    const extra = d.includes(' · ') ? d.split(' · ').slice(1).filter((x) => !/R\$/.test(x)).join(' · ') : '';
    if (m.tipo === 'compra') return `Compra${extra ? ` · ${extra}` : ''}`;
    if (m.tipo === 'manual') return 'Compra lançada pela equipe';
    if (m.tipo === 'ajuste') return 'Ajuste da nota';
    if (m.tipo === 'estorno') return /^Resgate cancelado/.test(d) ? d.replace('Resgate cancelado', 'Troca cancelada') : 'Nota cancelada';
    return d.replace(/\s*·?\s*R\$\s?[\d.]+,\d{2}/g, '') || m.tipo;
  }
  const STATUS = { pendente: 'Em conferência', creditada: 'Pontos creditados', recusada: 'Não valeu', estornada: 'Estornada' };
  function extrato(c) {
    const notas = c.notas.slice(0, 8);
    const mov = c.movimentos.slice(0, 20);
    return `<section class="stack"><h3 class="fid-h3">Notas</h3>
        ${notas.length ? `<ul class="fid-lista">${notas.map((n) => `<li><span>${dataCurta(n.lida_em)} · nota …${esc(n.chave.slice(-6))}
            ${n.motivo && n.status !== 'creditada' ? `<small>${esc(n.motivo)}</small>` : ''}</span>
            <b class="fid-st fid-st--${n.status}">${n.status === 'creditada' && n.pontos != null ? `+${num(n.pontos)}` : STATUS[n.status] || n.status}</b></li>`).join('')}</ul>`
          : '<p class="muted">Nenhuma nota ainda. Leia o QR Code da próxima nota com o seu CPF.</p>'}
      </section>
      <section class="stack"><h3 class="fid-h3">Extrato</h3>
        ${mov.length ? `<ul class="fid-lista">${mov.map((m) => `<li><span>${dataCurta(m.criado_em)} · ${esc(rotuloMov(m))}</span>
            <b class="${m.pontos < 0 ? 'fid-neg' : 'fid-pos'}">${m.pontos > 0 ? '+' : ''}${num(m.pontos)}</b></li>`).join('')}</ul>`
          : '<p class="muted">Sem movimentações ainda.</p>'}
      </section>`;
  }

  function tPin() {
    return `<form class="stack fid" id="fidPinForm" novalidate>
      <p>Digite o PIN de 4 números que você criou no cadastro${S.premio ? ' para trocar os pontos' : ''}.</p>
      <label class="field"><span>PIN</span><input class="input mono pin-input" id="fidPin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="current-password" data-foco></label>
      <p class="form-error" id="fidErro" role="alert">${esc(S.aviso || '')}</p>
      <button type="submit" class="btn btn-cobalt btn-block">Continuar</button>
      <p class="help">Esqueceu o PIN? Peça para a equipe do restaurante redefinir. Depois, o próximo PIN que você digitar aqui passa a valer.</p>
      <button type="button" class="btn btn-quiet btn-block" data-fid-ir="conta">Voltar</button>
    </form>`;
  }

  function tResultado() {
    const r = S.resultado || {};
    const ok = r.status === 'creditada';
    const titulo = ok ? `+${pts(r.pontos || 0)}!` : r.status === 'pendente' ? 'Nota recebida!' : r.status === 'repetida' ? 'Essa nota já foi lida' : 'Esta nota não valeu';
    const texto = ok ? (r.sefaz ? 'Nota conferida na SEFAZ. Os pontos já estão na sua conta.' : 'Compra conferida. Os pontos já estão na sua conta.')
      : r.status === 'pendente' ? 'Os pontos entram assim que o restaurante conferir a nota. Você acompanha aqui no extrato.'
      : r.status === 'repetida' ? `Cada nota vale pontos uma vez só, e esta já está na sua conta. Situação: ${STATUS[r.nota] || r.nota}${r.nota === 'creditada' && r.pontos ? ` (${pts(r.pontos)})` : ''}${r.motivo ? ` (${r.motivo})` : ''}.`
      : r.motivo || r.mensagem || 'Não foi possível registrar a nota.';
    return `<div class="stack-lg fid fid-res ${ok || r.status === 'pendente' ? 'is-ok' : 'is-erro'}">
      <span class="fid-res-ico">${icon(ok || r.status === 'pendente' ? 'check' : 'alert')}</span>
      <h3>${esc(titulo)}</h3><p>${esc(texto)}</p>
      <button type="button" class="btn btn-cobalt btn-block" data-fid-nota>${icon('receipt')} Ler outra nota</button>
      <button type="button" class="btn btn-quiet btn-block" data-fid-ir="conta">Ver meus pontos</button>
    </div>`;
  }

  // Valor da nota: vem sozinho (QR de contingência, foto ou câmera apontada para o total); o cliente só confere.
  function tValor() {
    const v = S.valorNota;
    return `<form class="stack-lg fid" id="fidValorForm" novalidate>
      <div class="fid-ocr" ${S.ocr === 'camera' && !v ? '' : 'hidden'}><video playsinline muted id="fidOcrVideo"></video><span class="fid-ocr-mira" aria-hidden="true"></span></div>
      <p class="fid-ocr-msg ${v ? 'is-ok' : ''}" id="fidOcrMsg" aria-live="polite">${msgOcr()}</p>
      <div class="fid-ocr-acoes">${acoesOcr()}</div>
      <label class="field"><span>Valor total da nota</span><input class="input mono" id="fidValor" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${v ? esc(v.toFixed(2).replace('.', ',')) : ''}"></label>
      <p class="form-error" id="fidErro" role="alert">${esc(S.aviso || '')}</p>
      <button type="submit" class="btn btn-cobalt btn-block">${icon('check')} Confirmar e enviar</button>
      <button type="button" class="btn btn-quiet btn-block" data-fid-semvalor>Enviar sem o valor</button>
    </form>`;
  }
  function msgOcr() {
    const v = S.valorNota;
    if (v) return `Achamos <b>${esc(brl(v))}</b> na nota. Confira e toque em Confirmar.`;
    if (S.ocr === 'camera') return S.ocrDica || 'Enquadre o fim da nota, do <b>SUBTOTAL</b> até a <b>forma de pagamento</b> (cartão, Pix…). Se demorar, toque em <b>Ler agora</b> ou tire uma foto.';
    if (S.ocr === 'capturando') return 'Lendo a imagem com calma… segure a nota parada.';
    if (S.ocr === 'foto') return `Lendo a foto… (${S.ocrPasso || 1} de ${S.ocrPassos || 4})`;
    if (S.ocr === 'lendo') return 'Procurando o valor na nota…';
    if (S.ocr === 'nada') return 'Não achamos o valor nessa foto. Tente outra mais de perto, com a nota reta e bem iluminada (use o flash), ou digite o total.';
    return 'Não conseguimos ler o valor. Tire uma foto do total ou digite o valor que está na nota.';
  }
  function acoesOcr() {
    if (S.valorNota || S.ocr === 'qr') return '';
    const ocupado = S.ocr === 'capturando' || S.ocr === 'foto' || S.ocr === 'lendo';
    const dis = ocupado ? 'disabled' : '';
    const cam = S.ocr === 'camera';
    return `${cam ? `<button type="button" class="btn btn-line" data-fid-capturar ${dis}>${icon('search')} Ler agora</button>` : ''}
      ${cam && S.temLanterna ? `<button type="button" class="btn btn-line ${S.lanterna ? 'is-on' : ''}" data-fid-lanterna aria-pressed="${S.lanterna ? 'true' : 'false'}">${icon('zap')} ${S.lanterna ? 'Desligar luz' : 'Lanterna'}</button>` : ''}
      <label class="btn btn-line ${ocupado ? 'is-disabled' : ''}">${icon('camera')} Tirar foto do valor<input type="file" accept="image/*" capture="environment" id="fidFoto" hidden ${dis}></label>
      ${!cam && !ocupado && window.OcrNota ? `<button type="button" class="btn btn-quiet" data-fid-camera>Apontar a câmera</button>` : ''}`;
  }

  function tResgatar() {
    const p = S.premio;
    return `<div class="stack-lg fid">
      <div class="fid-premio fid-premio--grande">
        <div class="fid-premio-img ${p.imagem ? '' : 'is-vazia'}">${p.imagem ? `<img src="${esc(p.imagem)}" alt="">` : icon('gift')}</div>
        <div class="fid-premio-info"><h4>${esc(p.nome)}</h4>${p.descricao ? `<p>${esc(p.descricao)}</p>` : ''}<b class="fid-premio-pts">${pts(p.pontos)}</b></div>
      </div>
      <p>Você tem <b>${pts(S.pontos)}</b>. Depois da troca ficam <b>${pts(S.pontos - p.pontos)}</b>.</p>
      <p class="muted">Você recebe um código para mostrar ao garçom. Ele entrega o prêmio.</p>
      <button type="button" class="btn btn-cobalt btn-block" data-fid-confirmar ${S.ocupado ? 'disabled' : ''}>${icon('gift')} Trocar agora</button>
      <button type="button" class="btn btn-quiet btn-block" data-fid-ir="conta">Voltar</button>
    </div>`;
  }

  function tCodigo() {
    const x = S.resgate;
    return `<div class="stack-lg fid fid-res is-ok">
      <span class="fid-res-ico">${icon('gift')}</span>
      <h3>${esc(x.premio)}</h3>
      <p>Mostre este código ao garçom:</p>
      <b class="fid-codigo mono">${esc(x.codigo)}</b>
      <p class="muted">O código também fica na sua conta até a entrega.</p>
      <button type="button" class="btn btn-quiet btn-block" data-fid-ir="conta">Ver meus pontos</button>
    </div>`;
  }

  function linkIndicacao() {
    const u = new URL(location.origin + '/');
    const r = new URLSearchParams(location.search).get('r');
    if (r) u.searchParams.set('r', r);
    u.searchParams.set('indicacao', S.conta.codigo);
    return u.href;
  }
  function tIndicar() {
    const c = S.conta;
    const i = prog.indicacao;
    const naCompra = i.quando === 'compra';
    const texto = `Entra no ${prog.nome} de ${nomeRest} com o meu código ${c.codigo}${i.indicado ? ` e ganha ${pts(i.indicado)} ${naCompra ? 'na primeira compra' : 'no cadastro'}` : ''}: ${linkIndicacao()}`;
    return `<div class="stack-lg fid">
      <p>Quando alguém se cadastrar com o seu código${naCompra ? ' e fizer a primeira compra com CPF na nota' : ''}, ${i.indicador ? `você ganha <b>${pts(i.indicador)}</b>` : 'vocês dois ganham pontos'}${i.indicador && i.indicado ? ` e quem você indicou ganha <b>${pts(i.indicado)}</b>` : ''}.</p>
      <div class="fid-cod fid-cod--ind"><span>Seu código</span><b class="mono">${esc(c.codigo)}</b></div>
      <p class="muted">${c.indicacoes ? `${c.indicacoes} ${c.indicacoes === 1 ? 'pessoa já se cadastrou' : 'pessoas já se cadastraram'} com o seu código.` : 'Ninguém usou o seu código ainda.'}</p>
      <a class="btn btn-cobalt btn-block" href="https://wa.me/?text=${encodeURIComponent(texto)}" target="_blank" rel="noopener">${icon('share')} Mandar no WhatsApp</a>
      <button type="button" class="btn btn-line btn-block" data-fid-copiar="${esc(texto)}">${icon('copy')} Copiar convite</button>
      <button type="button" class="btn btn-quiet btn-block" data-fid-ir="conta">Voltar</button>
    </div>`;
  }

  function tRegulamento() {
    return `<div class="stack fid">
      <div class="fid-regulamento">${esc(prog.regulamento || '').replace(/\n/g, '<br>')}</div>
      <button type="button" class="btn btn-quiet btn-block" data-fid-ir="${S.cpf ? (S.nome ? 'conta' : 'cadastro') : 'inicio'}">Voltar</button>
    </div>`;
  }

  /* ---------- Ações ---------- */
  const erro = (m) => { const e = $('#fidErro'); if (e) e.textContent = m; else toast(m, { tone: 'error', ms: 4500 }); };

  async function atualizarConta() {
    if (S.token) {
      const c = await store.fidConta(S.token).catch(() => null);
      if (c && c.status === 'ok') {
        Object.assign(S, { conta: c, nome: c.nome.split(' ')[0], pontos: c.pontos, nivel: c.nivel || null, pendentes: c.notas.filter((n) => n.status === 'pendente').length });
        gravar();
        atualizarTile();
        return true;
      }
      if (c && c.status === 'sem_sessao') { S.token = null; S.conta = null; }
    }
    if (!S.cpf) return false;
    const r = await store.fidConsultar(S.cpf).catch(() => null);
    if (r && r.status === 'ok') {
      Object.assign(S, { nome: r.nome, pontos: r.pontos, nivel: r.nivel || null, pendentes: r.pendentes });
      gravar();
      atualizarTile();
      return true;
    }
    if (r && r.status === 'novo') esquecer();
    return false;
  }

  async function entrarCpf(cpf) {
    S.aviso = null;
    const r = await store.fidConsultar(cpf);
    if (r.status === 'erro') return erro(r.mensagem);
    if (r.status === 'inativo') return erro('O programa está pausado no momento.');
    S.cpf = F.soDigitos(cpf);
    if (r.status === 'novo') return ir('cadastro');
    Object.assign(S, { nome: r.nome, pontos: r.pontos, nivel: r.nivel || null, pendentes: r.pendentes, token: null, conta: null });
    gravar();
    atualizarTile();
    ir('conta');
  }

  function lerNota() {
    if (!window.Leitor) return toast('Leitor indisponível. Recarregue a página.', { tone: 'error' });
    Leitor.abrir({
      titulo: 'Ler nota fiscal',
      dica: 'Aponte a câmera para o QR Code no fim da nota fiscal.',
      aceitar: (t) => {
        const c = F.chaveDoTexto(t);
        return c && F.chaveValida(c) ? null : 'Este QR não é de uma nota fiscal. Procure o QR Code no fim da nota (NFC-e).';
      },
      valor: true,
      pronto: async (t, x) => {
        // 1) Conferência automática na SEFAZ (valor oficial e produtos): os pontos entram na hora.
        // Só quando o restaurante ligou a conferência (cobrada por nota); desligada, nem chama.
        if (store.fidSefaz && prog && prog.sefaz) {
          corpo().innerHTML = `<div class="fid-carregando"><span class="dot"></span><p>Conferindo sua nota na SEFAZ…</p><small class="muted">Leva alguns segundos.</small></div>`;
          const r = await store.fidSefaz({ cpf: S.cpf, qr: t });
          if (r.status === 'sem_cadastro') return ir('cadastro');
          if (['creditada', 'repetida', 'recusada', 'erro', 'inativo'].includes(r.status)) {
            S.resultado = r.status === 'inativo' ? { status: 'erro', mensagem: 'O programa está pausado no momento.' } : { ...r, sefaz: true };
            await atualizarConta();
            carregarRanking();
            return ir('resultado');
          }
        }
        // 2) Sem a conferência automática: antes de pedir o valor, confere se a nota já foi lida.
        if (store.fidNotaSituacao) {
          corpo().innerHTML = '<div class="fid-carregando"><span class="dot"></span><p>Conferindo a nota…</p></div>';
          const s = await store.fidNotaSituacao({ cpf: S.cpf, qr: t });
          if (s.status !== 'nova') {
            S.resultado = s.status === 'inativo' ? { status: 'erro', mensagem: 'O programa está pausado no momento.' } : s;
            return ir('resultado');
          }
        }
        // O valor vem da foto/câmera, o cliente confere e a equipe aprova.
        S.qr = t;
        S.valorNota = F.valorDoQr ? F.valorDoQr(t) : null;
        S.ocr = S.valorNota ? 'qr' : 'lendo';
        S.digitou = false;
        ir('valor');
        if (!S.valorNota) buscarValor(t, x && x.quadro);
      },
    });
  }

  /* ---------- Valor da nota lido da imagem ---------- */
  let pararCam = null;
  function pararOcr() {
    if (pararCam) pararCam();
    pararCam = null;
  }
  const naTelaDoValor = (qr) => S.tela === 'valor' && S.qr === qr && $('#fidValorForm');
  function mostrarOcr() {
    if (!$('#fidValorForm')) return;
    $('.fid-ocr').hidden = !(S.ocr === 'camera' && !S.valorNota);
    const msg = $('#fidOcrMsg');
    msg.className = `fid-ocr-msg ${S.valorNota ? 'is-ok' : ''}`;
    msg.innerHTML = msgOcr();
    $('.fid-ocr-acoes').innerHTML = acoesOcr();
    if (S.valorNota && !S.digitou) $('#fidValor').value = S.valorNota.toFixed(2).replace('.', ',');
  }
  function achouValor(v) {
    pararOcr();
    S.valorNota = v;
    S.ocr = 'achou';
    mostrarOcr();
    navigator.vibrate && navigator.vibrate(40);
  }
  async function buscarValor(qr, quadro) {
    if (!window.OcrNota) { S.ocr = 'falhou'; return mostrarOcr(); }
    // 1) a imagem em que o QR foi lido (na foto da nota inteira, o total costuma estar junto)
    if (quadro) {
      const w = quadro.naturalWidth || quadro.width;
      const h = quadro.naturalHeight || quadro.height;
      const v = await OcrNota.lerValor(quadro, w, h);
      if (!naTelaDoValor(qr)) return;
      if (v) return achouValor(v);
    }
    // 2) câmera apontada para o "VALOR A PAGAR" (com "Ler agora", lanterna e foto como alternativa)
    ligarCamera(qr);
  }
  function ligarCamera(qr) {
    pararOcr();
    S.ocr = 'camera';
    S.ocrDica = null;
    S.temLanterna = false;
    S.lanterna = false;
    mostrarOcr();
    pararCam = OcrNota.camera($('#fidOcrVideo'), {
      achou: (v) => naTelaDoValor(qr) && achouValor(v),
      aviso: (a) => {
        if (!naTelaDoValor(qr)) return;
        if (a === 'camera' && pararCam) { S.temLanterna = pararCam.temLanterna(); return mostrarOcr(); }
        if (a === 'carregando' && S.ocr === 'camera') { S.ocrDica = 'Preparando a leitura… já pode enquadrar o fim da nota, do <b>SUBTOTAL</b> até a forma de pagamento.'; return mostrarOcr(); }
        if (a === 'lendo' && S.ocr === 'camera') { S.ocrDica = null; return mostrarOcr(); }
        if (a === 'sem-camera' || a === 'sem-ocr') { pararOcr(); S.ocr = 'falhou'; mostrarOcr(); }
      },
    });
  }
  // "Ler agora": lê o quadro atual com mais tempo (várias leituras).
  async function capturarAgora() {
    const qr = S.qr;
    const cam = pararCam;
    if (!cam || !cam.capturar) return;
    S.ocr = 'capturando';
    mostrarOcr();
    const v = await cam.capturar().catch(() => null);
    if (!naTelaDoValor(qr) || S.valorNota) return;
    if (v) return achouValor(v);
    S.ocr = 'camera';
    S.ocrDica = 'Ainda não deu. Deixe a nota reta e parada, com o total e a forma de pagamento na moldura, e acenda a luz — ou tire uma foto.';
    mostrarOcr();
  }
  async function alternarLanterna() {
    if (!pararCam) return;
    const ok = await pararCam.lanterna(!S.lanterna);
    if (ok) S.lanterna = !S.lanterna;
    mostrarOcr();
  }
  // Foto tirada pela câmera do aparelho (tem flash e foco melhores que o vídeo).
  async function lerFotoValor(arquivo) {
    const qr = S.qr;
    if (!arquivo || !window.OcrNota) return;
    pararOcr();
    S.ocr = 'foto';
    S.ocrPasso = 1;
    mostrarOcr();
    let v = null;
    try {
      const img = await OcrNota.abrirFoto(arquivo);
      v = await OcrNota.lerFoto(img, {
        progresso: (n, de) => { S.ocrPasso = n; S.ocrPassos = de; if (naTelaDoValor(qr)) mostrarOcr(); },
      });
    } catch (e) {
      console.error(e);
    }
    if (!naTelaDoValor(qr)) return;
    if (v) return achouValor(v);
    S.ocr = 'nada';
    mostrarOcr();
  }

  async function enviarNota(qr, valor) {
    pararOcr();
    corpo().innerHTML = '<div class="fid-carregando"><span class="dot"></span><p>Registrando a nota…</p></div>';
    let r;
    try {
      r = await store.fidRegistrarNota({ cpf: S.cpf, qr, valor: valor || null });
    } catch {
      r = { status: 'erro', mensagem: 'Sem conexão. Confira a internet e leia a nota de novo.' };
    }
    S.qr = null;
    if (r.status === 'sem_cadastro') return ir('cadastro');
    S.resultado = r;
    await atualizarConta();
    ir('resultado');
  }
  const valorDe = (t) => {
    const s = String(t || '').trim().replace(/[^\d,.]/g, '');
    const v = /,\d{1,2}$/.test(s) ? +s.replace(/\./g, '').replace(',', '.') : +s.replace(/,/g, '');
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN;
  };

  function onClick(e) {
    const t = e.target;
    const irPara = t.closest('[data-fid-ir]');
    if (irPara) {
      S.aviso = null;
      if (irPara.dataset.fidIr === 'indicar' && !S.token) { S.depoisPin = 'indicar'; return ir('pin'); }
      return ir(irPara.dataset.fidIr);
    }
    if (t.closest('[data-fid-nota]')) return lerNota();
    if (t.closest('[data-fid-semvalor]') && S.qr) return enviarNota(S.qr, null);
    if (t.closest('[data-fid-capturar]')) return capturarAgora();
    if (t.closest('[data-fid-lanterna]')) return alternarLanterna();
    if (t.closest('[data-fid-camera]') && S.qr) return ligarCamera(S.qr);
    const r = t.closest('[data-fid-resgatar]');
    if (r) {
      S.premio = (prog.premios || []).find((p) => p.id === r.dataset.fidResgatar);
      if (!S.premio) return;
      if (!S.token) { S.depoisPin = 'resgatar'; return ir('pin'); }
      return ir('resgatar');
    }
    if (t.closest('[data-fid-confirmar]')) return resgatar();
    const cp = t.closest('[data-fid-copiar]');
    if (cp) return copyText(cp.dataset.fidCopiar).then((ok) => toast(ok ? 'Convite copiado.' : 'Não foi possível copiar.', { tone: ok ? 'ok' : 'error' }));
    if (t.closest('[data-fid-sair]')) {
      if (S.token) store.fidSair(S.token).catch(() => {});
      esquecer();
      atualizarTile();
      return ir('inicio');
    }
  }

  async function resgatar() {
    if (S.ocupado) return;
    S.ocupado = true;
    render();
    const r = await store.fidResgatar(S.token, S.premio.id).catch(() => ({ status: 'erro', mensagem: 'Sem conexão. Tente de novo.' }));
    S.ocupado = false;
    if (r.status === 'sem_sessao') { S.token = null; gravar(); S.depoisPin = 'resgatar'; return ir('pin'); }
    if (r.status !== 'ok') { render(); return toast(r.mensagem || 'Não foi possível trocar agora.', { tone: 'error', ms: 4500 }); }
    S.resgate = r.resgate;
    await atualizarConta();
    ir('codigo');
  }

  async function onSubmit(e) {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      if (f.id === 'fidCpfForm') {
        const cpf = $('#fidCpf').value;
        if (!F.cpfValido(cpf)) return erro('CPF inválido. Confira os números.');
        await entrarCpf(cpf);
      } else if (f.id === 'fidCadForm') {
        if (!$('#fcAceite').checked) return erro('Para participar, aceite o regulamento e o uso dos dados.');
        const r = await store.fidCadastrar({
          cpf: S.cpf, nome: $('#fcNome').value, email: $('#fcEmail').value, telefone: $('#fcTel').value,
          pin: $('#fcPin').value, marketing: $('#fcMkt').checked, indicacao: $('#fcInd') ? $('#fcInd').value : null,
        });
        if (r.status !== 'ok') {
          if (r.existe) { S.aviso = 'Este CPF já tem cadastro.'; return ir('inicio'); }
          return erro(r.mensagem || 'Não foi possível cadastrar agora.');
        }
        S.token = r.token;
        await atualizarConta();
        carregarRanking();
        toast('Conta criada! Agora é só pedir CPF na nota e ler o QR Code aqui.', { tone: 'ok', ms: 5000 });
        ir('conta');
      } else if (f.id === 'fidValorForm') {
        const v = valorDe($('#fidValor').value);
        if (!(v > 0 && v < 1e5)) return erro('Digite o valor total da nota. Ex.: 87,50');
        if (!S.qr) return ir('conta');
        await enviarNota(S.qr, v);
      } else if (f.id === 'fidPinForm') {
        const pin = $('#fidPin').value;
        if (!/^\d{4}$/.test(pin)) return erro('O PIN tem 4 números.');
        const r = await store.fidEntrar(S.cpf, pin);
        if (r.status !== 'ok') { $('#fidPin').value = ''; return erro(r.mensagem || 'Não foi possível entrar.'); }
        S.token = r.token;
        await atualizarConta();
        carregarRanking();
        if (r.pin_novo) toast('PIN novo salvo.', { tone: 'ok' });
        const depois = S.depoisPin;
        S.depoisPin = null;
        ir(depois === 'resgatar' && S.premio ? 'resgatar' : depois === 'indicar' ? 'indicar' : 'conta');
      }
    } catch (ex) {
      console.error(ex);
      erro('Sem conexão. Confira a internet e tente de novo.');
    } finally {
      if (document.contains(btn)) btn.disabled = false;
    }
  }

  function onInput(e) {
    const t = e.target;
    if (t.id === 'fidCpf') t.value = fmtCpf(t.value);
    if (t.id === 'fidValor') S.digitou = true;
    if (t.id === 'fcTel') t.value = fmtTel(t.value);
    if (t.id === 'fcPin' || t.id === 'fidPin') t.value = t.value.replace(/\D/g, '').slice(0, 4);
  }

  async function abrir() {
    if (!prog || !prog.ativo) return;
    S.tela = S.cpf ? 'conta' : 'inicio';
    render();
    openSheet('sh-fid');
    carregarRanking();
    if (S.cpf) {
      await atualizarConta();
      if (!S.cpf) S.tela = 'inicio';
      if (['conta', 'inicio'].includes(S.tela)) render();
    }
  }

  async function iniciar(o) {
    store = o.store;
    nomeRest = o.nomeRestaurante || '';
    chave = `fid:${o.slug || 'demo'}`;
    const salvo = ler();
    Object.assign(S, { cpf: salvo.cpf || null, nome: salvo.nome || null, pontos: salvo.pontos ?? null, nivel: salvo.nivel || null, token: salvo.token || null });
    try {
      prog = await store.fidPrograma();
    } catch (e) {
      console.error(e);
      prog = null;
    }
    if (!prog || !prog.ativo) return null;
    const sh = $('#sh-fid');
    sh.addEventListener('click', onClick);
    sh.addEventListener('submit', onSubmit);
    sh.addEventListener('input', onInput);
    sh.addEventListener('change', (e) => {
      if (e.target.id !== 'fidFoto') return;
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      lerFotoValor(f);
    });
    sh.addEventListener('sheet:close', pararOcr);
    document.addEventListener('click', (e) => e.target.closest('[data-fid-abrir]') && abrir());
    const p = new URLSearchParams(location.search);
    S.indicacao = (p.get('indicacao') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (S.indicacao && !S.cpf) {
      store.fidIndicador(S.indicacao).then((r) => { if (r && r.status === 'ok') { S.indicador = r.nome; if (S.tela === 'inicio' && !$('#sh-fid').hidden) render(); } }).catch(() => {});
    }
    if (S.cpf) atualizarConta();
    if (p.has('fidelidade') || S.indicacao) setTimeout(abrir, 300);
    return prog;
  }

  // Conta do clube lembrada neste aparelho (o delivery usa para os pontos do pedido).
  const conta = () => (S.cpf ? { cpf: S.cpf, nome: S.nome, token: S.token } : null);
  window.Fidelidade = { iniciar, tile, abrir, conta, get ativo() { return !!(prog && prog.ativo); } };
})();
