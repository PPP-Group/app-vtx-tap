// Envio dos e-mails da fila (private.avisos_fila) pelo Resend.
//
//   POST { acao: 'enviar' } + x-segredo  → manda o lote pendente. Chamado pelo banco (pg_net) logo depois de
//                                          enfileirar e pelo cron "avisos-reenviar" a cada 5 minutos.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   RESEND_API_KEY   chave do Resend (resend.com). Sem ela, os e-mails ficam na fila e nada quebra.
//   AVISOS_DE        remetente, ex.: "VTX Tap <avisos@vortexsystems.tech>" (domínio verificado no Resend).
import { createClient } from 'npm:@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('VTX_SECRET_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND = Deno.env.get('RESEND_API_KEY') || '';
const DE = Deno.env.get('AVISOS_DE') || 'VTX Tap <avisos@vortexsystems.tech>';

const sb = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Aviso = { id: string; para: string; assunto: string; html: string };

async function enviar(a: Aviso): Promise<string | null> {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: DE, to: [a.para], subject: a.assunto, html: a.html }),
  });
  if (r.ok) return null;
  return `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ erro: 'Método não permitido.' }, 405);
  const segredo = req.headers.get('x-segredo') || '';
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* vazio */ }
  if (body.acao !== 'enviar') return json({ erro: 'Ação desconhecida.' }, 400);
  if (!RESEND) return json({ status: 'sem_chave' });
  const { data, error } = await sb.rpc('avisos_lote', { p_segredo: segredo });
  if (error) return json({ erro: error.message }, 500);
  if (data.status !== 'ok') return json({ erro: 'Negado.' }, 403);
  let ok = 0;
  for (const a of data.avisos as Aviso[]) {
    let falha: string | null;
    try { falha = await enviar(a); } catch (e) { falha = String(e).slice(0, 200); }
    await sb.rpc('avisos_marcar', { p_segredo: segredo, p_id: a.id, p_ok: !falha, p_erro: falha });
    if (!falha) ok++;
  }
  return json({ status: 'ok', enviados: ok, total: (data.avisos as Aviso[]).length });
});
