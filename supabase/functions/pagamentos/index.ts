// Mensalidade do VTX Tap pelo Asaas (asaas.com): cartão recorrente ou Pix/boleto todo mês.
// O cartão é digitado na página de pagamento do próprio Asaas (invoiceUrl) e fica guardado lá:
// o VTX Tap nunca vê o número do cartão. Depois do primeiro pagamento, o Asaas cobra sozinho todo mês.
//
//   POST { acao: 'ativar', restaurante, forma: 'cartao'|'pix', nome, documento, email, telefone? }
//        → administrador do restaurante (ou operador da central). Cria o cliente e a assinatura no Asaas
//          e devolve a página da primeira cobrança (url).
//   POST { acao: 'pagar', restaurante }             → url da cobrança em aberto (pagar ou trocar o cartão).
//   POST { acao: 'forma', restaurante, forma }      → troca cartão ↔ Pix/boleto (vale também para as cobranças em aberto).
//   POST { acao: 'cancelar', restaurante }          → só operador da central.
//   POST { acao: 'sincronizar', restaurante, taxa } + x-segredo → chamado pelo banco quando o plano muda:
//          ajusta o valor da assinatura e lança a taxa única das mesas a mais.
//   POST ?webhook (header asaas-access-token)        → eventos de cobrança do Asaas.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   ASAAS_API_KEY        chave da API (Asaas → Integrações → Chave de API).
//   ASAAS_URL            https://api-sandbox.asaas.com/v3 (testes) ou https://api.asaas.com/v3 (produção).
//   ASAAS_WEBHOOK_TOKEN  o mesmo "token de autenticação" cadastrado no webhook do Asaas.
// Publicar sem verificação de JWT (o Asaas não manda JWT): a função confere tudo sozinha.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('VTX_SECRET_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const API = (Deno.env.get('ASAAS_URL') || 'https://api-sandbox.asaas.com/v3').replace(/\/$/, '');
const CHAVE = Deno.env.get('ASAAS_API_KEY') || '';
const WEBHOOK = Deno.env.get('ASAAS_WEBHOOK_TOKEN') || '';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const erro = (msg: string, status = 400) => json({ erro: msg }, status);

const sb = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const BILLING = { cartao: 'CREDIT_CARD', pix: 'UNDEFINED' } as const; // UNDEFINED: o cliente escolhe Pix ou boleto
type Forma = keyof typeof BILLING;

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

class AsaasErro extends Error {}
async function asaas<T = Record<string, unknown>>(metodo: string, caminho: string, corpo?: unknown): Promise<T> {
  const r = await fetch(API + caminho, {
    method: metodo,
    headers: { access_token: CHAVE, 'Content-Type': 'application/json', 'User-Agent': 'vtx-tap' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (d?.errors || []).map((e: { description: string }) => e.description).join(' ') || `Asaas HTTP ${r.status}`;
    throw new AsaasErro(msg);
  }
  return d as T;
}

const hoje = (dias = 0) => {
  const d = new Date(Date.now() - 3 * 3600e3 + dias * 86400e3); // horário de Brasília
  return d.toISOString().slice(0, 10);
};

// Quem chamou: administrador deste restaurante ou operador da central.
async function quem(req: Request, restaurante: string) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data } = await sb.auth.getUser(token);
  if (!data.user) return null;
  const { data: op } = await sb.from('operadores').select('user_id').eq('user_id', data.user.id).maybeSingle();
  if (op) return 'operador';
  const { data: m } = await sb.from('equipe_membros').select('admin')
    .eq('user_id', data.user.id).eq('restaurante_id', restaurante).maybeSingle();
  return m?.admin ? 'admin' : null;
}

type Dados = {
  nome: string; slug: string; mensal: number;
  assinatura: null | { cliente_id: string; assinatura_id: string | null; forma: Forma; valor: number; status: string };
  pendente: null | { id: string; url: string | null };
};

// Puxa as cobranças da assinatura (a primeira nasce junto) e grava.
async function puxarFaturas(assinatura: string) {
  const r = await asaas<{ data: Record<string, unknown>[] }>('GET', `/subscriptions/${assinatura}/payments?limit=20`);
  for (const p of r.data || []) await rpc('pag_fatura_gravar', { p });
  return r.data || [];
}
const primeiraAberta = (lista: Record<string, unknown>[]) =>
  lista.filter((p) => p.status === 'PENDING' || p.status === 'OVERDUE')
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0];

