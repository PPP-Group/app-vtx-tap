/*
 * Prorrogação no painel da equipe (adicional): o relógio do happy hour, o botão de "+1 chopp",
 * começar, desfazer e encerrar, os ajustes (nome, frase, minutos por chopp, duração, teto,
 * horário limite e agenda), o link do telão e o QR do garçom, e o histórico.
 * O garçom soma o chopp lendo a comanda do cliente: pela câmera ("Ler comanda"), encostando o celular
 * (modo garçom por NFC, no Android) ou lendo a plaquinha com o celular logado (página da mesa).
 */
(function () {
  const { $, esc, icon, toast, copyText, qrSvg } = UI;
  const PR = window.Prorrogacao;
  let ctx;
  const P = { tab: 'vivo', d: null, cfg: null, ocupado: false, poll: null };
  const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const hora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const dia = (iso) => new Date(iso).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
  const origem = () => window.VTX_ORIGEM || location.origin;
  const linkTelao = () => `${origem()}/telao/`;
  // QR do garçom: abre o painel e soma 1 chopp (precisa estar logado no celular).
  const linkGarcom = () => `${origem()}/admin/?chopp=1`;
  const cfgAtual = () => Store.prorrogacao.cfg(ctx.S.settings.prorrogacao);
  const nome = () => cfgAtual().nome;
  // Código da plaquinha a partir do que o QR ou o NFC leu (…/t/CODIGO, ?tag=CODIGO ou só o código).
  const codigoDe = (t) => {
    t = String(t || '').trim();
    const m = t.match(/\/t\/([A-Za-z0-9-]{4,24})/) || t.match(/[?&]tag=([A-Za-z0-9-]{4,24})/) || t.match(/^([A-Za-z0-9]{4,16})$/);
    return m ? m[1].toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
  };

  // O copo animado fica sempre no mesmo elemento: a tela é redesenhada, mas a animação continua.
  let copoEl = null;
  let copo = null;
  function montarCopo() {
    const lugar = document.getElementById('hhCopo');
    if (!lugar || lugar === copoEl) return;
    if (!copoEl) {
      copoEl = document.createElement('div');
      copo = PR.copo(copoEl, { tamanho: 'painel' });
    }
    copoEl.id = 'hhCopo';
    lugar.replaceWith(copoEl);
    copo.atualizar(P.d);
  }

  // Segunda tela: abre o telão já na TV (Chrome pergunta uma vez se pode gerenciar as janelas).
  async function abrirNaTV() {
    const url = `${linkTelao()}?tv=1`;
    let onde = 'popup,width=1280,height=720';
    let naTV = false;
    try {
      if ('getScreenDetails' in window) {
        const d = await window.getScreenDetails();
        const tv = d.screens.find((x) => x !== d.currentScreen) || null;
        if (tv) {
          onde = `popup,left=${tv.availLeft},top=${tv.availTop},width=${tv.availWidth},height=${tv.availHeight}`;
          naTV = true;
        }
      }
    } catch {}
    const w = window.open(url, 'vtx-telao', onde);
    if (!w) return toast('O navegador bloqueou a janela. Libere as janelas deste site e tente de novo.', { tone: 'error', ms: 6000 });
    toast(naTV ? 'Telão aberto na outra tela: toque no botão amarelo dele para pôr em tela cheia.'
      : 'Telão aberto numa janela nova: arraste para a TV e toque no botão amarelo para pôr em tela cheia.', { tone: 'ok', ms: 7000 });
  }

  // Comanda lida pelo garçom (câmera ou NFC).
  async function somarComanda(codigo, forcar = false) {
    try {
      const r = await ctx.store.hhSomarEtiqueta(codigo, forcar);
      const quem = PR.quemTxt(r) || 'Plaquinha';
      if (r.repetida) {
        toast(`${quem} acabou de ser lida. Era outro ${cfgAtual().produto}?`, { ms: 7000, action: { label: 'Somar mais 1', run: () => somarComanda(codigo, true) } });
      } else {
        if (navigator.vibrate) navigator.vibrate(40);
        const m = String(+r.adicionados).replace('.', ',');
        toast(r.travado && !+r.adicionados ? `${quem}: o relógio já está no teto ou no horário limite.` : `${quem}: +${m} min no relógio.`, {
          tone: 'ok', ms: 6000, action: r.leitura_id ? { label: 'Desfazer', run: () => desfazerLeitura(r.leitura_id) } : undefined,
        });
      }
    } catch (ex) {
      toast(ex.message || 'Não foi possível somar.', { tone: 'error', ms: 5000 });
    }
    await atualizar();
    ctx.chrome();
    if (ctx.S.view === 'prorrogacao') ctx.rerender();
  }
  async function desfazerLeitura(id) {
    try {
      await ctx.store.hhDesfazerLeitura(id);
      toast('Leitura desfeita.', { tone: 'ok' });
    } catch (ex) {
      toast(ex.message || 'Não foi possível desfazer.', { tone: 'error' });
    }
    await atualizar();
    if (ctx.S.view === 'prorrogacao') ctx.rerender();
  }
  function lerComanda() {
    if (!window.Leitor) return toast('Leitor indisponível. Recarregue a página.', { tone: 'error' });
    Leitor.abrir({
      titulo: 'Ler a comanda',
      dica: `Aponte para o QR da comanda (ou da mesa) a cada ${cfgAtual().produto} servido.`,
      aceitar: (t) => (codigoDe(t) ? null : 'Este QR não é de uma plaquinha.'),
      pronto: (t) => somarComanda(codigoDe(t)),
    });
  }
  // Modo garçom por NFC (Chrome no Android): com ele ligado, cada comanda encostada soma 1.
  const temNfc = () => 'NDEFReader' in window;
  let nfc = null;
  async function ligarNfc() {
    if (nfc) {
      nfc.abort();
      nfc = null;
      ctx.rerender();
      return toast('Modo garçom desligado.');
    }
    try {
      const ctrl = new AbortController();
      const leitor = new window.NDEFReader();
      await leitor.scan({ signal: ctrl.signal });
      nfc = ctrl;
      leitor.onreading = (ev) => {
        const rec = ev.message.records.find((r) => r.recordType === 'url' || r.recordType === 'text');
        const cod = rec ? codigoDe(new TextDecoder(rec.encoding || 'utf-8').decode(rec.data)) : null;
        if (cod) somarComanda(cod);
        else toast('Esta plaquinha não tem o link da VTX Tap.', { tone: 'error' });
      };
      leitor.onreadingerror = () => toast('Não deu para ler. Encoste de novo, devagar.', { tone: 'error' });
      toast('Modo garçom ligado: encoste o celular na comanda a cada chopp.', { tone: 'ok', ms: 5000 });
    } catch (ex) {
      toast(ex && ex.name === 'NotAllowedError' ? 'Permita o NFC para este site.' : 'Não foi possível ligar o NFC neste aparelho.', { tone: 'error' });
    }
    ctx.rerender();
  }

  async function atualizar() {
    try {
      P.d = PR.sincronizar(await ctx.store.hhPainel());
      if (copo) copo.atualizar(P.d);
    } catch (e) {
      console.error(e);
    }
  }
  const badge = () => (P.d && P.d.rodando ? '●' : '');

  /* ============================== Tela ============================== */
  function html() {
    if (!P.d) {
      atualizar().then(() => ctx.S.view === 'prorrogacao' && ctx.rerender());
      return '<p class="muted">Carregando…</p>';
    }
    const c = cfgAtual();
    const rod = P.d.rodando;
    queueMicrotask(montarCopo);
    return `<div class="vhead"><div><h1>${esc(c.nome)}</h1><p>${esc(Store.prorrogacao.frase(c))}</p></div>
        <div class="vhead-actions"><span class="fp-status ${rod ? 'is-on' : ''}">${!c.ativo ? 'Desligada' : rod ? 'Rolando agora' : 'Parada'}</span>
          ${c.ativo ? `<button type="button" class="btn btn-cobalt btn-sm" data-hh-tv>${icon('external')} Abrir na TV</button>` : ''}</div></div>
      <div class="aj-tabs" role="tablist" aria-label="Seções da ${esc(c.nome)}">
        <button type="button" role="tab" aria-selected="${P.tab === 'vivo'}" data-hh-tab="vivo">Ao vivo</button>
        <button type="button" role="tab" aria-selected="${P.tab === 'ajustes'}" data-hh-tab="ajustes">Ajustes</button>
        <button type="button" role="tab" aria-selected="${P.tab === 'historico'}" data-hh-tab="historico">Histórico</button>
      </div>
      ${P.tab === 'vivo' ? tVivo(c) : P.tab === 'ajustes' ? tAjustes() : tHistorico()}`;
  }

  function tVivo(c) {
    if (!c.ativo) {
      return `<section class="panel stack hh-off">
        <p class="note">${icon('timer')}<span>A ${esc(c.nome)} está desligada. Ligue em <b>Ajustes</b>: aí aparecem o relógio no telão e na página da mesa.</span></p>
        <button type="button" class="btn btn-cobalt" data-hh-tab="ajustes">${icon('sliders')} Abrir os ajustes</button></section>`;
    }
    const d = P.d;
    const s = d.sessao;
    const produto = esc(c.produto);
    const mais = c.minutos === 1 ? '+1 min' : `+${c.minutos} min`;
    const vivo = d.rodando ? `<section class="panel hh-vivo">
        <div id="hhCopo"></div>
        <p class="hh-fim">às <b data-hh-fim>${hora(s.fim)}</b>${s.limite_em ? ` · limite ${hora(s.limite_em)}` : ''}${c.teto ? ` · teto de ${PR.duracao(c.teto)} a mais` : ''}</p>
        <div class="hh-stats">
          <span><b>${s.leituras}</b> ${produto}${s.leituras === 1 ? '' : 's'}</span>
          <span><b>+${PR.duracao(s.minutos_ganhos)}</b> ganhos</span>
          <span>começou <b>${hora(s.inicio)}</b></span>
        </div>
        <button type="button" class="btn hh-mais" data-hh-somar="1" ${P.ocupado ? 'disabled' : ''}>${icon('beer')} +1 ${produto} <small>${mais}</small></button>
        <div class="hh-ler">
          <button type="button" class="btn btn-line" data-hh-ler>${icon('qr')} Ler comanda</button>
          ${temNfc() ? `<button type="button" class="btn ${nfc ? 'btn-cobalt' : 'btn-line'}" data-hh-nfc aria-pressed="${!!nfc}">${icon('nfc')} ${nfc ? 'Modo garçom ligado' : 'Modo garçom (NFC)'}</button>` : ''}
        </div>
        <div class="hh-mais-varios">${[2, 3, 5].map((n) => `<button type="button" class="btn btn-line" data-hh-somar="${n}" ${P.ocupado ? 'disabled' : ''}>+${n}</button>`).join('')}</div>
        <div class="hh-acoes">
          <button type="button" class="btn btn-quiet btn-sm" data-hh-desfazer ${s.leituras ? '' : 'disabled'}>${icon('left')} Desfazer o último</button>
          <button type="button" class="btn btn-danger btn-sm" data-hh-encerrar>${icon('x')} Encerrar agora</button>
        </div>
      </section>` : `<section class="panel stack hh-parado">
        <h2>Começar a ${esc(c.nome)}</h2>
        <p class="muted">O relógio começa com a duração abaixo. Cada ${produto} servido soma ${PR.minutosTxt(c.minutos)}${c.limite ? `, até no máximo ${c.limite}` : ''}.</p>
        <div class="hh-comecar"><label class="field"><span>Duração (min)</span><input class="input mono" id="hhMin" type="number" min="1" max="600" value="${c.duracao}"></label>
          <button type="button" class="btn btn-cobalt" data-hh-comecar ${P.ocupado ? 'disabled' : ''}>${icon('timer')} Começar agora</button></div>
        ${d.proxima ? `<p class="help">${icon('clock')} Pela agenda, a próxima começa sozinha ${dia(d.proxima)} às ${hora(d.proxima)}.</p>` : ''}
        ${d.ultima_sessao ? `<p class="help">Última: ${dia(d.ultima_sessao.inicio)}, ${hora(d.ultima_sessao.inicio)} às ${hora(d.ultima_sessao.fim)} · ${d.ultima_sessao.leituras} ${produto}s · +${PR.duracao(d.ultima_sessao.minutos_ganhos)}.</p>` : ''}
      </section>`;
    const leituras = d.leituras || [];
    return `<div class="aj-grid hh-grid">
      ${vivo}
      <div class="aj-col">
        <section class="panel stack">
          <h3>Telão</h3>
          <p class="muted">Com a TV ligada no computador (HDMI, como segunda tela), toque em <b>Abrir na TV</b>: o relógio abre na TV e fica rodando sozinho.
            Smart TV ou TV box: abra o link abaixo no navegador dela, ou leia o QR com a TV.</p>
          <button type="button" class="btn btn-cobalt" data-hh-tv>${icon('external')} Abrir na TV</button>
          <div class="dp-link"><b class="mono">${esc(linkTelao())}</b>
            <button type="button" class="btn btn-quiet btn-sm" data-hh-copiar="telao">${icon('copy')} Copiar</button></div>
          <div class="hh-qr hh-qr--telao">${qrSvg(linkTelao(), { cell: 3 })}</div>
        </section>
        <section class="panel stack">
          <h3>Comandas e QR do garçom</h3>
          <p class="muted">Cada pessoa pode ganhar uma plaquinha como comanda (em Mesas → Comandas individuais). A cada ${produto}, o garçom lê a comanda
            com o celular logado no painel e o minuto entra no relógio, com o número da comanda no telão. Sem comanda, use o QR abaixo (cole na chopeira).</p>
          <div class="hh-qr">${qrSvg(linkGarcom(), { cell: 4 })}</div>
          <button type="button" class="btn btn-line btn-sm" data-hh-imprimir>${icon('printer')} Imprimir o QR</button>
        </section>
        ${leituras.length ? `<section class="panel stack">
          <h3>Últimas leituras</h3>
          <ul class="hh-leituras">${leituras.map((l) => `<li class="${l.desfeita ? 'is-desfeita' : ''}"><span>${hora(l.em)} · ${esc(l.por || 'Equipe')}${PR.quemTxt(l) ? ` · <b>${esc(PR.quemTxt(l))}</b>` : ''}</span>
            <b>${l.qtd > 1 ? `${l.qtd}× ` : ''}+${String(+l.minutos).replace('.', ',')} min</b>${l.desfeita ? `<small>desfeita${l.desfeita_por ? ` por ${esc(l.desfeita_por)}` : ''}</small>` : ''}</li>`).join('')}</ul>
        </section>` : ''}
      </div>
    </div>`;
  }

  function tAjustes() {
    const c = P.cfg || (P.cfg = JSON.parse(JSON.stringify(cfgAtual())));
    return `<form class="fp-grid" id="hhAjustes" novalidate>
      <div class="aj-col">
        <section class="panel stack">
          <div class="set-row fp-row"><div><h3>Ligada</h3><p>Mostra o relógio no telão e na página da mesa, e libera o botão do chopp.</p></div>
            <label class="switch"><input type="checkbox" name="ativo" ${c.ativo ? 'checked' : ''} aria-label="Ligada"><span></span></label></div>
          <label class="field"><span>Nome</span><input class="input" name="nome" maxlength="40" value="${esc(c.nome)}" placeholder="Prorrogação"></label>
          <label class="field"><span>Frase (aparece no telão e na mesa)</span><input class="input" name="frase" maxlength="120" value="${esc(c.frase)}" placeholder="${esc(Store.prorrogacao.frase({ ...c, frase: '' }))}">
            <small class="help">Em branco, usa a frase do exemplo, com o item e os minutos abaixo.</small></label>
          <label class="field"><span>O que soma tempo</span><input class="input" name="produto" maxlength="30" value="${esc(c.produto)}" placeholder="chopp"></label>
          <small class="help">Exemplos de nome: Prorrogação, Hora Extra, Happy Hour Sem Fim, Saideira Infinita.</small>
        </section>
      </div>
      <div class="aj-col">
        <section class="panel stack">
          <h3>Relógio</h3>
          <div class="dl2"><label class="field"><span>Duração inicial (min)</span><input class="input mono" name="duracao" type="number" min="5" max="600" value="${c.duracao}"></label>
            <label class="field"><span>Minutos por ${esc(c.produto)}</span><input class="input mono" name="minutos" type="number" min="1" max="30" value="${c.minutos}"></label></div>
          <div class="dl2"><label class="field"><span>Teto de minutos ganhos (0 = sem teto)</span><input class="input mono" name="teto" type="number" min="0" max="1440" value="${c.teto}"></label>
            <label class="field"><span>Horário limite (opcional)</span><input class="input mono" name="limite" type="time" value="${esc(c.limite || '')}"></label></div>
          <small class="help">O horário limite é a hora em que o happy hour acaba de qualquer jeito (ex.: 23:00), mesmo com chopp saindo.</small>
        </section>
        <section class="panel stack">
          <div class="set-row fp-row"><div><h3>Agenda</h3><p>Começa sozinha nos dias e hora escolhidos.</p></div>
            <label class="switch"><input type="checkbox" name="agenda" ${c.agenda.ativo ? 'checked' : ''} aria-label="Agenda"><span></span></label></div>
          <div class="hh-dias">${DIAS.map((n, i) => `<label class="check"><input type="checkbox" name="dia" value="${i}" ${c.agenda.dias.includes(i) ? 'checked' : ''}> <span>${n}</span></label>`).join('')}</div>
          <label class="field"><span>Começa às</span><input class="input mono" name="hora" type="time" value="${esc(c.agenda.hora)}"></label>
        </section>
      </div>
      <div class="fp-salvar"><p class="form-error" id="hhErro" role="alert"></p><button type="submit" class="btn btn-cobalt">${icon('check')} Salvar ajustes</button></div>
    </form>`;
  }
  function lerAjustes() {
    const f = $('#hhAjustes');
    if (!f) return P.cfg;
    const el = f.elements;
    Object.assign(P.cfg, {
      ativo: el.ativo.checked, nome: el.nome.value.trim(), frase: el.frase.value.trim(), produto: el.produto.value.trim(),
      duracao: +el.duracao.value, minutos: +el.minutos.value, teto: +el.teto.value || 0, limite: el.limite.value || null,
      agenda: { ativo: el.agenda.checked, dias: [...f.querySelectorAll('[name=dia]:checked')].map((x) => +x.value), hora: el.hora.value || '18:00' },
    });
    return P.cfg;
  }

  function tHistorico() {
    const h = P.d.historico || [];
    const produto = esc(cfgAtual().produto);
    if (!h.length) return '<section class="panel"><p class="muted">Nenhum happy hour ainda.</p></section>';
    const dur = (x) => Math.round((new Date(x.fim) - new Date(x.inicio)) / 60e3);
    const rec = P.d.recorde;
    return `<section class="panel stack">
      ${rec ? `<p class="hh-recorde">${icon('trophy')} Recorde: <b>${PR.duracao(rec.minutos)}</b> de happy hour (${dia(rec.em)}, ${rec.leituras} ${produto}s)</p>` : ''}
      <ul class="hh-hist">${h.map((x) => `<li><span><b>${dia(x.inicio)}</b> · ${hora(x.inicio)} às ${hora(x.fim)}${x.aberta ? ' <span class="badge">agora</span>' : ''}</span>
        <span>${PR.duracao(dur(x))} · ${x.leituras} ${produto}s · +${PR.duracao(x.minutos_ganhos)}</span>
        <small class="muted">${x.criado_por === 'Agenda' ? 'Começou pela agenda' : `Começou: ${esc(x.criado_por || 'Equipe')}`}${x.motivo === 'equipe' ? ' · encerrada pela equipe' : ''}</small></li>`).join('')}</ul>
    </section>`;
  }

  /* ============================== Ações ============================== */
  async function acao(fn, ok) {
    if (P.ocupado) return;
    P.ocupado = true;
    try {
      const r = await fn();
      P.d = PR.sincronizar({ ...P.d, ...r });
      if (copo) copo.atualizar(P.d);
      if (ok) ok(r);
    } catch (ex) {
      toast(ex.message || 'Não foi possível agora.', { tone: 'error', ms: 5000 });
    }
    P.ocupado = false;
    ctx.chrome();
    ctx.rerender();
  }
  function somar(qtd) {
    return acao(() => ctx.store.hhSomar(qtd), (r) => {
      if (navigator.vibrate) navigator.vibrate(40);
      const m = String(+r.adicionados).replace('.', ',');
      toast(r.travado ? (+r.adicionados ? `+${m} min: chegou no teto ou no horário limite.` : 'O relógio já está no teto ou no horário limite.') : `+${m} min no relógio.`,
        { tone: r.travado ? 'ink' : 'ok' });
    });
  }
  function imprimirQr() {
    const c = cfgAtual();
    const w = window.open('', 'qr-garcom', 'width=420,height=620');
    if (!w) return toast('Libere as janelas do navegador para imprimir.', { tone: 'error' });
    w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(c.nome)}: QR do garçom</title>
      <style>body{font-family:system-ui,sans-serif;text-align:center;padding:24px}svg{width:260px;height:260px}h1{font-size:22px;margin:0 0 4px}p{margin:6px 0;color:#333}</style>
      <h1>${esc(c.nome)}</h1><p>Garçom: leia a cada ${esc(c.produto)} servido</p>${qrSvg(linkGarcom(), { cell: 6 })}
      <p><b>+${PR.minutosTxt(c.minutos)}</b> no relógio</p><p style="font-size:12px">Precisa estar logado no painel da equipe.</p>
      <script>setTimeout(()=>print(),300)<\/script>`);
    w.document.close();
  }

  function onClick(e) {
    const t = e.target;
    const tab = t.closest('[data-hh-tab]');
    if (tab) {
      if (P.tab === 'ajustes' && $('#hhAjustes')) lerAjustes();
      P.tab = tab.dataset.hhTab;
      return ctx.rerender();
    }
    const s = t.closest('[data-hh-somar]');
    if (s) return somar(+s.dataset.hhSomar);
    if (t.closest('[data-hh-comecar]')) {
      const min = +($('#hhMin') || {}).value || null;
      return acao(() => ctx.store.hhComecar(min), () => toast(`${nome()} começou.`, { tone: 'ok' }));
    }
    if (t.closest('[data-hh-desfazer]')) {
      if (!confirm('Desfazer a última leitura? Os minutos dela saem do relógio.')) return;
      return acao(() => ctx.store.hhDesfazer(), () => toast('Leitura desfeita.', { tone: 'ok' }));
    }
    if (t.closest('[data-hh-encerrar]')) {
      if (!confirm(`Encerrar a ${nome()} agora?`)) return;
      return acao(() => ctx.store.hhEncerrar(), () => toast(`${nome()} encerrada.`, { tone: 'ok' }));
    }
    if (t.closest('[data-hh-copiar]')) return copyText(linkTelao()).then((ok) => toast(ok ? 'Link copiado.' : 'Não foi possível copiar.', { tone: ok ? 'ok' : 'error' }));
    if (t.closest('[data-hh-imprimir]')) return imprimirQr();
    if (t.closest('[data-hh-tv]')) return abrirNaTV();
    if (t.closest('[data-hh-ler]')) return lerComanda();
    if (t.closest('[data-hh-nfc]')) return ligarNfc();
  }
  async function onSubmit(e) {
    if (e.target.id !== 'hhAjustes') return;
    e.preventDefault();
    const c = lerAjustes();
    const erro = (m) => ($('#hhErro').textContent = m);
    if (!(c.duracao >= 5 && c.duracao <= 600)) return erro('A duração inicial vai de 5 a 600 minutos.');
    if (!(c.minutos >= 1 && c.minutos <= 30)) return erro('Os minutos por item vão de 1 a 30.');
    if (!(c.teto >= 0 && c.teto <= 1440)) return erro('O teto vai de 0 (sem teto) a 1440 minutos.');
    if (c.agenda.ativo && !c.agenda.dias.length) return erro('Escolha os dias da agenda.');
    const novo = Store.prorrogacao.cfg(c);
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await ctx.store.updateSettings({ prorrogacao: novo });
      ctx.S.settings.prorrogacao = novo;
      P.cfg = null;
      await atualizar();
      toast(novo.ativo ? 'Ajustes salvos.' : 'Ajustes salvos. A Prorrogação está desligada.', { tone: 'ok' });
      ctx.chrome();
      ctx.rerender();
    } catch (ex) {
      erro(ex.message || 'Não foi possível salvar.');
    }
    btn.disabled = false;
  }

  // Relógio: conta a cada segundo sem redesenhar; acaba o tempo → busca de novo.
  function tick() {
    if (ctx.S.view !== 'prorrogacao' || !P.d || !P.d.rodando) return;
    montarCopo();
    const r = PR.restante(P.d);
    if (r <= 0 && !P.ocupado) atualizar().then(() => ctx.rerender());
  }
  // Com a tela aberta, acompanha os chopps dos outros garçons.
  async function acompanhar() {
    if (ctx.S.view !== 'prorrogacao' || P.ocupado || document.hidden || editando()) return;
    const antes = JSON.stringify(P.d && [P.d.rodando, P.d.sessao && P.d.sessao.fim, P.d.sessao && P.d.sessao.leituras]);
    await atualizar();
    const depois = JSON.stringify(P.d && [P.d.rodando, P.d.sessao && P.d.sessao.fim, P.d.sessao && P.d.sessao.leituras]);
    if (antes !== depois && !$('#main').contains(document.activeElement)) ctx.rerender();
  }

  // QR do garçom (/admin/?chopp=1): soma 1 assim que o painel abre.
  async function choppDoQr() {
    ctx.S.view = 'prorrogacao';
    location.hash = 'prorrogacao';
    P.tab = 'vivo';
    await atualizar();
    if (!P.d || !P.d.rodando) {
      ctx.rerender();
      return toast(`A ${nome()} não está rolando agora.`, { tone: 'error', ms: 5000 });
    }
    await somar(1);
  }

  function iniciar(c) {
    ctx = c;
    document.addEventListener('click', (e) => { if (e.target.closest('#main[data-view="prorrogacao"]')) onClick(e); });
    document.addEventListener('submit', (e) => { if (e.target.closest('#main[data-view="prorrogacao"]')) onSubmit(e); });
    setInterval(tick, 500);
    setInterval(acompanhar, 5000);
  }
  const editando = () => P.tab === 'ajustes' && !!$('#hhAjustes');

  window.HHPainel = { iniciar, atualizar, html, badge, editando, choppDoQr, nome };
})();
