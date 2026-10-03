// Avisos do pedido do delivery (Web Push).
//
//   POST { acao: 'chave' }                       → { chave } — chave pública VAPID para o navegador inscrever.
//                                                   Na primeira vez, gera o par e guarda em private.push_config.
//   POST { acao: 'enviar', pedido } + x-segredo  → manda o aviso da situação atual do pedido para os aparelhos
//                                                   inscritos. Chamado pelo gatilho pedidos_avisar (pg_net).
//
// Sem segredos para configurar: o segredo do gatilho e as chaves VAPID ficam no banco (schema private),
// lidos só pela service role.
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const URL_ = Deno.env.get('SUPABASE_URL')!;
// Chave secreta nova (sb_secret_..., no secret VTX_SECRET_KEY) ou, até a troca, a service_role antiga.
const SERVICE = Deno.env.get('VTX_SECRET_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CONTATO = 'mailto:contato@vortexsystems.tech';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sb = createClient(URL_, SERVICE, { auth: { persistSession: false } });

async function chaves(): Promise<{ publica: string; privada: string }> {
  const { data, error } = await sb.rpc('push_chaves');
  if (error) throw error;
  if (data && data.publica) return data;
  const novas = webpush.generateVAPIDKeys();
  // Se duas chamadas gerarem juntas, fica a primeira que gravou (push_chaves não sobrescreve).
  const { data: d2, error: e2 } = await sb.rpc('push_chaves', { p_publica: novas.publicKey, p_privada: novas.privateKey });
  if (e2) throw e2;
  return d2;
}

// Texto do aviso para cada situação.
function aviso(p: { numero: number; situacao: string; entregador?: string | null; motivo?: string | null; restaurante?: string | null }) {
  const n = `Pedido #${p.numero}`;
  switch (p.situacao) {
    case 'preparo': return { title: `${n} em preparo`, body: 'A cozinha começou a preparar o seu pedido.' };
    case 'saiu': return { title: `${n} saiu para entrega`, body: p.entregador ? `${p.entregador} está a caminho.` : 'O entregador está a caminho.' };
    case 'entregue': return { title: `${n} entregue`, body: `Bom apetite! Obrigado por pedir${p.restaurante ? ` no ${p.restaurante}` : ''}.` };
    case 'cancelado': return { title: `${n} cancelado`, body: p.motivo || 'Fale com o restaurante para saber mais.' };
    case 'recebido': return { title: `${n} recebido`, body: 'O restaurante já viu o seu pedido.' };
    default: return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ status: 'erro' }, 405);
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ status: 'erro', mensagem: 'Pedido inválido.' }, 400);
  }
  try {
    if (body.acao === 'chave') return json({ status: 'ok', chave: (await chaves()).publica });

    if (body.acao === 'enviar') {
      const id = String(body.pedido || '');
      if (!UUID.test(id)) return json({ status: 'erro' }, 400);
      const { data: p, error } = await sb.rpc('push_pedido', { p_id: id, p_segredo: req.headers.get('x-segredo') || '' });
      if (error) throw error;
      if (!p || p.status !== 'ok') return json({ status: 'negado' }, 403);
      const msg = aviso(p);
      if (!msg || !p.inscricoes || !p.inscricoes.length) return json({ status: 'ok', enviados: 0 });
      const k = p.vapid_publica ? { publica: p.vapid_publica, privada: p.vapid_privada } : await chaves();
      webpush.setVapidDetails(CONTATO, k.publica, k.privada);
      let enviados = 0;
      await Promise.all(p.inscricoes.map(async (s: { endpoint: string; keys: { p256dh: string; auth: string }; url: string }) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys },
            JSON.stringify({ ...msg, url: s.url, tag: `pedido-${p.numero}` }), { TTL: 3600, urgency: 'high' });
          enviados++;
        } catch (e) {
          const st = (e as { statusCode?: number }).statusCode;
          // Inscrição vencida ou removida pelo aparelho: apaga.
          if (st === 404 || st === 410) await sb.rpc('push_remover', { p_endpoint: s.endpoint });
          else console.error('push', st, (e as Error).message);
        }
      }));
      return json({ status: 'ok', enviados });
    }
    return json({ status: 'erro', mensagem: 'Ação desconhecida.' }, 400);
  } catch (e) {
    console.error(e);
    return json({ status: 'erro' }, 500);
  }
});
