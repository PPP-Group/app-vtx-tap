/*
 * Tabela de preços da VTX Tap — a mesma de public.plano_preco no banco.
 * Usada pelo painel, pela central e pela página de preços.
 *
 *   Precos.SERVICOS                  → [{ id, nome, preco, desc, incluso? }] (o sino, id garcom, vem incluso na página)
 *   Precos.ADICIONAIS                → [{ id, nome, preco, desc, combo? }] (no plano em plano.adicionais; combo: entra no desconto)
 *   Precos.COBRADOS                  → o que entra na conta do combo: página, fidelidade, delivery e Prorrogação
 *   Precos.itens(plano)              → { pagina, fidelidade, delivery, prorrogacao, ... } do plano, para o combo
 *   Precos.combo({ ... })            → { soma, total, economia, desconto, qtd } com o desconto por quantidade
 *   Precos.servicos({ ... })         → mensalidade dos itens do combo
 *   Precos.plano(plano)              → mensalidade do plano (combo + domínio próprio + adicionais fora do combo)
 *   Precos.SEFAZ_NOTA                → preço de cada nota conferida na SEFAZ (opcional, cobrado à parte)
 *   Precos.implantacao(mesas)        → implantação da faixa de mesas (até 20, 21 a 50, 51 ou mais)
 *   Precos.taxaMesas(paga, mesas, contrato) → taxa única ao subir de faixa (a diferença; metade no contrato de 12 meses)
 */
(function () {
  const SERVICOS = [
    { id: 'pagina', nome: 'Página da mesa, cardápio e sino', preco: 79, desc: 'Cardápio, Wi-Fi, avaliação no Google, comentários, informações do restaurante e o sino para chamar o garçom.' },
    { id: 'garcom', nome: 'Chamar o garçom', preco: 0, incluso: true, desc: 'Incluso na página da mesa: o sino na página e as abas Chamados e Salão do painel.' },
    { id: 'fidelidade', nome: 'Programa de fidelidade', preco: 229, desc: 'Pontos pela nota fiscal, prêmios, níveis, indicação e ranking.' },
    { id: 'delivery', nome: 'Delivery', preco: 169, desc: 'Pedidos para entrega com taxa por distância, cozinha e acompanhamento do pedido.' },
  ];
  // Desconto por quantidade de itens cobrados (o sino vem incluso na página): 2 −10%, 3 −17%
  // (página, fidelidade e delivery saem por R$ 399) e os quatro com preço fechado.
  const DESCONTO = { 2: 0.1, 3: 0.17 };
  const TODOS = 449;
  const DOMINIO_MES = 19;
  // Adicionais: o mesmo de public.adicional_preco. Ficam em plano.adicionais; os com combo: true entram no desconto.
  const ADICIONAIS = [
    { id: 'prorrogacao', nome: 'Prorrogação', preco: 89, combo: true, desc: 'Happy hour que ganha minutos a cada chopp: o garçom lê a comanda e o relógio cresce no telão e no celular.' },
  ];
  // Só os adicionais fora do combo (hoje nenhum): os do combo já entram em combo().
  const adicionais = (ad = {}) => ADICIONAIS.filter((a) => !a.combo && ad[a.id]).reduce((t, a) => t + a.preco, 0);
  // Conferência automática da nota na SEFAZ (fidelidade): o restaurante liga se quiser e paga por nota conferida.
  const SEFAZ_NOTA = 0.25;
  // Implantação por faixa de mesas (a mesma tabela de public.implantacao_faixa no banco).
  const IMPLANTACAO = [{ ate: 20, valor: 690, nome: 'até 20 mesas' }, { ate: 50, valor: 990, nome: '21 a 50 mesas' }, { ate: Infinity, valor: 1390, nome: '51 mesas ou mais' }];
  const faixa = (mesas) => IMPLANTACAO.find((f) => (+mesas || 0) <= f.ate);
  const implantacao = (mesas) => faixa(mesas).valor;
  // paga: a maior implantação já paga (0 quando o plano ainda não foi definido: não cobra).
  const taxaMesas = (paga, mesas, contrato) => (paga ? Math.max(0, implantacao(mesas) - paga) * (+contrato === 12 ? 0.5 : 1) : 0);

  // O sino (garcom) vem incluso na página: não entra na conta, e quem só tem o sino paga a página.
  const COBRADOS = [...SERVICOS.filter((s) => !s.incluso), ...ADICIONAIS.filter((a) => a.combo)];
  // Itens do plano para o combo: os serviços e os adicionais que entram no desconto.
  const itens = (p) => ({ ...((p && p.servicos) || {}), ...Object.fromEntries(ADICIONAIS.filter((a) => a.combo).map((a) => [a.id, !!((p && p.adicionais) || {})[a.id]])) });
  function combo(sv = {}) {
    const escolhidos = COBRADOS.filter((s) => sv[s.id] || (s.id === 'pagina' && sv.garcom));
    const soma = escolhidos.reduce((t, s) => t + s.preco, 0);
    let total = soma;
    if (escolhidos.length === COBRADOS.length) total = TODOS;
    else if (DESCONTO[escolhidos.length]) {
      // Preço com desconto, terminado em 9 (ex.: 106,20 → 109).
      const x = soma * (1 - DESCONTO[escolhidos.length]);
      total = Math.min(soma, Math.floor(x / 10) * 10 + 9);
    }
    return { soma, total, economia: soma - total, qtd: escolhidos.length, desconto: DESCONTO[escolhidos.length] || (escolhidos.length === COBRADOS.length ? 1 - TODOS / soma : 0) };
  }
  const servicos = (sv) => combo(sv).total;
  const plano = (p) => servicos(itens(p)) + (p && ['proprio', 'registro'].includes(p.dominio) ? DOMINIO_MES : 0) + adicionais((p && p.adicionais) || {});

  window.Precos = { SERVICOS, COBRADOS, ADICIONAIS, adicionais, itens, DESCONTO, TODOS, DOMINIO_MES, SEFAZ_NOTA, IMPLANTACAO, faixa, implantacao, taxaMesas, combo, servicos, plano };
})();
