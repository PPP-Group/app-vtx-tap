// Domínio próprio do restaurante (ex.: cardapio.seurestaurante.com.br): mostra os registros DNS a criar
// e confere tudo sozinho.
//
//   POST { acao: 'verificar' }  (com o login da equipe)
//     → { dominio, status, mensagem, registros: [{ tipo, nome, valor, ok }], encontrado, ... }
//
// Passos (a situação fica em public.dominios):
//   'dns'          aguardando o registro DNS (CNAME para o endereço da VTX, ou A no domínio raiz);
//   'certificado'  DNS certo: o roteador de domínios põe a rota e o certificado HTTPS no Traefik;
//   'ativo'        o site abre pelo domínio, com HTTPS.
// O DNS é consultado por DNS-over-HTTPS (Cloudflare e Google), então não depende do DNS do servidor.
import { createClient } from 'npm:@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const semPonto = (s: string) => String(s || '').toLowerCase().replace(/\.$/, '');

// DNS-over-HTTPS: primeiro a Cloudflare, depois o Google.
type Resp = { Status: number; Answer?: { name: string; type: number; data: string }[]; Authority?: { name: string; type: number; data: string }[] };
async function doh(nome: string, tipo: string): Promise<Resp | null> {
  for (const base of ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve']) {
    try {
      const r = await fetch(`${base}?name=${encodeURIComponent(nome)}&type=${tipo}`, {
        headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000),
      });
      if (r.ok) return await r.json();
    } catch { /* tenta o próximo */ }
  }
  return null;
}
const respostas = (r: Resp | null, tipo: number) => (r?.Answer || []).filter((a) => a.type === tipo).map((a) => semPonto(a.data));

// Zona do domínio (onde o cliente cria o registro): a resposta SOA diz onde começa a zona.
const SUFIXOS = ['com.br', 'net.br', 'org.br', 'art.br', 'blog.br', 'eco.br', 'emp.br', 'eng.br', 'ind.br', 'inf.br', 'log.br', 'med.br',
  'rec.br', 'srv.br', 'tur.br', 'adv.br', 'arq.br', 'app.br', 'dev.br', 'tec.br', 'co.uk', 'com.pt', 'com.ar', 'com.mx', 'com.co'];
async function zonaDe(dominio: string): Promise<string> {
  const r = await doh(dominio, 'SOA');
  const soa = [...(r?.Answer || []), ...(r?.Authority || [])].find((a) => a.type === 6);
  if (soa && dominio.endsWith(semPonto(soa.name)) && semPonto(soa.name).includes('.')) return semPonto(soa.name);
  const p = dominio.split('.');
  return SUFIXOS.includes(p.slice(-2).join('.')) ? p.slice(-3).join('.') : p.slice(-2).join('.');
}

export async function conferir(dominio: string, alvo: string) {
  const zona = await zonaDe(dominio);
  const raiz = zona === dominio;
  const [cname, a, alvoA] = await Promise.all([doh(dominio, 'CNAME'), doh(dominio, 'A'), doh(alvo, 'A')]);
  const cnames = respostas(cname, 5);
  const ips = respostas(a, 1);
  const ipsAlvo = respostas(alvoA, 1);
  const cnameOk = cnames.includes(semPonto(alvo));
  const aOk = ips.length > 0 && ipsAlvo.length > 0 && ips.every((ip) => ipsAlvo.includes(ip));
  const nome = raiz ? '@' : dominio.slice(0, -(zona.length + 1));
  const registros = raiz
    ? ipsAlvo.map((ip) => ({ tipo: 'A', nome, valor: ip, ok: ips.includes(ip) }))
    : [{ tipo: 'CNAME', nome, valor: alvo, ok: cnameOk || aOk }];
  let encontrado = 'nenhum registro ainda';
  if (cnames.length) encontrado = `CNAME apontando para ${cnames.join(', ')}`;
  else if (ips.length) encontrado = `apontando para ${ips.join(', ')}`;
  return { ok: cnameOk || aOk, zona, raiz, registros, encontrado };
}

// O site responde pelo domínio com HTTPS? (o env.js existe só no app da VTX Tap)
async function httpsOk(dominio: string) {
  try {
    const r = await fetch(`https://${dominio}/env.js`, { signal: AbortSignal.timeout(7000), redirect: 'manual' });
    return r.ok && (await r.text()).includes('NFC_ENV');
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ status: 'erro' }, 405);
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return json({ status: 'erro', mensagem: 'Entre no painel de novo.' }, 401);
  // Como a própria equipe: meu_dominio só devolve o domínio do restaurante de quem está logado.
  const eu = createClient(URL_, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  try {
    const { data: d, error } = await eu.rpc('meu_dominio');
    if (error || !d) return json({ status: 'erro', mensagem: 'Entre no painel de novo.' }, 401);
    if (!d.dominio) return json({ status: 'ok', ...d, registros: [] });
    const alvo = d.alvo || '';
    const c = await conferir(d.dominio, alvo);
    let status = d.status as string;
    let mensagem = '';
    if (!c.ok) {
      status = 'dns';
      mensagem = `Ainda não achamos o registro (${c.encontrado}). Depois de criar, a propagação costuma levar de alguns minutos a algumas horas.`;
    } else if (status !== 'ativo') {
      status = (await httpsOk(d.dominio)) ? 'ativo' : 'certificado';
      mensagem = status === 'ativo' ? '' : 'DNS certo. Estamos gerando o certificado HTTPS: costuma levar poucos minutos.';
    }
    await admin.rpc('dominio_marcar', { p_dominio: d.dominio, p_status: status, p_mensagem: mensagem || null });
    const { data: novo } = await eu.rpc('meu_dominio');
    return json({ status: 'ok', ...(novo || d), registros: c.registros, encontrado: c.encontrado, raiz: c.raiz, zona: c.zona });
  } catch (e) {
    console.error(e);
    return json({ status: 'erro', mensagem: 'Não foi possível conferir agora. Tente de novo em instantes.' }, 500);
  }
});
