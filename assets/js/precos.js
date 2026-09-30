/*
 * Tabela de preços da VTX Tap — a mesma de public.plano_preco no banco.
 * Usada pelo painel, pela central e pela página de preços.
 *
 *   Precos.SERVICOS                  → [{ id, nome, preco, desc }]
 *   Precos.servicos({ pagina, ... }) → mensalidade dos serviços (com desconto de combo)
 *   Precos.plano(plano)              → mensalidade do plano (serviços + domínio próprio)
 *   Precos.combo({ ... })            → { soma, total, economia, desconto } para mostrar o desconto
 */
(function () {
  const SERVICOS = [
    { id: 'pagina', nome: 'Página da mesa e cardápio', preco: 49, desc: 'Cardápio, Wi-Fi, avaliação no Google, comentários e informações do restaurante.' },
    { id: 'garcom', nome: 'Chamar o garçom', preco: 69, desc: 'O sino na página da mesa e as abas Chamados e Salão do painel.' },
    { id: 'fidelidade', nome: 'Programa de fidelidade', preco: 199, desc: 'Pontos pela nota fiscal, prêmios, níveis, indicação e ranking.' },
    { id: 'delivery', nome: 'Delivery', preco: 149, desc: 'Pedidos para entrega com taxa por distância, cozinha e acompanhamento do pedido.' },
  ];
  // Desconto por quantidade de serviços; os quatro juntos têm preço fechado.
  const DESCONTO = { 2: 0.1, 3: 0.15 };
  const TODOS = 399;
  const DOMINIO_MES = 19;

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
  const plano = (p) => servicos((p && p.servicos) || {}) + (p && ['proprio', 'registro'].includes(p.dominio) ? DOMINIO_MES : 0);

  window.Precos = { SERVICOS, DESCONTO, TODOS, DOMINIO_MES, combo, servicos, plano };
})();
