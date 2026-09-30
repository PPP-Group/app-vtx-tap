// Conferência automática da NFC-e na SEFAZ-MG, pela API da Infosimples (consulta paga, por nota).
// O cliente lê o QR; aqui a nota é conferida no site oficial: valor pago, CPF do consumidor,
// data e os produtos. Com tudo certo, os pontos entram na hora e os produtos ficam guardados
// para os rankings de mais pedidos.
//
// Só consulta se o restaurante ligou a conferência (cobrada por nota na mensalidade) e a nota é do
// CNPJ do restaurante, no prazo, de cliente cadastrado e ainda não usada (public.fid_sefaz_preparar).
// Sem teto mensal: a conferência não para no meio do mês. Desligada ou sem o token configurado, o
// navegador segue o fluxo antigo (valor lido da foto + equipe confere).
//
// Segredos (Supabase → Edge Functions → Secrets):
//   INFOSIMPLES_TOKEN        token da conta Infosimples (obrigatório para funcionar)
//   INFOSIMPLES_SERVICO      opcional, padrão "sefaz/mg/nfce-resumida"
//   NFCE_LIMITE_MES          opcional, só para emergência: teto de consultas por restaurante por mês (padrão: sem teto)
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TOKEN = Deno.env.get('INFOSIMPLES_TOKEN') || '';
const SERVICO = Deno.env.get('INFOSIMPLES_SERVICO') || 'sefaz/mg/nfce-resumida';
const LIMITE = Number(Deno.env.get('NFCE_LIMITE_MES') || 0);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digitos = (s: unknown) => String(s ?? '').replace(/\D/g, '');

// Número em qualquer formato que a API devolve: 87.5, "87,50", "R$ 1.234,56".
function numero(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').replace(/[^\d,.-]/g, '');
  if (!s) return null;
  // O último separador é o decimal: "1.234,56" → 1234.56, "2,0000" → 2, "87.50" → 87.5.
  const dec = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  const n = dec < 0 ? parseFloat(s) : parseFloat(s.slice(0, dec).replace(/[.,]/g, '') + '.' + s.slice(dec + 1));
  return Number.isFinite(n) ? n : null;
}

// Procura o primeiro campo com um destes nomes em qualquer nível da resposta
// (sem entrar em listas, para não pegar o valor de um produto no lugar do total).
function acha(obj: unknown, nomes: string[]): unknown {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  for (const n of nomes) if (n in (obj as Record<string, unknown>)) return (obj as Record<string, unknown>)[n];
  for (const v of Object.values(obj as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const r = acha(v, nomes);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

// CPF da nota pode vir mascarado ("***.982.247-**"): compara só os números que aparecem.
// 'sem' = nota sem CPF; 'oculto' = mascarado demais para conferir (a equipe confere).
function conferirCpf(daNota: string, doCliente: string): 'ok' | 'outro' | 'sem' | 'oculto' {
  const m = String(daNota || '').replace(/[^\d*]/g, '');
  if (!m) return 'sem';
  if (m.length !== 11 || m.replace(/\*/g, '').length < 4) return 'oculto';
  for (let i = 0; i < 11; i++) if (m[i] !== '*' && m[i] !== doCliente[i]) return 'outro';
  return 'ok';
}

// Data da emissão em ISO: aceita ISO ou "29/09/2026 20:15:00" (horário de Brasília).
function dataIso(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s))) return s;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}T${m[4] || '12'}:${m[5] || '00'}:${m[6] || '00'}-03:00`;
}

type Nota = { valor: number | null; cpf: string; cnpj: string; emitida: string | null; itens: { descricao: string; quantidade: number; unidade: string; valor: number | null }[] };

function lerResposta(d: Record<string, unknown>): Nota {
  const produtos = (d.produtos_servicos ?? d.produtos ?? d.itens ?? []) as Record<string, unknown>[];
  const itens = (Array.isArray(produtos) ? produtos : []).map((p) => ({
    descricao: String(p.descricao ?? p.nome ?? '').trim(),
    quantidade: numero(p.normalizado_quantidade ?? p.quantidade) ?? 1,
    unidade: String(p.unidade_comercial ?? p.unidade ?? '').trim(),
    valor: numero(p.normalizado_valor ?? p.valor),
  })).filter((i) => i.descricao);
  // Total pago: valor a pagar / total da nota; sem ele, a soma dos produtos.
  let valor = numero(acha(d, ['normalizado_valor_a_pagar', 'valor_a_pagar', 'normalizado_valor_total_nota', 'valor_total_nota',
    'normalizado_valor_total', 'valor_total', 'normalizado_valor_total_servico', 'valor_total_servico']));
  if (!valor || valor <= 0) valor = itens.reduce((t, i) => t + (i.valor || 0), 0) || null;
  const dest = (acha(d, ['destinatario', 'consumidor']) as Record<string, unknown>) || {};
  const emit = (acha(d, ['emitente']) as Record<string, unknown>) || {};
  return {
    valor: valor ? Math.round(valor * 100) / 100 : null,
    cpf: String(dest.normalizado_cpf ?? dest.cpf ?? ''),
    cnpj: digitos(emit.normalizado_cnpj ?? emit.cnpj),
    emitida: dataIso(acha(d, ['normalizado_datahora_emissao', 'data_emissao'])),
    itens,
  };
}

async function consultar(chave: string): Promise<{ ok: true; nota: Nota } | { ok: false; motivo: string }> {
  const corpo = new URLSearchParams({ token: TOKEN, nfce: chave, timeout: '60' });
  let r: Response;
  try {
    r = await fetch(`https://api.infosimples.com/api/v2/consultas/${SERVICO}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: corpo,
      signal: AbortSignal.timeout(70000),
    });
  } catch {
    return { ok: false, motivo: 'sem_resposta' };
  }
  const j = await r.json().catch(() => null) as Record<string, unknown> | null;
  if (!j) return { ok: false, motivo: 'sem_resposta' };
  if (j.code !== 200 || !Array.isArray(j.data) || !j.data.length) {
    console.warn('infosimples', j.code, j.code_message);
    return { ok: false, motivo: String(j.code_message || j.code || 'erro') };
  }
  return { ok: true, nota: lerResposta(j.data[0] as Record<string, unknown>) };
}

