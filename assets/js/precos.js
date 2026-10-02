/*
 * Tabela de preços da VTX Tap — a mesma de public.plano_preco no banco.
 * Usada pelo painel, pela central e pela página de preços.
 *
 *   Precos.SERVICOS                  → [{ id, nome, preco, desc }]
 *   Precos.servicos({ pagina, ... }) → mensalidade dos serviços (com desconto de combo)
 *   Precos.plano(plano)              → mensalidade do plano (serviços + domínio próprio + adicionais)
 *   Precos.ADICIONAIS                → [{ id, nome, preco, desc }] cobrados à parte (fora do desconto de combo)
 *   Precos.combo({ ... })            → { soma, total, economia, desconto } para mostrar o desconto
 *   Precos.SEFAZ_NOTA                → preço de cada nota conferida na SEFAZ (opcional, cobrado à parte)
 *   Precos.implantacao(mesas)        → implantação da faixa de mesas (até 20, 21 a 50, 51 ou mais)
 *   Precos.taxaMesas(paga, mesas, contrato) → taxa única ao subir de faixa (a diferença; metade no contrato de 12 meses)
 */
(function () {
  const SERVICOS = [
    { id: 'pagina', nome: 'Página da mesa e cardápio', preco: 49, desc: 'Cardápio, Wi-Fi, avaliação no Google, comentários e informações do restaurante.' },
    { id: 'garcom', nome: 'Chamar o garçom', preco: 19, desc: 'O sino na página da mesa e as abas Chamados e Salão do painel.' },
    { id: 'fidelidade', nome: 'Programa de fidelidade', preco: 199, desc: 'Pontos pela nota fiscal, prêmios, níveis, indicação e ranking.' },
    { id: 'delivery', nome: 'Delivery', preco: 149, desc: 'Pedidos para entrega com taxa por distância, cozinha e acompanhamento do pedido.' },
  ];
  // Desconto por quantidade de serviços; os quatro juntos têm preço fechado.
  const DESCONTO = { 2: 0.1, 3: 0.15 };
  const TODOS = 349;
  const DOMINIO_MES = 19;
  // Adicionais: o mesmo de public.adicional_preco. preco 0 = preço ainda a definir (não soma na mensalidade).
  const ADICIONAIS = [
    { id: 'prorrogacao', nome: 'Prorrogação', preco: 0, desc: 'Happy hour que ganha minutos a cada chopp: o garçom lê o QR e o relógio no telão aumenta.' },
  ];
  const adicionais = (ad = {}) => ADICIONAIS.filter((a) => ad[a.id]).reduce((t, a) => t + a.preco, 0);
  // Conferência automática da nota na SEFAZ (fidelidade): o restaurante liga se quiser e paga por nota conferida.
  const SEFAZ_NOTA = 0.25;
  // Implantação por faixa de mesas (a mesma tabela de public.implantacao_faixa no banco).
  const IMPLANTACAO = [{ ate: 20, valor: 590, nome: 'até 20 mesas' }, { ate: 50, valor: 890, nome: '21 a 50 mesas' }, { ate: Infinity, valor: 1190, nome: '51 mesas ou mais' }];
  const faixa = (mesas) => IMPLANTACAO.find((f) => (+mesas || 0) <= f.ate);
  const implantacao = (mesas) => faixa(mesas).valor;
  // paga: a maior implantação já paga (0 quando o plano ainda não foi definido: não cobra).
  const taxaMesas = (paga, mesas, contrato) => (paga ? Math.max(0, implantacao(mesas) - paga) * (+contrato === 12 ? 0.5 : 1) : 0);

  function combo(sv = {}) {
    const escolhidos = SERVICOS.filter((s) => sv[s.id]);
    const soma = escolhidos.reduce((t, s) => t + s.preco, 0);
    let total = soma;
    if (escolhidos.length === SERVICOS.length) total = TODOS;
    else if (DESCONTO[escolhidos.length]) {
      // Preço com desconto, terminado em 9 (ex.: 106,20 → 109).
      const x = soma * (1 - DESCONTO[escolhidos.length]);
      total = Math.min(soma, Math.floor(x / 10) * 10 + 9);
    }
    return { soma, total, economia: soma - total, qtd: escolhidos.length, desconto: DESCONTO[escolhidos.length] || (escolhidos.length === SERVICOS.length ? 1 - TODOS / soma : 0) };
  }
  const servicos = (sv) => combo(sv).total;
  const plano = (p) => servicos((p && p.servicos) || {}) + (p && ['proprio', 'registro'].includes(p.dominio) ? DOMINIO_MES : 0) + adicionais((p && p.adicionais) || {});

  window.Precos = { SERVICOS, ADICIONAIS, adicionais, DESCONTO, TODOS, DOMINIO_MES, SEFAZ_NOTA, IMPLANTACAO, faixa, implantacao, taxaMesas, combo, servicos, plano };
})();