async function ativar(restaurante: string, b: Record<string, unknown>) {
  const d = await rpc<Dados>('pag_dados', { p_restaurante: restaurante });
  if (!d) return erro('Restaurante não encontrado.', 404);
  if (d.assinatura?.status === 'ativa' && d.assinatura.assinatura_id) return erro('A cobrança já está ativa.');
  const forma = (b.forma === 'pix' ? 'pix' : 'cartao') as Forma;
  const nome = String(b.nome || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const documento = String(b.documento || '').replace(/\D/g, '');
  const email = String(b.email || '').trim().toLowerCase();
  const telefone = String(b.telefone || '').replace(/\D/g, '');
  if (nome.length < 3) return erro('Informe o nome ou a razão social.');
  if (!/^(\d{11}|\d{14})$/.test(documento)) return erro('CPF ou CNPJ inválido.');
  if (!EMAIL_OK.test(email) || email.length > 120) return erro('E-mail inválido.');
  if (!(d.mensal > 0)) return erro('O plano ainda não tem mensalidade. Fale com a VTX.');

  const cliente = d.assinatura?.cliente_id || (await asaas<{ id: string }>('POST', '/customers', {
    name: nome, cpfCnpj: documento, email, mobilePhone: telefone || undefined, externalReference: restaurante,
    notificationDisabled: false,
  })).id;
  // Grava o cliente antes da assinatura: se algo falhar no meio, a próxima tentativa reaproveita.
  await rpc('pag_assinatura_gravar', { p_restaurante: restaurante, p: { cliente_id: cliente, forma, valor: d.mensal, nome, documento, email, status: 'ativa' } });
  const sub = await asaas<{ id: string }>('POST', '/subscriptions', {
    customer: cliente, billingType: BILLING[forma], value: d.mensal, nextDueDate: hoje(1), cycle: 'MONTHLY',
    description: `VTX Tap · ${d.nome}`, externalReference: restaurante,
  });
  await rpc('pag_assinatura_gravar', { p_restaurante: restaurante, p: { assinatura_id: sub.id } });
  const aberta = primeiraAberta(await puxarFaturas(sub.id));
  return json({ status: 'ok', url: aberta?.invoiceUrl || null });
}

async function sincronizar(restaurante: string, taxa: number) {
  const d = await rpc<Dados>('pag_dados', { p_restaurante: restaurante });
  const a = d?.assinatura;
  if (!a?.assinatura_id || a.status !== 'ativa') return json({ status: 'sem_assinatura' });
  if (Math.abs(a.valor - d.mensal) >= 0.01 && d.mensal > 0) {
    await asaas('PUT', `/subscriptions/${a.assinatura_id}`, { value: d.mensal, updatePendingPayments: true });
    await rpc('pag_assinatura_gravar', { p_restaurante: restaurante, p: { valor: d.mensal } });
  }
  if (taxa > 0) {
    const p = await asaas<Record<string, unknown>>('POST', '/payments', {
      customer: a.cliente_id, billingType: BILLING[a.forma], value: taxa, dueDate: hoje(3),
      description: 'VTX Tap · taxa única pelas mesas a mais', externalReference: restaurante,
    });
    await rpc('pag_fatura_gravar', { p });
  }
  await puxarFaturas(a.assinatura_id);
  return json({ status: 'ok', mensal: d.mensal });
}

async function webhook(req: Request) {
  const token = req.headers.get('asaas-access-token') || '';
  if (!WEBHOOK || token.length !== WEBHOOK.length || !timingSafe(token, WEBHOOK)) return erro('Negado.', 401);
  const b = await req.json().catch(() => null) as { id?: string; event?: string; payment?: Record<string, unknown> } | null;
  if (!b?.event) return json({ status: 'ignorado' });
  if (b.payment && String(b.event).startsWith('PAYMENT_')) {
    // Evento repetido (o Asaas reenvia se não recebe 200): grava de novo, que é idempotente, mas só avisa uma vez.
    if (b.id) await rpc('pag_evento_novo', { p_id: b.id, p_evento: b.event });
    if (b.event === 'PAYMENT_DELETED') b.payment.status = 'DELETED';
    await rpc('pag_fatura_gravar', { p: b.payment });
  }
  return json({ status: 'ok' });
}
function timingSafe(a: string, b: string) {
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return erro('Método não permitido.', 405);
  try {
    if (new URL(req.url).searchParams.has('webhook')) return await webhook(req);
    if (!CHAVE) return erro('Pagamentos ainda não configurados. Fale com a VTX.', 503);
    const b = await req.json().catch(() => ({})) as Record<string, unknown>;
    const restaurante = String(b.restaurante || '');
    if (!UUID.test(restaurante)) return erro('Restaurante inválido.');

    if (b.acao === 'sincronizar') {
      if (!(await rpc<boolean>('pag_segredo_ok', { p_segredo: req.headers.get('x-segredo') || '' }))) return erro('Negado.', 403);
      return await sincronizar(restaurante, Math.max(0, Number(b.taxa) || 0));
    }

    const papel = await quem(req, restaurante);
    if (!papel) return erro('Só o administrador do restaurante cuida do pagamento.', 403);
    if (b.acao === 'ativar') return await ativar(restaurante, b);

    const d = await rpc<Dados>('pag_dados', { p_restaurante: restaurante });
    const a = d?.assinatura;
    if (!a?.assinatura_id || a.status !== 'ativa') return erro('A cobrança ainda não foi ativada.');

    if (b.acao === 'pagar') {
      const aberta = primeiraAberta(await puxarFaturas(a.assinatura_id));
      return json({ status: 'ok', url: aberta?.invoiceUrl || null });
    }
    if (b.acao === 'forma') {
      const forma = (b.forma === 'pix' ? 'pix' : 'cartao') as Forma;
      await asaas('PUT', `/subscriptions/${a.assinatura_id}`, { billingType: BILLING[forma], updatePendingPayments: true });
      await rpc('pag_assinatura_gravar', { p_restaurante: restaurante, p: { forma, ...(forma === 'pix' ? { cartao: null } : {}) } });
      const aberta = primeiraAberta(await puxarFaturas(a.assinatura_id));
      return json({ status: 'ok', url: aberta?.invoiceUrl || null });
    }
    if (b.acao === 'cancelar') {
      if (papel !== 'operador') return erro('Só a VTX cancela a assinatura.', 403);
      await asaas('DELETE', `/subscriptions/${a.assinatura_id}`);
      await rpc('pag_assinatura_gravar', { p_restaurante: restaurante, p: { status: 'cancelada' } });
      return json({ status: 'ok' });
    }
    return erro('Ação desconhecida.');
  } catch (e) {
    if (e instanceof AsaasErro) return erro(e.message, 422);
    console.error(e);
    return erro('Não foi possível falar com o sistema de pagamento. Tente de novo em instantes.', 500);
  }
});
