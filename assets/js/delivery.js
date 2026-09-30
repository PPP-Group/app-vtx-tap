/*
 * Delivery do restaurante (/delivery): cardápio com os itens marcados para entrega,
 * carrinho, endereço (CEP pelo ViaCEP e localização pelo OpenStreetMap ou pelo GPS),
 * taxa pela distância, pagamento na entrega e acompanhamento do pedido (?pedido=TOKEN).
 * O servidor refaz a conta (preços do cardápio salvo e taxa pela distância).
 */
(function () {
  const { $, esc, brl, icon, toast, openSheet, closeSheet, initials, aplicarCor } = UI;
  const store = Store.create();
  const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const safeSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
  const soDigitos = (s) => String(s || '').replace(/\D/g, '');

  let live = null;
  let R = null;
  let D = null; // configuração do delivery
  // Linhas do carrinho: chave (item + opções escolhidas) → { id, qtd, obs, opcoes: [{ g, o, q }] }.
  const carrinho = new Map();
  let endereco = (() => { try { return JSON.parse(safeGet('dl-endereco')) || {}; } catch { return {}; } })();
  let cliente = (() => { try { return JSON.parse(safeGet('dl-cliente')) || {}; } catch { return {}; } })();
  let cat = null;
  let enviando = false;

  // Clube de pontos (o mesmo da página da mesa): cartão no topo do cardápio e na tela do pedido.
  const temFid = () => !!(window.Fidelidade && Fidelidade.ativo);
  // CPF dos pontos: o digitado neste aparelho ou o da conta do clube aberta aqui.
  const cpfPedido = () => (cliente.cpf != null ? cliente.cpf : ((Fidelidade.conta && Fidelidade.conta()) || {}).cpf || '');
  const fmtCpf = (c) => soDigitos(c).slice(0, 11).replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  const guardarCliente = () => safeSet('dl-cliente', JSON.stringify({ nome: cliente.nome, telefone: cliente.telefone, forma: cliente.forma, cpf: cliente.cpf }));
  function fidTexto(p) {
    const f = p.fid || {};
    const pts = (n) => `${n} ponto${n === 1 ? '' : 's'}`;
    if (f.situacao === 'creditado') return `+${pts(f.pontos)} entraram na sua conta do clube.`;
    if (f.situacao === 'nota') return `Os pontos desta compra já entraram pela nota fiscal (+${pts(f.pontos)}).`;
    if (f.situacao === 'sem_cadastro') return 'Você ainda não é do clube: cadastre-se com o CPF deste pedido e os pontos dele entram na hora.';
    if (f.situacao === 'fora') return 'Este pedido ficou fora do período do programa de pontos.';
    if (f.cpf) return 'Os pontos entram sozinhos quando o pedido for entregue. Não precisa ler a nota.';
    return p.status === 'entregue' ? 'Leia o QR Code da nota fiscal que veio com o pedido. Os pontos entram na sua conta do clube.'
      : 'Quando o pedido chegar, leia o QR Code da nota fiscal que vem junto. No próximo pedido, informe o CPF e os pontos entram sozinhos.';
  }
  const itens = () => (live ? live.cardapio.map((c) => ({ ...c, itens: c.itens.filter((i) => i.delivery) })).filter((c) => c.itens.length) : []);
  const itemDe = (id) => live.cardapio.flatMap((c) => c.itens).find((i) => i.id === id && i.delivery);
  const OPC = Store.opcoes;
  const chaveLinha = (id, opcoes = []) => (opcoes.length ? `${id}|${JSON.stringify([...opcoes].sort((a, b) => (a.g + a.o).localeCompare(b.g + b.o)))}` : id);
  const calc = (x) => { const it = itemDe(x.id); return it ? OPC.calcular(it, x.opcoes || []) : { erro: 'indisponível' }; };
  const precoLinha = (x) => calc(x).preco || 0;
  const subtotal = () => [...carrinho.values()].reduce((t, x) => t + precoLinha(x) * x.qtd, 0);
  const qtdDoItem = (id) => [...carrinho.values()].filter((x) => x.id === id).reduce((t, x) => t + x.qtd, 0);
  const qtdTotal = () => [...carrinho.values()].reduce((t, x) => t + x.qtd, 0);
  // Entrega: 'tel' (sem nada guardado: pede o celular e busca os endereços), 'lista' (achou: "é um destes?"),
  // 'salvo' (endereço escolhido da lista: vai só a referência) ou 'form' (preencher o endereço).
  let entrega = null;
  let busca = null; // { nome, enderecos: [{ ref, rua, numero, complemento, bairro, distancia, taxa }] }
  let salvo = (() => { try { return JSON.parse(safeGet('dl-salvo')) || null; } catch { return null; } })();
  const distancia = () => (entrega === 'salvo' && salvo ? salvo.distancia : endereco.lat && D.local ? Store.delivery.distanciaKm(D.local, endereco) : null);
  const taxa = () => {
    if (entrega === 'salvo' && salvo) return salvo.taxa;
    const km = distancia();
    return km == null ? null : Store.delivery.taxa(D, km);
  };
  const resumoEnd = (x) => `${x.rua}, nº ${x.numero}${x.complemento ? ' (com complemento)' : ''} · ${x.bairro}`;
  const guardarCarrinho = () => safeSet('dl-carrinho', JSON.stringify([...carrinho]));

  /* ---------------- Cabeçalho ---------------- */
  const toMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + m; };
  function aberto(now = new Date()) {
    const hs = R.horarios || [];
    if (!hs.length) return null;
    const d = now.getDay();
    const cur = now.getHours() * 60 + now.getMinutes();
    for (const off of [0, 1]) {
      for (const h of hs) {
        if (!h.dias.includes((d - off + 7) % 7)) continue;
        const a = toMin(h.abre);
        let f = toMin(h.fecha);
        if (f <= a) f += 1440;
        const c = cur + off * 1440;
        if (c >= a && c < f) return true;
      }
    }
    return false;
  }
  function renderTopo() {
    document.title = `${R.nome || 'Restaurante'} · Delivery`;
    $('#brandName').textContent = R.nome || 'Delivery';
    const logo = $('#heroLogo');
    logo.classList.toggle('is-initials', !R.logo);
    logo.innerHTML = R.logo ? `<img src="${esc(R.logo)}" alt="">` : esc(initials(R.nome || 'D'));
    const cover = $('#heroCover');
    cover.classList.toggle('has-img', !!R.capa);
    cover.style.backgroundImage = R.capa ? `url("${String(R.capa).replace(/"/g, '%22')}")` : '';
    const ab = aberto();
    const pill = $('#openPill');
    pill.hidden = ab == null && D.ativo;
    pill.textContent = !D.ativo ? 'Delivery fechado' : ab ? 'Aberto para pedidos' : 'Fechado agora';
    pill.classList.toggle('is-open', !!(D.ativo && ab !== false));
    $('#dlInfo').innerHTML = [D.tempo ? `${icon('clock')} ${esc(D.tempo)} min` : '', +D.minimo ? `Pedido mínimo ${brl(+D.minimo)}` : ''].filter(Boolean).join(' · ');
  }
  const podePedir = () => D.ativo && aberto() !== false;

  /* ---------------- Cardápio ---------------- */
  function renderCardapio() {
    const cats = itens();
    if (!cats.length) {
      $('#dlMain').innerHTML = `<div class="empty"><span class="empty-ico">${icon('book')}</span><h2>Cardápio em preparação</h2><p>O restaurante ainda não colocou itens no delivery.</p></div>`;
      return renderBarra();
    }
    if (!cat || !cats.some((c) => c.id === cat)) cat = cats[0].id;
    $('#dlMain').innerHTML = `
      ${!podePedir() ? `<p class="note">${icon('clock')}<span>${D.ativo ? 'O restaurante está fechado agora. Você pode ver o cardápio e pedir quando abrir.' : 'O delivery está pausado no momento.'}</span></p>` : ''}
      ${temFid() ? `<div class="dl-fid">${Fidelidade.tile()}</div>` : ''}
      <nav class="dl-cats" aria-label="Categorias">${cats.map((c) => `<button type="button" class="chip" aria-pressed="${c.id === cat}" data-dl-cat="${esc(c.id)}">${esc(c.nome)}</button>`).join('')}</nav>
      ${cats.map((c) => `<section class="dl-sec" id="cat-${esc(c.id)}"><h2 class="dl-h2">${esc(c.nome)}</h2>
        <ul class="dl-itens">${c.itens.map((i) => {
          const com = OPC.grupos(i).length > 0;
          const q = com ? qtdDoItem(i.id) : (carrinho.get(i.id) || {}).qtd || 0;
          const preco = com && OPC.temVariacao(i) ? `A partir de ${brl(OPC.aPartir(i))}` : brl(OPC.aPartir(i));
          return `<li class="dl-item ${q ? 'is-no-carrinho' : ''}">
            ${i.foto ? `<img class="dl-foto" src="${esc(i.foto)}" alt="" loading="lazy">` : ''}
            <div class="dl-item-txt"><b>${esc(i.nome)}</b>${i.desc ? `<small>${esc(i.desc)}</small>` : ''}<span class="price">${preco}</span>${com && q ? `<small class="dl-no-carrinho">${q} no carrinho</small>` : ''}</div>
            ${com ? `<button type="button" class="btn btn-line btn-sm" data-dl-escolher="${esc(i.id)}" ${podePedir() ? '' : 'disabled'}>${icon('plus')} Escolher</button>`
              : q ? `<span class="dl-qtd"><button type="button" class="icon-btn" data-dl-menos="${esc(i.id)}" aria-label="Tirar um ${esc(i.nome)}">${icon('minus')}</button><b>${q}</b><button type="button" class="icon-btn" data-dl-mais="${esc(i.id)}" aria-label="Mais um ${esc(i.nome)}">${icon('plus')}</button></span>`
              : `<button type="button" class="btn btn-line btn-sm" data-dl-mais="${esc(i.id)}" ${podePedir() ? '' : 'disabled'}>${icon('plus')} Adicionar</button>`}
          </li>`;
        }).join('')}</ul></section>`).join('')}`;
    renderBarra();
  }
  function renderBarra() {
    const n = qtdTotal();
    $('#dlBarra').hidden = !n || !!acompanhando;
    document.body.classList.toggle('com-barra', !!n && !acompanhando);
    $('#dlBarraQtd').textContent = `Ver carrinho · ${n} ${n === 1 ? 'item' : 'itens'}`;
    $('#dlBarraTotal').textContent = brl(subtotal());
  }
  function mudarQtd(chave, d) {
    const x = carrinho.get(chave) || { id: chave, qtd: 0, obs: '', opcoes: [] };
    x.qtd = Math.max(0, Math.min(50, x.qtd + d));
    if (x.qtd) carrinho.set(chave, x);
    else carrinho.delete(chave);
    guardarCarrinho();
  }

  /* ---------------- Opções do item (tamanho, carne, adicionais) ---------------- */
  let OP = null; // { id, esc: { grupo: opcao }, ext: { grupo: { opcao: q } }, qtd, obs }
  const selDe = (op) => [
    ...Object.entries(op.esc).filter(([, o]) => o).map(([g, o]) => ({ g, o, q: 1 })),
    ...Object.entries(op.ext).flatMap(([g, m]) => Object.entries(m).filter(([, q]) => q > 0).map(([o, q]) => ({ g, o, q }))),
  ];
  function abrirOpcoes(id) {
    const it = itemDe(id);
    if (!it) return;
    OP = { id, esc: {}, ext: {}, qtd: 1, obs: '' };
    // Já vem marcada a primeira opção dos grupos obrigatórios (ex.: tamanho pequeno).
    OPC.grupos(it).forEach((g) => { if (g.tipo === 'escolha' && +g.min >= 1) OP.esc[g.id] = g.opcoes[0].id; });
    $('#dlTitle').textContent = it.nome;
    $('#dlBody').innerHTML = tOpcoes();
    openSheet('sh-dl');
  }
  function tOpcoes() {
    const it = itemDe(OP.id);
    const c = OPC.calcular(it, selDe(OP));
    return `<div class="stack-lg dl-opcoes">
      ${it.foto ? `<img class="dl-foto-g" src="${esc(it.foto)}" alt="">` : ''}
      ${it.desc ? `<p class="muted">${esc(it.desc)}</p>` : ''}
      ${OPC.grupos(it).map((g) => {
        const tot = Object.values(OP.ext[g.id] || {}).reduce((t, q) => t + q, 0);
        return `<section class="dl-grupo"><h3 class="dl-h3">${esc(g.nome)} <small class="muted">${g.tipo === 'escolha' ? (+g.min >= 1 ? 'Escolha 1 · obrigatório' : 'Escolha 1 · opcional') : `${+g.max ? `Até ${g.max}` : 'Opcional'}${+g.min ? ` · mínimo ${g.min}` : ''}`}</small></h3>
          <ul>${g.opcoes.map((o) => g.tipo === 'escolha'
            ? `<li><label class="dl-op"><input type="radio" name="g-${esc(g.id)}" data-op-esc="${esc(g.id)}" value="${esc(o.id)}" ${OP.esc[g.id] === o.id ? 'checked' : ''}><span>${esc(o.nome)}</span>${+o.preco ? `<small>+ ${brl(+o.preco)}</small>` : ''}</label></li>`
            : `<li class="dl-op"><span>${esc(o.nome)}${+o.preco ? ` <small>+ ${brl(+o.preco)}</small>` : ''}</span>
                <span class="dl-qtd"><button type="button" class="icon-btn" data-op-ext="${esc(g.id)}|${esc(o.id)}|-1" aria-label="Menos ${esc(o.nome)}" ${(OP.ext[g.id] || {})[o.id] ? '' : 'disabled'}>${icon('minus')}</button><b>${(OP.ext[g.id] || {})[o.id] || 0}</b>
                <button type="button" class="icon-btn" data-op-ext="${esc(g.id)}|${esc(o.id)}|1" aria-label="Mais ${esc(o.nome)}" ${+g.max && tot >= +g.max ? 'disabled' : ''}>${icon('plus')}</button></span></li>`).join('')}</ul></section>`;
      }).join('')}
      <label class="field"><span>Observação (opcional)</span><input class="input" id="opObs" maxlength="140" placeholder="Ex.: sem cebola" value="${esc(OP.obs)}"></label>
      <div class="dl-op-rodape">
        <span class="dl-qtd"><button type="button" class="icon-btn" data-op-qtd="-1" aria-label="Menos" ${OP.qtd > 1 ? '' : 'disabled'}>${icon('minus')}</button><b>${OP.qtd}</b><button type="button" class="icon-btn" data-op-qtd="1" aria-label="Mais">${icon('plus')}</button></span>
        <button type="button" class="btn btn-cobalt" data-op-ok ${c.erro ? 'disabled' : ''}>${c.erro ? esc(c.erro) : `Adicionar · ${brl(c.preco * OP.qtd)}`}</button>
      </div>
    </div>`;
  }
  const redesenharOpcoes = () => { OP.obs = ($('#opObs') || {}).value || OP.obs; $('#dlBody').innerHTML = tOpcoes(); };
  function confirmarOpcoes() {
    OP.obs = ($('#opObs') || {}).value || '';
    const opcoes = selDe(OP);
    const c = OPC.calcular(itemDe(OP.id), opcoes);
    if (c.erro) return toast(c.erro, { tone: 'error' });
    const chave = chaveLinha(OP.id, opcoes) + (OP.obs ? `#${OP.obs}` : '');
    const x = carrinho.get(chave) || { id: OP.id, qtd: 0, obs: OP.obs, opcoes };
    x.qtd = Math.min(50, x.qtd + OP.qtd);
    carrinho.set(chave, x);
    guardarCarrinho();
    OP = null;
    closeSheet();
    toast('Adicionado ao carrinho.', { tone: 'ok' });
    renderCardapio();
  }

  /* ---------------- Carrinho e finalizar ---------------- */
  const FORMAS = [['pix', 'Pix'], ['cartao', 'Cartão na entrega'], ['dinheiro', 'Dinheiro']];
  function tCarrinho() {
    const lista = [...carrinho].filter(([, x]) => itemDe(x.id) && !calc(x).erro);
    if (!lista.length) return `<div class="empty"><h2>Carrinho vazio</h2><p>Escolha os itens no cardápio.</p></div>`;
    const sub = subtotal();
    const tx = taxa();
    const km = distancia();
    const falta = Math.max(0, (+D.minimo || 0) - sub);
    const formas = FORMAS.filter(([k]) => D.pagamentos && D.pagamentos[k]);
    const forma = cliente.forma && formas.some(([k]) => k === cliente.forma) ? cliente.forma : (formas[0] || [])[0];
    const itensHtml = `<ul class="dl-carrinho">${lista.map(([k, x]) => {
        const i = itemDe(x.id);
        const c = calc(x);
        return `<li><div class="dl-c-top"><span class="dl-qtd"><button type="button" class="icon-btn" data-dl-menos="${esc(k)}" aria-label="Tirar um">${icon('minus')}</button><b>${x.qtd}</b><button type="button" class="icon-btn" data-dl-mais="${esc(k)}" aria-label="Mais um">${icon('plus')}</button></span>
          <span class="dl-c-nome"><b>${esc(i.nome)}</b>${c.rotulos && c.rotulos.length ? `<small>${esc(c.rotulos.join(' · '))}</small>` : ''}</span><span class="price">${brl(c.preco * x.qtd)}</span></div>
          <input class="input dl-c-obs" data-dl-obs="${esc(k)}" maxlength="140" placeholder="Observação (ex.: sem cebola)" value="${esc(x.obs || '')}"></li>`;
      }).join('')}</ul>`;
    // Passo 1 (nada guardado neste aparelho): o celular, para achar os endereços dos pedidos anteriores.
    if (entrega === 'tel') {
      return `<form class="stack-lg dl-form" id="dlForm" novalidate>
        ${itensHtml}
        <section class="stack dl-tel"><h3 class="dl-h3">Entrega</h3>
          <p class="muted">Já pediu aqui? Digite seu celular e a gente acha o seu endereço.</p>
          <div class="dl-tel-row">
            <label class="field"><span>Celular (WhatsApp)</span><input class="input" name="telefone" type="tel" inputmode="tel" autocomplete="tel" maxlength="16" placeholder="(31) 99999-9999" value="${esc(cliente.telefone || '')}"></label>
            <button type="submit" class="btn btn-cobalt" ${enviando ? 'disabled' : ''}>${icon('search')} Buscar</button>
          </div>
          <p class="form-error" id="dlErro" role="alert"></p>
          <button type="button" class="link-btn" data-dl="novo-end">É meu primeiro pedido · preencher o endereço</button>
        </section>
      </form>`;
    }
    // Achou endereços pelo celular: "é um destes?" (resumo mascarado; o endereço completo fica no servidor).
    if (entrega === 'lista' && busca) {
      return `<form class="stack-lg dl-form" id="dlForm" novalidate>
        ${itensHtml}
        <section class="stack"><h3 class="dl-h3">${busca.nome ? `Olá, ${esc(busca.nome)}! ` : ''}Entregar em um destes endereços?</h3>
          <div class="dl-ends">${busca.enderecos.map((x, n) => `<button type="button" class="dl-end" data-dl-end="${n}" ${x.taxa == null ? 'disabled' : ''}>
            ${icon('pin')}<span><b>${esc(resumoEnd(x))}</b><small>${x.taxa == null ? 'Fora da área de entrega' : `${String(x.distancia).replace('.', ',')} km · entrega ${+x.taxa ? brl(+x.taxa) : 'grátis'}`}</small></span>
            <span class="dl-end-ok">Sim, este</span></button>`).join('')}</div>
          <button type="button" class="btn btn-line btn-block" data-dl="novo-end">Não, é outro endereço</button>
        </section>
      </form>`;
    }
    return `<form class="stack-lg dl-form" id="dlForm" novalidate>
      ${itensHtml}

      ${entrega === 'salvo' && salvo ? `<section class="stack"><h3 class="dl-h3">Entrega</h3>
        <div class="dl-local is-ok dl-salvo">${icon('pin')}<span><b>${esc(resumoEnd(salvo))}</b><small>${String(salvo.distancia).replace('.', ',')} km · entrega ${+salvo.taxa ? brl(+salvo.taxa) : 'grátis'}</small></span>
          <button type="button" class="btn btn-quiet btn-sm" data-dl="trocar-end">Trocar</button></div>
        <label class="field"><span>Ponto de referência (opcional)</span><input class="input" name="referencia" maxlength="120" value="${esc(endereco.referencia || '')}"></label>
      </section>` : `<section class="stack"><h3 class="dl-h3">Entrega</h3>
        <div class="dl-row">
          <label class="field"><span>CEP</span><input class="input mono" name="cep" inputmode="numeric" maxlength="9" placeholder="00000-000" value="${esc(endereco.cep || '')}"></label>
          <label class="field dl-num"><span>Número</span><input class="input" name="numero" maxlength="20" value="${esc(endereco.numero || '')}"></label>
        </div>
        <label class="field"><span>Rua</span><input class="input" name="rua" maxlength="120" value="${esc(endereco.rua || '')}"></label>
        <div class="dl-row">
          <label class="field"><span>Bairro</span><input class="input" name="bairro" maxlength="80" value="${esc(endereco.bairro || '')}"></label>
          <label class="field"><span>Cidade</span><input class="input" name="cidade" maxlength="80" value="${esc(endereco.cidade || '')}"></label>
        </div>
        <label class="field"><span>Complemento (opcional)</span><input class="input" name="complemento" maxlength="80" placeholder="Apto, bloco, casa" value="${esc(endereco.complemento || '')}"></label>
        <label class="field"><span>Ponto de referência (opcional)</span><input class="input" name="referencia" maxlength="120" value="${esc(endereco.referencia || '')}"></label>
        <div class="dl-local ${km == null ? '' : tx == null ? 'is-fora' : 'is-ok'}" id="dlLocal">
          ${km == null ? `<span>${icon('pin')} Confirme a localização para calcular a entrega.</span>`
            : tx == null ? `<span>${icon('alert')} Endereço fora da área de entrega (${String(km).replace('.', ',')} km).</span>`
            : `<span>${icon('check')} ${String(km).replace('.', ',')} km · entrega ${tx ? brl(tx) : 'grátis'}</span>`}
          <span class="dl-local-acts"><button type="button" class="btn btn-line btn-sm" data-dl="localizar">${icon('search')} Localizar endereço</button>
          <button type="button" class="btn btn-quiet btn-sm" data-dl="gps">${icon('pin')} Usar minha localização</button></span>
        </div>
      </section>`}

      <section class="stack"><h3 class="dl-h3">Seus dados</h3>
        <div class="dl-row">
          <label class="field"><span>Nome</span><input class="input" name="nome" maxlength="60" autocomplete="name" value="${esc(cliente.nome || '')}"></label>
          <label class="field"><span>Celular (WhatsApp)</span><input class="input" name="telefone" type="tel" inputmode="tel" autocomplete="tel" maxlength="16" value="${esc(cliente.telefone || '')}"></label>
        </div>
        ${temFid() ? `<label class="field"><span>CPF para ganhar pontos (opcional)</span><input class="input mono" name="cpf" inputmode="numeric" autocomplete="off" maxlength="14" placeholder="000.000.000-00" value="${esc(fmtCpf(cpfPedido()))}">
          <small class="help">Os pontos do clube entram sozinhos quando o pedido for entregue.</small></label>` : ''}
      </section>

      <section class="stack"><h3 class="dl-h3">Pagamento na entrega</h3>
        <div class="seg dl-formas" role="radiogroup">${formas.map(([k, l]) => `<button type="button" role="radio" aria-checked="${k === forma}" data-dl-forma="${k}">${l}</button>`).join('')}</div>
        ${forma === 'dinheiro' ? `<label class="field"><span>Troco para (opcional)</span><input class="input mono" name="troco" inputmode="decimal" placeholder="0,00" value="${esc(cliente.troco || '')}"></label>` : ''}
        ${forma === 'pix' && D.pix ? `<small class="help">A chave Pix aparece depois de fazer o pedido.</small>` : ''}
        <label class="field"><span>Observações do pedido (opcional)</span><textarea class="textarea" name="obs" rows="2" maxlength="300">${esc(cliente.obs || '')}</textarea></label>
      </section>

      <dl class="dl-totais">
        <div><dt>Itens</dt><dd>${brl(sub)}</dd></div>
        <div><dt>Entrega</dt><dd>${tx == null ? '—' : tx ? brl(tx) : 'Grátis'}</dd></div>
        <div class="dl-total"><dt>Total</dt><dd>${brl(sub + (tx || 0))}</dd></div>
      </dl>
      ${falta ? `<p class="note">${icon('alert')}<span>Faltam ${brl(falta)} para o pedido mínimo de ${brl(+D.minimo)}.</span></p>` : ''}
      <p class="form-error" id="dlErro" role="alert"></p>
      <button type="submit" class="btn btn-cobalt btn-block" ${falta || tx == null || !podePedir() || enviando ? 'disabled' : ''}>${icon('check')} ${podePedir() ? `Fazer pedido · ${brl(sub + (tx || 0))}` : 'Restaurante fechado'}</button>
    </form>`;
  }
  function abrirCarrinho() {
    // Nada guardado neste aparelho (nem endereço, nem endereço salvo): começa pelo celular.
    if (!entrega) entrega = salvo && salvo.ref ? 'salvo' : endereco.rua ? 'form' : 'tel';
    $('#dlTitle').textContent = 'Seu pedido';
    $('#dlBody').innerHTML = tCarrinho();
    openSheet('sh-dl');
  }
  // Lê o formulário para o estado (sem perder o que foi digitado ao redesenhar).
  function lerForm() {
    const f = $('#dlForm');
    if (!f) return;
    // Só lê os campos que estão na tela (os passos do celular e do endereço salvo não têm todos).
    const tem = (n) => !!f.elements[n];
    const v = (n, antes = '') => (f.elements[n] ? f.elements[n].value.trim() : antes);
    if (tem('rua')) {
      const novoEnd = { ...endereco, cep: v('cep'), numero: v('numero'), rua: v('rua'), bairro: v('bairro'), cidade: v('cidade'), complemento: v('complemento'), referencia: v('referencia') };
      // Mudou o endereço: a localização antiga não vale mais.
      if (['cep', 'numero', 'rua', 'bairro', 'cidade'].some((k) => (novoEnd[k] || '') !== (endereco[k] || '')) && !novoEnd.gps) { delete novoEnd.lat; delete novoEnd.lng; }
      endereco = novoEnd;
    } else if (tem('referencia')) endereco = { ...endereco, referencia: v('referencia') };
    cliente = { ...cliente, nome: v('nome', cliente.nome), telefone: v('telefone', cliente.telefone), troco: v('troco', cliente.troco), obs: v('obs', cliente.obs), cpf: tem('cpf') ? soDigitos(v('cpf')) : cliente.cpf };
    if (endereco.rua) safeSet('dl-endereco', JSON.stringify(endereco));
    guardarCliente();
  }
  const redesenharCarrinho = () => { lerForm(); $('#dlBody').innerHTML = tCarrinho(); };
  // Atualiza só a localização, os totais e o botão (sem apagar o que está sendo digitado).
  function atualizarResumo() {
    lerForm();
    const tmp = document.createElement('div');
    tmp.innerHTML = tCarrinho();
    ['#dlLocal', '.dl-totais', '#dlForm [type=submit]'].forEach((sel) => {
      const a = $(sel);
      const b = tmp.querySelector(sel);
      if (a && b) a.replaceWith(b);
    });
  }

  async function buscarCep(cep) {
    try {
      const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
      const j = await r.json();
      if (j.erro) return toast('CEP não encontrado. Confira os números.', { tone: 'error' });
      lerForm();
      Object.assign(endereco, { rua: j.logradouro || endereco.rua, bairro: j.bairro || endereco.bairro, cidade: j.localidade || endereco.cidade, uf: j.uf });
      delete endereco.lat; delete endereco.lng; delete endereco.gps;
      $('#dlBody').innerHTML = tCarrinho();
      const n = $('#dlForm [name=numero]');
      if (n && !n.value) n.focus();
    } catch {
      toast('Não foi possível buscar o CEP. Preencha o endereço.', { tone: 'error' });
    }
  }
  // Endereço → coordenadas (OpenStreetMap). Tenta com número, depois só a rua, depois o CEP.
  async function localizar() {
    lerForm();
    const e = endereco;
    if (!e.rua || !e.cidade) return toast('Preencha o CEP ou a rua e a cidade.', { tone: 'error' });
    const tentativas = [
      `${e.rua}, ${e.numero || ''}, ${e.bairro || ''}, ${e.cidade}${e.uf ? `, ${e.uf}` : ''}, Brasil`,
      `${e.rua}, ${e.cidade}${e.uf ? `, ${e.uf}` : ''}, Brasil`,
      soDigitos(e.cep).length === 8 ? `${soDigitos(e.cep).replace(/(\d{5})(\d{3})/, '$1-$2')}, Brasil` : null,
    ].filter(Boolean);
    const b = $('[data-dl="localizar"]');
    if (b) { b.disabled = true; b.textContent = 'Localizando…'; }
    for (const q of tentativas) {
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': 'pt-BR' } });
        const j = await r.json();
        if (j && j[0]) {
          Object.assign(endereco, { lat: +j[0].lat, lng: +j[0].lon, gps: false });
          safeSet('dl-endereco', JSON.stringify(endereco));
          $('#dlBody').innerHTML = tCarrinho();
          return;
        }
      } catch {}
    }
    toast('Não achamos o endereço no mapa. Toque em "Usar minha localização" ou confira o endereço.', { tone: 'error', ms: 5000 });
    $('#dlBody').innerHTML = tCarrinho();
  }
  function usarGps() {
    lerForm();
    if (!navigator.geolocation) return toast('Este celular não informa a localização.', { tone: 'error' });
    navigator.geolocation.getCurrentPosition(
      (p) => {
        Object.assign(endereco, { lat: p.coords.latitude, lng: p.coords.longitude, gps: true });
        safeSet('dl-endereco', JSON.stringify(endereco));
        $('#dlBody').innerHTML = tCarrinho();
      },
      () => toast('Permita o acesso à localização ou use "Localizar endereço".', { tone: 'error', ms: 4500 }),
      { enableHighAccuracy: true, timeout: 12000 },
    );
  }

  // Passo do celular: busca os endereços dos pedidos anteriores neste restaurante.
  async function buscarEnderecos() {
    lerForm();
    const erro = (m) => { const el = $('#dlErro'); if (el) el.textContent = m; };
    if (!/^[1-9]\d{9,10}$/.test(soDigitos(cliente.telefone).replace(/^55(?=\d{10,11}$)/, ''))) return erro('Informe o celular com DDD.');
    guardarCliente();
    enviando = true;
    $('#dlBody').innerHTML = tCarrinho();
    let r;
    try {
      r = await store.deliveryEnderecos(cliente.telefone);
    } catch {
      r = { status: 'erro', mensagem: 'Sem conexão para buscar o endereço. Preencha abaixo.' };
    }
    enviando = false;
    if (r.status === 'ok') {
      busca = r;
      if (!cliente.nome && r.nome) cliente.nome = r.nome;
      entrega = 'lista';
    } else {
      entrega = 'form';
      if (r.status === 'nenhum') toast('Não achamos pedidos com este celular. Preencha o endereço.', { ms: 4000 });
      else if (r.mensagem) toast(r.mensagem, { tone: 'error' });
    }
    $('#dlBody').innerHTML = tCarrinho();
  }

  async function enviar() {
    if (entrega === 'tel') return buscarEnderecos();
    lerForm();
    const erro = (m) => { const el = $('#dlErro'); if (el) el.textContent = m; };
    if ((cliente.nome || '').length < 2) return erro('Informe seu nome.');
    if (!/^[1-9]\d{9,10}$/.test(soDigitos(cliente.telefone).replace(/^55(?=\d{10,11}$)/, ''))) return erro('Informe um celular com DDD.');
    const comSalvo = entrega === 'salvo' && salvo;
    if (!comSalvo && (!endereco.rua || !endereco.numero || !endereco.bairro)) return erro('Complete o endereço: rua, número e bairro.');
    if (!comSalvo && !endereco.lat) return erro('Toque em "Localizar endereço" para calcular a entrega.');
    const cpf = temFid() ? cpfPedido() : '';
    if (cpf && !Store.fid.cpfValido(cpf)) return erro('CPF inválido. Confira os números ou deixe em branco.');
    const contaFid = temFid() && Fidelidade.conta ? Fidelidade.conta() : null;
    const forma = ($('[data-dl-forma][aria-checked="true"]') || {}).dataset?.dlForma;
    const troco = cliente.troco ? parseFloat(String(cliente.troco).replace(/\./g, '').replace(',', '.')) : null;
    enviando = true;
    const btn = $('#dlForm [type=submit]');
    if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }
    let r;
    try {
      r = await store.deliveryPedir({
        cliente: { nome: cliente.nome, telefone: cliente.telefone },
        endereco: comSalvo ? { ref: salvo.ref, referencia: endereco.referencia || '' } : endereco,
        itens: [...carrinho.values()].map((x) => ({ id: x.id, qtd: x.qtd, obs: x.obs || '', opcoes: x.opcoes || [] })),
        pagamento: { forma, troco },
        obs: cliente.obs || '',
        cpf: cpf || null,
        fid_token: !cpf && contaFid && contaFid.token ? contaFid.token : null,
      });
    } catch {
      r = { status: 'erro', mensagem: 'Sem conexão. Confira a internet e tente de novo.' };
    }
    enviando = false;
    if (r.status !== 'ok') {
      $('#dlBody').innerHTML = tCarrinho();
      return erro(r.mensagem || 'Não foi possível enviar o pedido.');
    }
    carrinho.clear();
    guardarCarrinho();
    cliente.obs = '';
    // Próximo pedido neste aparelho já abre com este endereço.
    safeSet('dl-salvo', comSalvo ? JSON.stringify(salvo) : null);
    guardarCliente();
    const meus = JSON.parse(safeGet('dl-pedidos') || '[]').filter((p) => Date.now() - p.em < 2 * 864e5);
    safeSet('dl-pedidos', JSON.stringify([{ token: r.token, numero: r.numero, em: Date.now() }, ...meus].slice(0, 10)));
    closeSheet();
    // Fechar a folha volta o histórico; o link do pedido entra depois disso.
    setTimeout(() => history.replaceState(null, '', `?pedido=${r.token}`), 400);
    acompanhar(r.token);
  }

  /* ---------------- Acompanhar o pedido ---------------- */
  const ETAPAS = [['recebido', 'Pedido recebido', 'O restaurante já viu seu pedido.'], ['preparo', 'Em preparo', 'A cozinha está preparando.'],
    ['saiu', 'Saiu para entrega', 'O entregador está a caminho.'], ['entregue', 'Entregue', 'Bom apetite!']];
  let acompanhando = null;
  let timer = 0;
  async function acompanhar(token) {
    acompanhando = token;
    renderBarra();
    let r;
    try {
      r = await store.deliveryAcompanhar(token);
    } catch {
      r = null;
    }
    if (!r || r.status !== 'ok') {
      $('#dlMain').innerHTML = `<div class="empty"><h2>Pedido não encontrado</h2><p>O link pode ter expirado.</p><a class="btn btn-cobalt" href="./">Ver o cardápio</a></div>`;
      return;
    }
    const p = r.pedido;
    const rest = r.restaurante || {};
    const i = ETAPAS.findIndex(([k]) => k === p.status);
    const cancelado = p.status === 'cancelado';
    const f = p.fid || {};
    const quando = (k) => { const h = (p.historico || []).filter((x) => x.status === k).pop(); return h ? new Date(h.em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''; };
    const wa = soDigitos(rest.whatsapp || rest.telefone);
    $('#dlMain').innerHTML = `<div class="stack-lg dl-acomp">
      <div class="plate dl-num"><span class="rivet r1"></span><span class="rivet r2"></span><small>Pedido</small><b>#${p.numero}</b></div>
      ${['entregue', 'cancelado'].includes(p.status) ? '' : `<div class="dl-avisos" id="dlAvisos">${avisosHtml(token)}</div>`}
      ${cancelado ? `<p class="note dl-cancelado">${icon('alert')}<span><b>Pedido cancelado.</b> ${esc(p.motivo || 'Fale com o restaurante.')}</span></p>`
        : `<ol class="dl-etapas">${ETAPAS.map(([k, t, d], n) => `<li class="${n < i ? 'is-feito' : n === i ? 'is-agora' : ''}">
            <span class="dl-bola">${n <= i ? icon('check') : ''}</span><div><b>${t}</b><small>${n === i ? (k === 'saiu' && p.entregador ? `${esc(p.entregador)} está a caminho.` : d) : quando(k)}</small></div></li>`).join('')}</ol>
          ${p.status !== 'entregue' && rest.tempo ? `<p class="muted dl-tempo">${icon('clock')} Tempo estimado: ${esc(rest.tempo)} min</p>` : ''}`}
      ${p.pagamento.forma === 'pix' && rest.pix && !cancelado ? `<div class="dl-pix"><span>Pague pelo Pix na entrega ou agora:</span><b class="mono">${esc(rest.pix)}</b><button type="button" class="btn btn-line btn-sm" data-dl-copiar="${esc(rest.pix)}">${icon('copy')} Copiar chave</button></div>` : ''}
      <section class="stack"><h3 class="dl-h3">Resumo</h3>
        <ul class="dl-resumo">${p.itens.map((x) => `<li><span>${x.qtd}× ${esc(x.nome)}${x.opcoes && x.opcoes.length ? `<small>${esc(x.opcoes.join(' · '))}</small>` : ''}${x.obs ? `<small>${esc(x.obs)}</small>` : ''}</span><span>${brl(x.preco * x.qtd)}</span></li>`).join('')}</ul>
        <dl class="dl-totais"><div><dt>Itens</dt><dd>${brl(p.subtotal)}</dd></div><div><dt>Entrega</dt><dd>${+p.taxa ? brl(p.taxa) : 'Grátis'}</dd></div><div class="dl-total"><dt>Total</dt><dd>${brl(p.total)}</dd></div></dl>
        <p class="muted">${esc([p.endereco.rua, p.endereco.numero].filter(Boolean).join(', '))}${p.endereco.complemento ? ` · ${esc(p.endereco.complemento)}` : ''} · ${esc(p.endereco.bairro || '')}<br>
          Pagamento: ${esc({ pix: 'Pix', cartao: 'Cartão na entrega', dinheiro: 'Dinheiro' }[p.pagamento.forma] || '')}${p.pagamento.troco ? ` (troco para ${brl(p.pagamento.troco)})` : ''}</p>
      </section>
      ${temFid() && !cancelado ? `<section class="stack dl-fid"><h3 class="dl-h3">${icon('gift')} ${f.situacao === 'creditado' || f.situacao === 'nota' ? 'Pontos deste pedido' : 'Ganhe pontos com este pedido'}</h3>
        <p class="muted">${fidTexto(p)}</p>
        ${Fidelidade.tile()}</section>` : ''}
      ${wa ? `<a class="btn btn-line btn-block" href="https://wa.me/55${wa.replace(/^55/, '')}?text=${encodeURIComponent(`Olá! Sobre o pedido #${p.numero}`)}" target="_blank" rel="noopener">${icon('phone')} Falar com o restaurante</a>` : ''}
      <a class="btn btn-quiet btn-block" href="./">Fazer outro pedido</a>
    </div>`;
    avisoLocal(token, p);
    clearTimeout(timer);
    if (!['entregue', 'cancelado'].includes(p.status)) timer = setTimeout(() => acompanhando === token && acompanhar(token), 15000);
  }

  /* ---------------- Avisos do pedido ----------------
     Web Push: chega mesmo com a página fechada. Android (Chrome) funciona direto do site; no iPhone
     a Apple só entrega com o site adicionado à tela de início (iOS 16.4+), então ali mostramos o passo a passo. */
  const ETAPA_AVISO = { recebido: ['recebido', 'O restaurante já viu o seu pedido.'], preparo: ['em preparo', 'A cozinha começou a preparar o seu pedido.'],
    saiu: ['saiu para entrega', 'O entregador está a caminho.'], entregue: ['entregue', 'Bom apetite!'], cancelado: ['cancelado', 'Fale com o restaurante para saber mais.'] };
  const ehIphone = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const instalado = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const temPush = () => 'Notification' in window && 'serviceWorker' in navigator;
  const avisosLigados = (token) => safeGet(`dl-push-${token}`) === '1' && temPush() && Notification.permission === 'granted';
  function avisosHtml(token) {
    if (avisosLigados(token)) return `<p class="dl-avisos-ok">${icon('check')}<span><b>Avisos ligados.</b> Vamos avisar no celular quando o pedido andar.</span></p>`;
    if (!temPush()) {
      if (ehIphone && !instalado()) return `<div class="dl-avisos-box"><b>${icon('bell')} Quer ser avisado quando o pedido andar?</b>
        <p>No iPhone: toque em <b>Compartilhar</b> ${icon('share')} e depois em <b>Adicionar à Tela de Início</b>. Abra o pedido pelo ícone e ligue os avisos.</p></div>`;
      return '';
    }
    if (Notification.permission === 'denied') return `<p class="dl-avisos-off">${icon('bell')}<span>Os avisos estão bloqueados neste navegador. Para receber, libere as notificações nas configurações do site.</span></p>`;
    return `<div class="dl-avisos-box"><b>${icon('bell')} Avisar quando o pedido andar?</b>
      <p>Receba no celular quando entrar em preparo, sair para entrega e chegar.</p>
      <button type="button" class="btn btn-cobalt btn-block" data-dl-avisos>${icon('bell')} Ligar avisos do pedido</button></div>`;
  }
  const b64u = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
  async function ligarAvisos(token, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Ligando…'; }
    try {
      const reg = await navigator.serviceWorker.register('/delivery/sw.js', { scope: '/delivery/' });
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        // Sem servidor de push (demonstração ou fora do ar): ainda avisa enquanto a página estiver aberta.
        const chave = await store.deliveryPushChave().catch(() => null);
        if (chave && reg.pushManager) {
          await navigator.serviceWorker.ready;
          let sub = await reg.pushManager.getSubscription();
          if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(chave) });
          const r = await store.deliveryPushInscrever(token, sub.toJSON(), `/delivery/?pedido=${token}`);
          if (r && r.status === 'erro') throw new Error(r.mensagem);
        }
        safeSet(`dl-push-${token}`, '1');
        toast('Avisos ligados.', { tone: 'ok' });
      }
    } catch (e) {
      console.error(e);
      toast((e && e.message) || 'Não foi possível ligar os avisos neste aparelho.', { tone: 'error' });
    }
    const box = $('#dlAvisos');
    if (box && acompanhando === token) box.innerHTML = avisosHtml(token);
  }
  // Com a página aberta em segundo plano, avisa a mudança mesmo sem o servidor (mesma etiqueta do push: não duplica).
  const ultimaSituacao = {};
  function avisoLocal(token, p) {
    const antes = ultimaSituacao[token];
    ultimaSituacao[token] = p.status;
    if (!antes || antes === p.status || !document.hidden || !avisosLigados(token)) return;
    const [t, d] = ETAPA_AVISO[p.status] || [];
    if (!t) return;
    navigator.serviceWorker.getRegistration('/delivery/').then((reg) => reg && reg.showNotification(`Pedido #${p.numero} ${t}`, {
      body: p.status === 'saiu' && p.entregador ? `${p.entregador} está a caminho.` : p.status === 'cancelado' && p.motivo ? p.motivo : d,
      icon: '/admin/icons/icon-192.png', tag: `pedido-${p.numero}`, data: { url: `/delivery/?pedido=${token}` },
    })).catch(() => {});
  }

  // Voltou à página com um pedido recente: atalho para acompanhar.
  function avisoPedidoAberto() {
    let meus = [];
    try { meus = JSON.parse(safeGet('dl-pedidos') || '[]').filter((p) => Date.now() - p.em < 6 * 3600e3); } catch {}
    if (!meus.length) return;
    const p = meus[0];
    $('#dlMain').insertAdjacentHTML('afterbegin', `<a class="note dl-aviso" href="?pedido=${esc(p.token)}">${icon('clock')}<span>Acompanhe seu pedido <b>#${p.numero}</b></span></a>`);
  }

  /* ---------------- Eventos ---------------- */
  document.addEventListener('click', (e) => {
    const t = e.target;
    const c = t.closest('[data-dl-cat]');
    if (c) {
      cat = c.dataset.dlCat;
      document.querySelectorAll('[data-dl-cat]').forEach((b) => b.setAttribute('aria-pressed', String(b === c)));
      const s = document.getElementById('cat-' + cat);
      return s && s.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    const esc1 = t.closest('[data-dl-escolher]');
    if (esc1) return abrirOpcoes(esc1.dataset.dlEscolher);
    const ext = t.closest('[data-op-ext]');
    if (ext && OP) {
      const [g, o, d] = ext.dataset.opExt.split('|');
      const m = (OP.ext[g] = OP.ext[g] || {});
      m[o] = Math.max(0, Math.min(20, (m[o] || 0) + +d));
      return redesenharOpcoes();
    }
    const oq = t.closest('[data-op-qtd]');
    if (oq && OP) { OP.qtd = Math.max(1, Math.min(50, OP.qtd + +oq.dataset.opQtd)); return redesenharOpcoes(); }
    if (t.closest('[data-op-ok]') && OP) return confirmarOpcoes();
    const mais = t.closest('[data-dl-mais]');
    const menos = t.closest('[data-dl-menos]');
    if (mais || menos) {
      mudarQtd((mais || menos).dataset[mais ? 'dlMais' : 'dlMenos'], mais ? 1 : -1);
      if ($('#dlForm')) redesenharCarrinho();
      return renderCardapio();
    }
    const acao = t.closest('[data-dl]');
    if (acao) {
      const a = acao.dataset.dl;
      if (a === 'carrinho') return abrirCarrinho();
      if (a === 'localizar') return localizar();
      if (a === 'gps') return usarGps();
      if (a === 'novo-end') { lerForm(); entrega = 'form'; $('#dlBody').innerHTML = tCarrinho(); const c1 = $('#dlForm [name=cep]'); return c1 && c1.focus(); }
      if (a === 'trocar-end') { lerForm(); entrega = busca ? 'lista' : 'tel'; return ($('#dlBody').innerHTML = tCarrinho()); }
    }
    const end = t.closest('[data-dl-end]');
    if (end && busca) {
      lerForm();
      salvo = busca.enderecos[+end.dataset.dlEnd];
      entrega = 'salvo';
      return ($('#dlBody').innerHTML = tCarrinho());
    }
    const f = t.closest('[data-dl-forma]');
    if (f) {
      cliente.forma = f.dataset.dlForma;
      return redesenharCarrinho();
    }
    const av = t.closest('[data-dl-avisos]');
    if (av && acompanhando) return ligarAvisos(acompanhando, av);
    const cp = t.closest('[data-dl-copiar]');
    if (cp) UI.copyText(cp.dataset.dlCopiar).then((ok) => toast(ok ? 'Chave Pix copiada.' : 'Não foi possível copiar.', { tone: ok ? 'ok' : 'error' }));
  });
  document.addEventListener('input', (e) => {
    const o = e.target.closest('[data-dl-obs]');
    if (o) {
      const x = carrinho.get(o.dataset.dlObs);
      if (x) { x.obs = o.value; guardarCarrinho(); }
      return;
    }
    if (e.target.name === 'cep' && e.target.closest('#dlForm')) {
      const d = soDigitos(e.target.value).slice(0, 8);
      e.target.value = d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
      if (d.length === 8 && d !== soDigitos(endereco.cep)) buscarCep(d);
    }
  });
  document.addEventListener('change', (e) => {
    const r = e.target.closest('[data-op-esc]');
    if (r && OP) { OP.esc[r.dataset.opEsc] = r.value; return redesenharOpcoes(); }
    // Número ou rua mudaram: a localização precisa ser refeita.
    if (e.target.closest('#dlForm') && ['numero', 'rua', 'bairro', 'cidade'].includes(e.target.name)) atualizarResumo();
  });
  document.addEventListener('submit', (e) => {
    if (e.target.id !== 'dlForm') return;
    e.preventDefault();
    enviar();
  });

  /* ---------------- Início ---------------- */
  document.querySelectorAll('[data-close].icon-btn').forEach((b) => (b.innerHTML = icon('x')));
  store
    .init()
    .catch((err) => {
      if (err.code === 'SEM_RESTAURANTE') { UI.semRestaurante(); return new Promise(() => {}); }
      toast('Sem conexão com o restaurante. Tente de novo em instantes.', { tone: 'error', ms: 5000 });
    })
    .then(() => store.getSettings())
    .then((s) => {
      live = s;
      R = s.restaurante;
      D = s.delivery || Store.delivery.PADRAO;
      if (R.cor) aplicarCor(R.cor);
      renderTopo();
      if (!s.plano.servicos.delivery) {
        $('#dlMain').innerHTML = `<div class="empty"><h2>Delivery indisponível</h2><p>Este restaurante ainda não faz pedidos por aqui.</p></div>`;
        return;
      }
      try {
        JSON.parse(safeGet('dl-carrinho') || '[]').forEach(([k, x]) => {
          const linha = { opcoes: [], ...x, id: x.id || k };
          if (itemDe(linha.id) && !calc(linha).erro) carrinho.set(k, linha);
        });
      } catch {}
      const token = new URLSearchParams(location.search).get('pedido');
      if (token) acompanhar(token);
      else {
        renderCardapio();
        avisoPedidoAberto();
      }
      // Clube de pontos: carrega depois e redesenha a tela atual com o cartão.
      if (live.modulos && live.modulos.fidelidade && window.Fidelidade) {
        Fidelidade.iniciar({ store, slug: (window.NFC_CONFIG && NFC_CONFIG.backend && NFC_CONFIG.backend.slug) || '', nomeRestaurante: R.nome })
          .then((p) => {
            if (!p) return;
            if (acompanhando) acompanhar(acompanhando);
            else { renderCardapio(); avisoPedidoAberto(); }
          })
          .catch((e) => console.error(e));
      }
    })
    .catch((e) => {
      console.error(e);
      $('#dlMain').innerHTML = '<p class="form-error">Não foi possível carregar o cardápio. Recarregue a página.</p>';
    });
})();
