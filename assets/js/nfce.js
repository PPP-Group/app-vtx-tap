/*
 * Lê no navegador os XML das NFC-e (e o ZIP que o sistema do caixa exporta)
 * para a conferência do programa de fidelidade. Devolve só o que o programa
 * usa: chave de acesso, CPF do consumidor, valor total, data/hora da emissão,
 * os produtos (para os mais pedidos) e se a nota foi cancelada. Aceita NFC-e (modelo 65), CF-e SAT e os eventos de
 * cancelamento; ignora o resto.
 *
 *   Nfce.lerArquivos(files) → { notas: [{ chave, cpf, valor, emitida_em, itens } | { chave, cancelada }], resumo }
 */
(function () {
  const FFLATE = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js';
  let ff = null;
  const carregarZip = () =>
    ff ||
    (ff = new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = FFLATE;
      s.onload = () => ok(window.fflate);
      s.onerror = () => {
        ff = null;
        fail(new Error('Não foi possível abrir o ZIP. Confira a internet ou envie os XML soltos.'));
      };
      document.head.appendChild(s);
    }));

  const tag = (el, nome) => (el ? el.getElementsByTagName(nome)[0] || null : null);
  const txt = (el, nome) => {
    const e = tag(el, nome);
    return e ? e.textContent.trim() : '';
  };
  const digitos = (s) => String(s || '').replace(/\D/g, '');

  // Produtos da nota (det/prod): descrição, quantidade, unidade e valor.
  const itensDe = (inf) =>
    [...inf.getElementsByTagName('det')].slice(0, 300).map((d) => {
      const p = tag(d, 'prod');
      return { descricao: txt(p, 'xProd'), quantidade: parseFloat(txt(p, 'qCom')) || 1, unidade: txt(p, 'uCom'), valor: parseFloat(txt(p, 'vProd')) || null };
    }).filter((i) => i.descricao);

  function lerXml(texto) {
    const doc = new DOMParser().parseFromString(texto, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return { erro: true };

    // Evento de cancelamento da NF-e/NFC-e (tpEvento 110111).
    const ev = tag(doc, 'infEvento');
    if (ev && txt(ev, 'tpEvento')) {
      if (txt(ev, 'tpEvento') !== '110111') return { ignorado: true };
      const ret = tag(doc, 'retEvento');
      const cStat = ret ? txt(tag(ret, 'infEvento'), 'cStat') : '';
      if (cStat && !['135', '136', '155'].includes(cStat)) return { ignorado: true };
      return { chave: digitos(txt(ev, 'chNFe')), cancelada: true };
    }

    // CF-e SAT cancelado.
    const canc = tag(doc, 'CFeCanc');
    if (canc) {
      const inf = tag(canc, 'infCFe');
      return { chave: digitos(inf && inf.getAttribute('chCanc')), cancelada: true };
    }

    // NFC-e (com ou sem o protocolo de autorização junto).
    const inf = tag(doc, 'infNFe');
    if (inf) {
      const chave = digitos(inf.getAttribute('Id')) || digitos(txt(doc, 'chNFe'));
      const prot = tag(doc, 'infProt');
      const cStat = prot ? txt(prot, 'cStat') : '';
      if (prot && !['100', '150'].includes(cStat)) return { ignorado: true };
      const ide = tag(inf, 'ide');
      const dest = tag(inf, 'dest');
      return {
        chave,
        cpf: dest ? digitos(txt(dest, 'CPF')) : '',
        valor: parseFloat(txt(tag(inf, 'ICMSTot'), 'vNF')),
        emitida_em: txt(ide, 'dhEmi'),
        itens: itensDe(inf),
      };
    }

    // CF-e SAT (São Paulo e Ceará): data e hora sem fuso, horário de Brasília.
    const cfe = tag(doc, 'infCFe');
    if (cfe) {
      const ide = tag(cfe, 'ide');
      const d = txt(ide, 'dEmi');
      const h = txt(ide, 'hEmi').padEnd(6, '0');
      return {
        chave: digitos(cfe.getAttribute('Id')),
        cpf: digitos(txt(tag(cfe, 'dest'), 'CPF')),
        valor: parseFloat(txt(tag(cfe, 'total'), 'vCFe')),
        emitida_em: d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${h.slice(0, 2)}:${h.slice(2, 4)}:${h.slice(4, 6)}-03:00` : '',
        itens: itensDe(cfe),
      };
    }
    return { ignorado: true };
  }

  async function lerArquivos(arquivos) {
    const notas = new Map();
    const r = { arquivos: 0, lidos: 0, ignorados: 0, erros: 0 };
    const juntar = (texto) => {
      const x = lerXml(texto);
      if (x.erro) return r.erros++;
      if (x.ignorado) return r.ignorados++;
      if (!/^\d{44}$/.test(x.chave || '')) return r.erros++;
      r.lidos++;
      const atual = notas.get(x.chave) || { chave: x.chave };
      notas.set(x.chave, x.cancelada ? { ...atual, cancelada: true } : { ...atual, ...x, cancelada: !!atual.cancelada });
    };
    for (const f of arquivos) {
      r.arquivos++;
      const nome = String(f.name || '').toLowerCase();
      if (nome.endsWith('.zip')) {
        const { unzipSync, strFromU8 } = await carregarZip();
        const dentro = unzipSync(new Uint8Array(await f.arrayBuffer()), { filter: (a) => a.name.toLowerCase().endsWith('.xml') });
        Object.values(dentro).forEach((bytes) => juntar(strFromU8(bytes)));
      } else if (nome.endsWith('.xml') || /xml/.test(f.type || '')) {
        juntar(await f.text());
      } else {
        r.ignorados++;
      }
    }
    // Nota e cancelamento no mesmo lote: primeiro a nota, depois o cancelamento.
    const lista = [];
    let comCpf = 0;
    let canceladas = 0;
    for (const n of notas.values()) {
      if (Number.isFinite(n.valor) && n.emitida_em) {
        // Os produtos vão junto: alimentam o ranking de mais pedidos (fid_itens_salvar).
        lista.push({ chave: n.chave, cpf: n.cpf || null, valor: n.valor, emitida_em: n.emitida_em, itens: n.itens || [] });
        if (n.cpf && !n.cancelada) comCpf++;
      }
      if (n.cancelada) {
        lista.push({ chave: n.chave, cancelada: true });
        canceladas++;
      }
    }
    return { notas: lista, resumo: { ...r, notas: notas.size, comCpf, canceladas } };
  }

  window.Nfce = { lerArquivos, lerXml };
})();
