/*
 * Cardápio por planilha: modelo para baixar e importação (.xlsx, .xls ou .csv).
 * O leitor de planilhas (SheetJS) só é baixado quando a pessoa usa.
 *
 *   Planilha.baixarModelo()      → baixa "modelo-cardapio.xlsx"
 *   Planilha.ler(arquivo, tags)  → { categorias: [{ nome, itens: [...] }], erros: [texto], total }
 */
(function () {
  const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  const COLUNAS = ['Categoria', 'Nome', 'Descrição', 'Preço', 'Delivery', 'Destaque', 'Selos'];
  const INSTRUCOES = [
    ['Coluna', 'O que colocar', 'Exemplo'],
    ['Categoria', 'Grupo do cardápio. Itens com a mesma categoria ficam juntos.', 'Entradas'],
    ['Nome', 'Nome do prato ou bebida (obrigatório, até 60 letras).', 'Mandioca na brasa'],
    ['Descrição', 'Opcional. Ingredientes, porção, acompanhamentos (até 160 letras).', 'Aioli de alho assado e salsinha'],
    ['Preço', 'Em reais (obrigatório). Pode usar vírgula.', '34,90'],
    ['Delivery', '"sim" se o item também vende no delivery. Vazio = não.', 'sim'],
    ['Destaque', '"sim" para mostrar o selo "Da casa". Vazio = não.', 'não'],
    ['Selos', 'Opcional, separados por vírgula: vegetariano, vegano, sem glúten, picante, sem álcool.', 'vegetariano, sem glúten'],
  ];

  let lib = null;
  function xlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (!lib) {
      lib = new Promise((ok, fail) => {
        const s = document.createElement('script');
        s.src = XLSX_URL;
        s.onload = () => ok(window.XLSX);
        s.onerror = () => {
          lib = null;
          fail(new Error('Não foi possível carregar o leitor de planilhas. Confira a internet.'));
        };
        document.head.appendChild(s);
      });
    }
    return lib;
  }

  async function baixarModelo() {
    const X = await xlsx();
    const wb = X.utils.book_new();
    const cardapio = X.utils.aoa_to_sheet([COLUNAS]);
    cardapio['!cols'] = [{ wch: 18 }, { wch: 32 }, { wch: 48 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 28 }];
    X.utils.book_append_sheet(wb, cardapio, 'Cardápio');
    const ajuda = X.utils.aoa_to_sheet(INSTRUCOES);
    ajuda['!cols'] = [{ wch: 12 }, { wch: 80 }, { wch: 30 }];
    X.utils.book_append_sheet(wb, ajuda, 'Como preencher');
    X.writeFile(wb, 'modelo-cardapio.xlsx');
  }

  /* ---------- Leitura ---------- */
  const semAcento = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const sim = (v) => /^(s|sim|x|yes|y|1|true|verdadeiro|✓|✔)$/.test(semAcento(v));
  function preco(v) {
    if (typeof v === 'number') return Math.round(v * 100) / 100;
    const s = String(v || '').replace(/[^\d,.]/g, '');
    if (!s) return NaN;
    const n = parseFloat(/,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, ''));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
  }
  // Acha as colunas pelo nome (aceita variações: "preco", "Valor", "descricao"...).
  const APELIDOS = {
    categoria: ['categoria', 'grupo', 'secao', 'seção'],
    nome: ['nome', 'produto', 'item', 'prato'],
    desc: ['descricao', 'descrição', 'detalhes', 'ingredientes'],
    preco: ['preco', 'preço', 'valor', 'preco (r$)', 'valor (r$)'],
    delivery: ['delivery', 'entrega', 'no delivery'],
    destaque: ['destaque', 'da casa'],
    selos: ['selos', 'tags', 'selo'],
  };
  function mapaColunas(cab) {
    const m = {};
    cab.forEach((c, i) => {
      const n = semAcento(c);
      for (const [k, nomes] of Object.entries(APELIDOS)) if (m[k] == null && nomes.map(semAcento).includes(n)) m[k] = i;
    });
    return m;
  }

  async function ler(arquivo, tags = {}) {
    const X = await xlsx();
    const buf = await arquivo.arrayBuffer();
    // CSV: decodifica o texto aqui (UTF-8, com ou sem BOM; senão o formato antigo do Excel) e lê as células
    // como texto (raw), senão "18,90" vira 1890. No .xlsx os números já vêm certos.
    const csv = /\.(csv|txt)$/i.test(arquivo.name || '') || /csv|text\/plain/.test(arquivo.type || '');
    let wb;
    if (csv) {
      let txt = new TextDecoder('utf-8').decode(buf);
      if (txt.includes('\uFFFD')) txt = new TextDecoder('windows-1252').decode(buf);
      wb = X.read(txt.replace(/^\uFEFF/, ''), { type: 'string', raw: true });
    } else {
      wb = X.read(buf, { type: 'array' });
    }
    const aba = wb.SheetNames.find((n) => !/como preencher|instru/i.test(n)) || wb.SheetNames[0];
    const linhas = X.utils.sheet_to_json(wb.Sheets[aba], { header: 1, raw: true, defval: '' });
    const iCab = linhas.findIndex((l) => l.some((c) => semAcento(c) === 'nome'));
    if (iCab < 0) throw new Error('Não achamos a coluna "Nome". Use o modelo da planilha.');
    const col = mapaColunas(linhas[iCab]);
    if (col.preco == null) throw new Error('Não achamos a coluna "Preço". Use o modelo da planilha.');
    const selosPorNome = Object.fromEntries(Object.entries(tags).flatMap(([k, l]) => [[semAcento(k), k], [semAcento(l), k]]));
    const erros = [];
    const cats = new Map();
    let total = 0;
    linhas.slice(iCab + 1).forEach((l, i) => {
      const n = iCab + i + 2; // número da linha como aparece no Excel
      const pega = (k) => (col[k] == null ? '' : l[col[k]]);
      const nome = String(pega('nome') || '').trim().slice(0, 60);
      if (!nome && l.every((c) => String(c).trim() === '')) return;
      if (!nome) return erros.push(`Linha ${n}: falta o nome.`);
      const p = preco(pega('preco'));
      if (!(p >= 0) || p > 100000) return erros.push(`Linha ${n} (${nome}): preço inválido.`);
      const categoria = String(pega('categoria') || '').trim().slice(0, 40) || 'Cardápio';
      const selos = String(pega('selos') || '').split(/[,;/]/).map((t) => selosPorNome[semAcento(t)]).filter(Boolean);
      const item = {
        nome,
        desc: String(pega('desc') || '').trim().slice(0, 160),
        preco: p,
        tags: [...new Set(selos)],
        destaque: sim(pega('destaque')),
        delivery: sim(pega('delivery')),
      };
      if (!cats.has(categoria)) cats.set(categoria, []);
      cats.get(categoria).push(item);
      total++;
    });
    return { categorias: [...cats].map(([nome, itens]) => ({ nome, itens })), erros, total };
  }

  window.Planilha = { baixarModelo, ler, COLUNAS };
})();
