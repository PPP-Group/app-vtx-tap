/*
 * Campos de número com setas no padrão do sistema.
 * Esconde as setas do navegador e coloca duas setas próprias dentro do campo.
 * Funciona sozinho: observa a página e ajusta também os campos que aparecem depois.
 */
(function () {
  const SETA_CIMA = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 15 6-6 6 6"/></svg>';
  const SETA_BAIXO = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"/></svg>';
  const MIN_LARGURA = 80; // campos mais estreitos ficam sem setas (só digitar)

  function larguraPx(input) {
    const r = input.getBoundingClientRect();
    if (r.width) return { px: r.width, cheio: input.parentElement && Math.abs(r.width - conteudo(input.parentElement)) < 2 };
    // Campo ainda escondido: usa o valor do CSS.
    const w = getComputedStyle(input).width;
    if (w.endsWith('px')) return { px: parseFloat(w), cheio: false };
    return { px: Infinity, cheio: true };
  }
  function conteudo(el) {
    const cs = getComputedStyle(el);
    return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  }

  function passo(input, dir) {
    if (input.disabled || input.readOnly) return;
    const antes = input.value;
    if (input.value === '') {
      input.value = input.min !== '' ? input.min : '0';
    } else {
      try { dir > 0 ? input.stepUp() : input.stepDown(); } catch { return; }
    }
    if (input.value === antes) return;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function preparar(input) {
    input.dataset.num = '1';
    if (input.closest('.plano-stepper, [data-sem-setas]')) return;
    const { px, cheio } = larguraPx(input);
    if (px < MIN_LARGURA) return;

    const caixa = document.createElement('span');
    caixa.className = 'num' + (cheio ? ' num--cheio' : '');
    input.before(caixa);
    caixa.append(input);
    const setas = document.createElement('span');
    setas.className = 'num-setas';
    setas.innerHTML = `<button type="button" tabindex="-1" data-dir="1" aria-label="Aumentar">${SETA_CIMA}</button>`
      + `<button type="button" tabindex="-1" data-dir="-1" aria-label="Diminuir">${SETA_BAIXO}</button>`;
    caixa.append(setas);

    // Segurar a seta repete, como no campo do navegador.
    let espera = 0;
    let repete = 0;
    const parar = () => { clearTimeout(espera); clearInterval(repete); };
    setas.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('button');
      if (!b || e.button !== 0) return;
      e.preventDefault();
      const dir = +b.dataset.dir;
      passo(input, dir);
      espera = setTimeout(() => { repete = setInterval(() => passo(input, dir), 70); }, 420);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => setas.addEventListener(t, parar));
    // Teclado e leitores de tela: clique comum também funciona.
    setas.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b && e.detail === 0) passo(input, +b.dataset.dir);
    });
  }

  let agendado = false;
  function varrer() {
    agendado = false;
    document.querySelectorAll('input[type="number"]:not([data-num])').forEach(preparar);
  }
  function agendar() {
    if (agendado) return;
    agendado = true;
    queueMicrotask(varrer);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', varrer);
  else varrer();
  new MutationObserver(agendar).observe(document.documentElement, { childList: true, subtree: true });
})();