const admin = () => createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

async function rpc<T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ status: 'erro', mensagem: 'Método não permitido.' }, 405);
  if (!TOKEN) return json({ status: 'indisponivel' });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ status: 'erro', mensagem: 'Pedido inválido.' }, 400);
  }
  const rest = String(body.restaurante || '');
  const cpf = digitos(body.cpf);
  const qr = String(body.qr || '').slice(0, 1000);
  if (!UUID.test(rest)) return json({ status: 'erro', mensagem: 'Restaurante não identificado.' }, 400);

  const sb = admin();
  try {
    const prep = await rpc<Record<string, unknown>>(sb, 'fid_sefaz_preparar', { p_restaurante: rest, p_cpf: cpf, p_qr: qr, p_limite: LIMITE });
    if (prep.status !== 'ok') return json(prep);
    const chave = String(prep.chave);

    const c = await consultar(chave);
    // SEFAZ fora do ar, nota ainda não disponível etc.: o navegador segue pelo fluxo com a equipe.
    if (!c.ok) return json({ status: 'falhou', motivo: c.motivo });
    const n = c.nota;

    if (n.cnpj && n.cnpj !== chave.slice(6, 20)) return json({ status: 'falhou', motivo: 'cnpj_diferente' });
    const cpfOk = conferirCpf(n.cpf, cpf);
    if (cpfOk === 'oculto') return json({ status: 'falhou', motivo: 'cpf_oculto' });
    if (cpfOk === 'outro') {
      return json(await rpc(sb, 'fid_sefaz_recusar', { p_restaurante: rest, p_cpf: cpf, p_chave: chave, p_url: prep.url ?? null,
        p_motivo: 'A nota tem outro CPF. Para ganhar pontos, peça CPF na nota com o CPF do seu cadastro.' }));
    }
    if (cpfOk === 'sem') {
      return json(await rpc(sb, 'fid_sefaz_recusar', { p_restaurante: rest, p_cpf: cpf, p_chave: chave, p_url: prep.url ?? null,
        p_motivo: 'Nota sem CPF. Para ganhar pontos, peça CPF na nota na próxima compra.' }));
    }
    if (!n.valor) return json({ status: 'falhou', motivo: 'sem_valor' });

    const r = await rpc<Record<string, unknown>>(sb, 'fid_sefaz_registrar', {
      p_restaurante: rest, p_cpf: cpf, p_chave: chave, p_url: prep.url ?? null,
      p_valor: n.valor, p_emitida: n.emitida, p_itens: n.itens,
    });
    return json({ ...r, itens: n.itens.length });
  } catch (e) {
    console.error('nfce', e);
    return json({ status: 'falhou', motivo: 'erro_interno' });
  }
});
