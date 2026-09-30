/*
 * Delivery no painel da equipe: quadro dos pedidos (novo → em preparo → saiu → entregue),
 * alerta de pedido novo, comanda para imprimir e os ajustes do delivery (taxas por
 * distância, pedido mínimo, tempo, pagamentos e o link da página de pedidos).
 */
(function () {
  const { $, esc, brl, icon, toast, copyText, qrSvg } = UI;
  let ctx;
  const P = { tab: 'pedidos', pedidos: [], vistos: new Set(), pronto: false, cfg: null, finalizados: false };

  const COLS = [
    ['recebido', 'Novos'],
    ['preparo', 'Em preparo'],
    ['saiu', 'Saiu para entrega'],
  ];
  const FORMA = { pix: 'Pix', cartao: 'Cartão', dinheiro: 'Dinheiro' };
  const hora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const minDesde = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  const tel = (t) => { const d = String(t || '').replace(/\D/g, ''); return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d; };
  const cfgAtual = () => ({ ...Store.delivery.PADRAO, ...(ctx.S.settings.delivery || {}) });
  const linkPedidos = () => `${location.origin}/delivery/`;

  async function atualizar() {
    try {
      P.pedidos = (await ctx.store.deliveryPedidos({ desde: new Date(Date.now() - 20 * 3600e3) })) || [];
    } catch (e) {
      console.error(e);
      return;
    }
    const novos = P.pedidos.filter((p) => p.status === 'recebido' && !P.vistos.has(p.id));
    novos.forEach((p) => P.vistos.add(p.id));
    if (P.pronto && novos.length) {
      ctx.ding(3);
      const p = novos[0];
      toast(`Pedido novo #${p.numero}: ${p.cliente.nome.split(' ')[0]}, ${brl(p.total)}.`, {
        tone: 'ok', ms: 10000, action: { label: 'Ver', run: () => { P.tab = 'pedidos'; location.hash = 'delivery'; ctx.rerender(); } },
      });
    }
    P.pronto = true;
  }
  const badge = () => P.pedidos.filter((p) => p.status === 'recebido').length;

  /* ============================== Tela ============================== */
  function html() {
    const c = cfgAtual();
    return `<div class="vhead"><div><h1>Delivery</h1><p>${P.tab === 'pedidos' ? 'Pedidos de hoje. Toque para mudar o andamento: o cliente acompanha pelo link.' : 'Área de entrega, taxas, pedido mínimo e pagamentos.'}</p></div>
        <span class="fp-status ${c.ativo ? 'is-on' : ''}">${c.ativo ? 'Recebendo pedidos' : 'Pausado'}</span></div>
      <div class="aj-tabs" role="tablist" aria-label="Seções do delivery">
        <button type="button" role="tab" aria-selected="${P.tab === 'pedidos'}" data-dp-tab="pedidos">Pedidos${badge() ? ` <span class="badge">${badge()}</span>` : ''}</button>
        <button type="button" role="tab" aria-selected="${P.tab === 'ajustes'}" data-dp-tab="ajustes">Ajustes do delivery</button>
      </div>
      ${P.tab === 'pedidos' ? tPedidos(c) : tAjustes()}`;
  }

  function cartao(p) {
    const e = p.endereco || {};
    const maps = e.lat ? `https://www.google.com/maps/dir/?api=1&destination=${e.lat},${e.lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([e.rua, e.numero, e.bairro, e.cidade].filter(Boolean).join(', '))}`;
    const atraso = p.status === 'recebido' && minDesde(p.criado_em) >= 5;
    return `<article class="dp-card dp-card--${p.status} ${atraso ? 'is-atrasado' : ''}" data-dp-id="${esc(p.id)}">
      <header><b class="dp-num">#${p.numero}</b><span class="muted">${hora(p.criado_em)} · há ${minDesde(p.criado_em)} min</span><b class="dp-total">${brl(p.total)}</b></header>
      <div class="dp-cli"><b>${esc(p.cliente.nome)}</b> <a href="https://wa.me/55${esc(String(p.cliente.telefone).replace(/\D/g, ''))}" target="_blank" rel="noopener">${esc(tel(p.cliente.telefone))}</a></div>
      <ul class="dp-itens">${p.itens.map((x) => `<li><b>${x.qtd}×</b> ${esc(x.nome)}${x.obs ? `<small>${esc(x.obs)}</small>` : ''}</li>`).join('')}</ul>
      ${p.obs ? `<p class="dp-obs">${icon('msg')} ${esc(p.obs)}</p>` : ''}
      <p class="dp-end"><a href="${esc(maps)}" target="_blank" rel="noopener">${icon('pin')} ${esc([e.rua, e.numero].filter(Boolean).join(', '))}${e.complemento ? ` · ${esc(e.complemento)}` : ''} · ${esc(e.bairro || '')}</a>
        ${e.referencia ? `<small>Ref.: ${esc(e.referencia)}</small>` : ''}<small>${p.distancia_km != null ? `${String(p.distancia_km).replace('.', ',')} km · ` : ''}entrega ${+p.taxa ? brl(p.taxa) : 'grátis'}</small></p>
      <p class="dp-pag">${esc(FORMA[p.pagamento.forma] || '')}${p.pagamento.troco ? ` · troco para ${brl(p.pagamento.troco)} (levar ${brl(p.pagamento.troco - p.total)})` : ''}${p.entregador ? ` · ${icon('users')} ${esc(p.entregador)}` : ''}</p>
      <div class="dp-acts">
        ${p.status === 'recebido' ? `<button type="button" class="btn btn-cobalt btn-sm" data-dp-mudar="preparo">${icon('check')} Aceitar e preparar</button>` : ''}
        ${p.status === 'preparo' ? `<button type="button" class="btn btn-cobalt btn-sm" data-dp-mudar="saiu">${icon('arrow')} Saiu para entrega</button>` : ''}
        ${p.status === 'saiu' ? `<button type="button" class="btn btn-cobalt btn-sm" data-dp-mudar="entregue">${icon('check')} Entregue</button>` : ''}
        ${['recebido', 'preparo', 'saiu'].includes(p.status) ? `<button type="button" class="btn btn-line btn-sm" data-dp-imprimir>${icon('printer')} Comanda</button>
          <button type="button" class="btn btn-quiet btn-sm" data-dp-mudar="cancelado">Cancelar</button>` : ''}
      </div>
    </article>`;
  }

  function tPedidos(c) {
    const ativos = P.pedidos.filter((p) => !['entregue', 'cancelado'].includes(p.status));
    const fim = P.pedidos.filter((p) => ['entregue', 'cancelado'].includes(p.status));
    const hoje = P.pedidos.filter((p) => p.status !== 'cancelado');
    return `${!c.ativo ? `<p class="note">${icon('alert')}<span>O delivery está pausado: a página de pedidos não aceita pedidos. Ligue em <button type="button" class="link" data-dp-tab="ajustes">Ajustes do delivery</button>.</span></p>` : ''}
      ${c.ativo && !c.local ? `<p class="note">${icon('pin')}<span>Falta a localização do restaurante para calcular as taxas. Defina em <button type="button" class="link" data-dp-tab="ajustes">Ajustes do delivery</button>.</span></p>` : ''}
      <div class="dp-resumo"><span><b>${hoje.length}</b> ${hoje.length === 1 ? 'pedido' : 'pedidos'} hoje</span><span><b>${brl(hoje.reduce((t, p) => t + +p.total, 0))}</b> em vendas</span>
        <a class="link" href="${esc(linkPedidos())}" target="_blank" rel="noopener">${icon('external')} Abrir a página de pedidos</a></div>
      <div class="dp-quadro">${COLS.map(([k, t]) => {
        const lista = ativos.filter((p) => p.status === k).sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em));
        return `<section class="dp-col"><h2>${t} <span class="muted">${lista.length}</span></h2>${lista.length ? lista.map(cartao).join('') : '<p class="muted dp-vazio">Nenhum pedido.</p>'}</section>`;
      }).join('')}</div>
      ${fim.length ? `<section class="panel stack dp-fim"><button type="button" class="link" data-dp-fim>${P.finalizados ? 'Esconder' : 'Ver'} os finalizados de hoje (${fim.length})</button>
        ${P.finalizados ? `<ul class="dp-fim-lista">${fim.map((p) => `<li><b>#${p.numero}</b> ${esc(p.cliente.nome)} · ${brl(p.total)} · <span class="dp-st dp-st--${p.status}">${p.status === 'entregue' ? 'Entregue' : 'Cancelado'}</span> ${hora(p.atualizado_em)}${p.motivo ? ` · ${esc(p.motivo)}` : ''}</li>`).join('')}</ul>` : ''}</section>` : ''}`;
  }

  /* ---------- Ajustes ---------- */
  function tAjustes() {
    const c = P.cfg || (P.cfg = JSON.parse(JSON.stringify(cfgAtual())));
    const R = ctx.S.settings.restaurante || {};
    return `<form class="fp-grid" id="dpAjustes" novalidate>
      <div class="aj-col">
        <section class="panel stack">
          <div class="set-row fp-row"><div><h3>Receber pedidos</h3><p>Desligado, a página mostra o cardápio mas não aceita pedidos.</p></div>
            <label class="switch"><input type="checkbox" name="ativo" ${c.ativo ? 'checked' : ''} aria-label="Receber pedidos"><span></span></label></div>
          <div class="field"><span>Localização do restaurante (de onde sai a entrega)</span>
            <p class="dp-loc ${c.local ? 'is-ok' : ''}">${c.local ? `${icon('check')} ${esc(c.local.endereco || `${c.local.lat.toFixed(5)}, ${c.local.lng.toFixed(5)}`)}` : `${icon('pin')} Ainda não definida.`}</p>
            <div class="dp-loc-acts"><input class="input" name="localEndereco" value="${esc((c.local && c.local.endereco) || R.endereco || '')}" placeholder="Rua, número, bairro, cidade">
              <button type="button" class="btn btn-line btn-sm" data-dp-localizar>${icon('search')} Localizar</button>
              <button type="button" class="btn btn-quiet btn-sm" data-dp-gps>${icon('pin')} Estou no restaurante</button></div></div>
        </section>
        <section class="panel stack">
          <h3>Taxa de entrega por distância</h3>
          <p class="muted">Distância em linha reta do restaurante até o cliente. Depois da última faixa, fica fora da área.</p>
          <ul class="dp-faixas">${c.faixas.map((f, i) => `<li data-dp-faixa="${i}">
            <label class="field"><span>Até (km)</span><input class="input mono" name="ate" inputmode="decimal" value="${esc(String(f.ate).replace('.', ','))}"></label>
            <label class="field"><span>Taxa (R$)</span><input class="input mono" name="taxa" inputmode="decimal" value="${esc(String(f.taxa).replace('.', ','))}"></label>
            <button type="button" class="icon-btn" data-dp-faixa-del="${i}" aria-label="Tirar a faixa">${icon('trash')}</button></li>`).join('')}</ul>
          <button type="button" class="btn btn-quiet btn-sm" data-dp-faixa-add>${icon('plus')} Adicionar faixa</button>
        </section>
      </div>
      <div class="aj-col">
        <section class="panel stack">
          <div class="dl2"><label class="field"><span>Pedido mínimo (R$)</span><input class="input mono" name="minimo" inputmode="decimal" value="${esc(String(c.minimo || 0).replace('.', ','))}"></label>
            <label class="field"><span>Tempo de entrega (min)</span><input class="input" name="tempo" maxlength="20" value="${esc(c.tempo || '')}" placeholder="40 a 60"></label></div>
          <div class="field"><span>Pagamento na entrega</span><div class="dp-pags">
            ${[['pix', 'Pix'], ['cartao', 'Cartão'], ['dinheiro', 'Dinheiro']].map(([k, l]) => `<label class="check"><input type="checkbox" name="pag_${k}" ${c.pagamentos[k] ? 'checked' : ''}> <span>${l}</span></label>`).join('')}</div></div>
          <label class="field"><span>Chave Pix (aparece para o cliente depois do pedido)</span><input class="input" name="pix" maxlength="120" value="${esc(c.pix || '')}"></label>
          <label class="field"><span>WhatsApp para dúvidas do cliente</span><input class="input" name="whatsapp" type="tel" maxlength="16" value="${esc(c.whatsapp || '')}" placeholder="${esc(R.telefone || '(31) 90000-0000')}"></label>
        </section>
        <section class="panel stack">
          <h3>Página de pedidos</h3>
          <p class="muted">Divulgue no Instagram, no WhatsApp e no Google. Os itens aparecem quando estão marcados como "Disponível no delivery" no cardápio.</p>
          <div class="dp-link"><b class="mono">${esc(linkPedidos())}</b><button type="button" class="btn btn-line btn-sm" data-dp-copiar>${icon('copy')} Copiar</button></div>
          <div class="dp-qr">${qrSvg(linkPedidos(), { cell: 4 })}</div>
          <small class="help">${ctx.S.settings.cardapio.flatMap((x) => x.itens).filter((i) => i.delivery).length} itens do cardápio estão no delivery.</small>
        </section>
      </div>
      <div class="fp-salvar"><p class="form-error" id="dpErro" role="alert"></p><button type="submit" class="btn btn-cobalt">${icon('check')} Salvar ajustes</button></div>
    </form>`;
  }
  const num = (v) => { const n = parseFloat(String(v || '').replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
  function lerAjustes() {
    const f = $('#dpAjustes');
    if (!f) return P.cfg;
    const c = P.cfg;
    c.ativo = f.elements.ativo.checked;
    c.faixas = [...f.querySelectorAll('[data-dp-faixa]')].map((li) => ({ ate: num(li.querySelector('[name=ate]').value), taxa: num(li.querySelector('[name=taxa]').value) }));
    c.minimo = num(f.elements.minimo.value) || 0;
    c.tempo = f.elements.tempo.value.trim();
    c.pagamentos = { pix: f.elements.pag_pix.checked, cartao: f.elements.pag_cartao.checked, dinheiro: f.elements.pag_dinheiro.checked };
    c.pix = f.elements.pix.value.trim();
    c.whatsapp = f.elements.whatsapp.value.replace(/\D/g, '');
    c._endereco = f.elements.localEndereco.value.trim();
    return c;
  }
  async function localizarRestaurante() {
    const c = lerAjustes();
    const q = c._endereco;
    if (!q) return toast('Digite o endereço do restaurante.', { tone: 'error' });
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': 'pt-BR' } });
      const j = await r.json();
      if (!j || !j[0]) return toast('Endereço não encontrado no mapa. Tente sem o complemento ou use "Estou no restaurante".', { tone: 'error', ms: 5000 });
      c.local = { lat: +j[0].lat, lng: +j[0].lon, endereco: q };
      toast('Localização encontrada. Salve os ajustes.', { tone: 'ok' });
    } catch {
      toast('Não foi possível buscar o endereço agora.', { tone: 'error' });
    }
    ctx.rerender();
  }

  /* ---------- Comanda (impressora de 80 mm) ---------- */
  function imprimir(p) {
    const e = p.endereco || {};
    const nome = (ctx.S.settings.restaurante || {}).nome || '';
    const w = window.open('', 'comanda', 'width=380,height=640');
    if (!w) return toast('Permita pop-ups para imprimir a comanda.', { tone: 'error' });
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Pedido #${p.numero}</title><style>
      @page { size: 80mm auto; margin: 3mm; } body { width: 74mm; margin: 0 auto; font: 13px/1.35 'Courier New', monospace; color: #000; }
      h1 { font-size: 22px; margin: 4px 0; text-align: center; } h2 { font-size: 14px; margin: 8px 0 4px; } .c { text-align: center; }
      hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; } .l { display: flex; justify-content: space-between; gap: 6px; } .o { padding-left: 14px; font-style: italic; }
      .g { font-size: 16px; font-weight: bold; }
    </style></head><body>
      <div class="c">${esc(nome)}<br>DELIVERY</div><h1>#${p.numero}</h1><div class="c">${new Date(p.criado_em).toLocaleString('pt-BR')}</div><hr>
      ${p.itens.map((x) => `<div class="l g"><span>${x.qtd}x ${esc(x.nome)}</span></div>${x.obs ? `<div class="o">» ${esc(x.obs)}</div>` : ''}`).join('')}
      ${p.obs ? `<hr><div><b>Obs.:</b> ${esc(p.obs)}</div>` : ''}<hr>
      <h2>${esc(p.cliente.nome)} · ${esc(tel(p.cliente.telefone))}</h2>
      <div>${esc([e.rua, e.numero].filter(Boolean).join(', '))}${e.complemento ? ` - ${esc(e.complemento)}` : ''}<br>${esc(e.bairro || '')}${e.cidade ? ` - ${esc(e.cidade)}` : ''}${e.referencia ? `<br>Ref.: ${esc(e.referencia)}` : ''}</div><hr>
      <div class="l"><span>Itens</span><span>${brl(p.subtotal)}</span></div><div class="l"><span>Entrega</span><span>${brl(p.taxa)}</span></div>
      <div class="l g"><span>TOTAL</span><span>${brl(p.total)}</span></div>
      <div>Pagamento: ${esc(FORMA[p.pagamento.forma] || '')}${p.pagamento.troco ? `<br>Troco para ${brl(p.pagamento.troco)} (levar ${brl(p.pagamento.troco - p.total)})` : ''}</div>
      <hr><div class="c">VTX Tap</div>
      <script>window.onload = function () { window.print(); setTimeout(function () { window.close(); }, 400); };<\/script>
    </body></html>`);
    w.document.close();
  }

  /* ---------- Eventos ---------- */
  async function mudar(id, status) {
    const p = P.pedidos.find((x) => x.id === id);
    if (!p) return;
    let entregador = null;
    let motivo = null;
    if (status === 'saiu') {
      entregador = prompt(`Quem vai entregar o pedido #${p.numero}?`, p.entregador || '');
      if (entregador == null) return;
    }
    if (status === 'cancelado') {
      motivo = prompt(`Cancelar o pedido #${p.numero}? Escreva o motivo (o cliente vê).`, 'Não conseguimos atender agora.');
      if (motivo == null) return;
    }
    try {
      await ctx.store.deliveryMudar(id, status, entregador, motivo);
      if (status === 'preparo') imprimirAoAceitar(p);
      toast({ preparo: `Pedido #${p.numero} aceito.`, saiu: `Pedido #${p.numero} saiu para entrega.`, entregue: `Pedido #${p.numero} entregue.`, cancelado: `Pedido #${p.numero} cancelado.` }[status], { tone: 'ok' });
    } catch (e) {
      toast(e.message || 'Não foi possível mudar o pedido.', { tone: 'error' });
    }
    await atualizar();
    ctx.rerender();
    ctx.chrome();
  }
  // Ao aceitar, sai a comanda para a cozinha (pode desligar neste aparelho).
  function imprimirAoAceitar(p) {
    let auto = true;
    try { auto = localStorage.getItem('dp-imprimir-auto') !== '0'; } catch {}
    if (auto) imprimir(p);
  }

  function onClick(e) {
    const t = e.target;
    const tab = t.closest('[data-dp-tab]');
    if (tab) {
      if (P.tab === 'ajustes' && $('#dpAjustes')) lerAjustes();
      P.tab = tab.dataset.dpTab;
      return ctx.rerender();
    }
    const card = t.closest('[data-dp-id]');
    const m = t.closest('[data-dp-mudar]');
    if (m && card) return mudar(card.dataset.dpId, m.dataset.dpMudar);
    if (t.closest('[data-dp-imprimir]') && card) return imprimir(P.pedidos.find((x) => x.id === card.dataset.dpId));
    if (t.closest('[data-dp-fim]')) { P.finalizados = !P.finalizados; return ctx.rerender(); }
    if (t.closest('[data-dp-localizar]')) return localizarRestaurante();
    if (t.closest('[data-dp-gps]')) {
      lerAjustes();
      if (!navigator.geolocation) return toast('Este aparelho não informa a localização.', { tone: 'error' });
      return navigator.geolocation.getCurrentPosition((pos) => {
        P.cfg.local = { lat: pos.coords.latitude, lng: pos.coords.longitude, endereco: P.cfg._endereco || 'Localização do aparelho' };
        toast('Localização do restaurante definida. Salve os ajustes.', { tone: 'ok' });
        ctx.rerender();
      }, () => toast('Permita o acesso à localização.', { tone: 'error' }), { enableHighAccuracy: true, timeout: 12000 });
    }
    if (t.closest('[data-dp-faixa-add]')) {
      const c = lerAjustes();
      const ult = c.faixas[c.faixas.length - 1];
      c.faixas.push({ ate: ult ? (+ult.ate || 0) + 3 : 3, taxa: ult ? (+ult.taxa || 0) + 3 : 5 });
      return ctx.rerender();
    }
    const del = t.closest('[data-dp-faixa-del]');
    if (del) {
      const c = lerAjustes();
      c.faixas.splice(+del.dataset.dpFaixaDel, 1);
      return ctx.rerender();
    }
    if (t.closest('[data-dp-copiar]')) copyText(linkPedidos()).then((ok) => toast(ok ? 'Link copiado.' : 'Não foi possível copiar.', { tone: ok ? 'ok' : 'error' }));
  }
  async function onSubmit(e) {
    if (e.target.id !== 'dpAjustes') return;
    e.preventDefault();
    const c = lerAjustes();
    const erro = (m) => ($('#dpErro').textContent = m);
    const faixas = c.faixas.filter((f) => f.ate > 0).sort((a, b) => a.ate - b.ate);
    if (faixas.some((f) => !(f.taxa >= 0))) return erro('Confira as taxas: use números, por exemplo 7,50.');
    if (!faixas.length) return erro('Crie pelo menos uma faixa de entrega.');
    if (c.ativo && !c.local) return erro('Defina a localização do restaurante antes de receber pedidos.');
    if (c.ativo && !Object.values(c.pagamentos).some(Boolean)) return erro('Escolha pelo menos uma forma de pagamento.');
    const { _endereco, ...novo } = { ...c, faixas };
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await ctx.store.updateSettings({ delivery: novo });
      ctx.S.settings.delivery = novo;
      P.cfg = null;
      toast(novo.ativo ? 'Ajustes salvos. O delivery está recebendo pedidos.' : 'Ajustes salvos. O delivery está pausado.', { tone: 'ok' });
      ctx.rerender();
    } catch (ex) {
      erro(ex.message || 'Não foi possível salvar.');
    }
    btn.disabled = false;
  }

  function iniciar(c) {
    ctx = c;
    document.addEventListener('click', (e) => { if (e.target.closest('#main[data-view="delivery"]')) onClick(e); });
    document.addEventListener('submit', (e) => { if (e.target.closest('#main[data-view="delivery"]')) onSubmit(e); });
  }
  const editando = () => P.tab === 'ajustes' && !!$('#dpAjustes');

  window.DelPainel = { iniciar, atualizar, html, badge, editando };
})();
