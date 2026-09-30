// Roteador de domínios próprios da VTX Tap.
//
// Roda ao lado do app no EasyPanel. A cada INTERVALO segundos:
//   1. lê os domínios próprios cadastrados pelos restaurantes (public.dominios_lista, service role);
//   2. confere o DNS de cada um (DNS-over-HTTPS): CNAME para ALVO, ou A com os mesmos IPs do ALVO;
//   3. escreve a configuração dinâmica do Traefik (TRAEFIK_ARQUIVO) com uma rota por domínio certo,
//      com certificado HTTPS do Let's Encrypt (CERT_RESOLVER) — o Traefik lê o arquivo sozinho;
//   4. testa o HTTPS de cada domínio e marca 'ativo' quando o site abre (public.dominio_marcar).
// Sem dependências: só Node 22.
//
// Variáveis:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   obrigatórias
//   APP_URL          endereço interno do app no EasyPanel (padrão http://vtx_tap:80 = <projeto>_<serviço>)
//   TRAEFIK_ARQUIVO  arquivo da configuração dinâmica (padrão /traefik/vtx-dominios.yaml)
//   CERT_RESOLVER    resolvedor de certificados do Traefik (padrão letsencrypt)
//   ENTRY_HTTP, ENTRY_HTTPS  entrypoints do Traefik (padrão http e https)
//   INTERVALO        segundos entre as rodadas (padrão 30)
import { writeFileSync, readFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const E = process.env;
export const cfg = {
  url: (E.SUPABASE_URL || '').replace(/\/+$/, ''),
  chave: E.SUPABASE_SERVICE_ROLE_KEY || '',
  app: E.APP_URL || 'http://vtx_tap:80',
  arquivo: E.TRAEFIK_ARQUIVO || '/traefik/vtx-dominios.yaml',
  resolver: E.CERT_RESOLVER || 'letsencrypt',
  http: E.ENTRY_HTTP || 'http',
  https: E.ENTRY_HTTPS || 'https',
  intervalo: Math.max(10, +E.INTERVALO || 30),
};

const log = (...a) => console.log(new Date().toISOString(), ...a);
const semPonto = (s) => String(s || '').toLowerCase().replace(/\.$/, '');

export async function rpc(nome, args = {}) {
  const r = await fetch(`${cfg.url}/rest/v1/rpc/${nome}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: cfg.chave, Authorization: `Bearer ${cfg.chave}` },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`${nome}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// DNS-over-HTTPS (Cloudflare, depois Google): não depende do DNS do container.
export async function doh(nome, tipo) {
  for (const base of ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve']) {
    try {
      const r = await fetch(`${base}?name=${encodeURIComponent(nome)}&type=${tipo}`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) });
      if (r.ok) return await r.json();
    } catch { /* próximo */ }
  }
  return null;
}
const respostas = (r, tipo) => ((r && r.Answer) || []).filter((a) => a.type === tipo).map((a) => semPonto(a.data));

export async function dnsCerto(dominio, alvo, consultar = doh) {
  const [cname, a, alvoA] = await Promise.all([consultar(dominio, 'CNAME'), consultar(dominio, 'A'), consultar(alvo, 'A')]);
  const cnames = respostas(cname, 5);
  const ips = respostas(a, 1);
  const ipsAlvo = respostas(alvoA, 1);
  if (cnames.includes(semPonto(alvo))) return { ok: true };
  if (ips.length && ipsAlvo.length && ips.every((ip) => ipsAlvo.includes(ip))) return { ok: true };
  return { ok: false, encontrado: cnames.length ? `CNAME apontando para ${cnames.join(', ')}` : ips.length ? `apontando para ${ips.join(', ')}` : 'nenhum registro ainda' };
}

export async function httpsOk(dominio) {
  try {
    const r = await fetch(`https://${dominio}/env.js`, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
    return r.ok && (await r.text()).includes('NFC_ENV');
  } catch {
    return false;
  }
}

// Configuração dinâmica do Traefik: http → https e https com certificado, tudo para o app.
export function yamlTraefik(dominios) {
  const id = (d) => 'vtx-dom-' + d.replace(/[^a-z0-9]+/g, '-');
  const rotas = dominios.map((d) => `    ${id(d)}-http:
      rule: "Host(\`${d}\`)"
      entryPoints: ["${cfg.http}"]
      middlewares: ["vtx-dominios-https"]
      service: vtx-dominios
    ${id(d)}:
      rule: "Host(\`${d}\`)"
      entryPoints: ["${cfg.https}"]
      service: vtx-dominios
      tls:
        certResolver: ${cfg.resolver}`).join('\n');
  return `# Gerado pelo roteador de domínios da VTX Tap (deploy/dominios). Não edite: é reescrito sozinho.
http:
  routers:${rotas ? '\n' + rotas : ' {}'}
  middlewares:
    vtx-dominios-https:
      redirectScheme:
        scheme: https
        permanent: true
  services:
    vtx-dominios:
      loadBalancer:
        passHostHeader: true
        servers:
          - url: "${cfg.app}"
`;
}

function escrever(conteudo) {
  let antes = '';
  try { antes = readFileSync(cfg.arquivo, 'utf8'); } catch {}
  if (antes === conteudo) return false;
  mkdirSync(dirname(cfg.arquivo), { recursive: true });
  const tmp = cfg.arquivo + '.tmp';
  writeFileSync(tmp, conteudo);
  renameSync(tmp, cfg.arquivo); // troca de uma vez: o Traefik nunca lê um arquivo pela metade
  return true;
}

// Uma rodada completa. Devolve o que fez (usado nos testes).
export async function rodada({ consultar = doh, testarHttps = httpsOk, marcar = (d, s, m) => rpc('dominio_marcar', { p_dominio: d, p_status: s, p_mensagem: m || null }) } = {}) {
  const lista = await rpc('dominios_lista');
  const alvo = lista.alvo;
  const certos = [];
  const feito = [];
  for (const x of lista.dominios || []) {
    const c = await dnsCerto(x.dominio, alvo, consultar);
    if (!c.ok) {
      // DNS ainda não está certo (ou deixou de estar): fica fora do Traefik.
      if (x.status !== 'dns') await marcar(x.dominio, 'dns', `O DNS não aponta mais para a VTX Tap (${c.encontrado}).`);
      feito.push([x.dominio, 'dns']);
      continue;
    }
    certos.push(x);
  }
  const mudou = escrever(yamlTraefik(certos.map((x) => x.dominio)));
  if (mudou) log(`Traefik: ${certos.length} domínio(s) no arquivo ${cfg.arquivo}`);
  for (const x of certos) {
    if (x.status === 'ativo') { feito.push([x.dominio, 'ativo']); continue; }
    const ok = await testarHttps(x.dominio);
    if (ok) {
      await marcar(x.dominio, 'ativo', null);
      log(`No ar: https://${x.dominio}`);
      feito.push([x.dominio, 'ativo']);
    } else {
      if (x.status !== 'certificado') await marcar(x.dominio, 'certificado', 'DNS certo. Estamos gerando o certificado HTTPS: costuma levar poucos minutos.');
      feito.push([x.dominio, 'certificado']);
    }
  }
  return feito;
}

async function loop() {
  if (!cfg.url || !cfg.chave) {
    console.error('Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
  }
  log(`Roteador de domínios: app ${cfg.app}, arquivo ${cfg.arquivo}, certificados ${cfg.resolver}, a cada ${cfg.intervalo}s`);
  for (;;) {
    try {
      await rodada();
    } catch (e) {
      log('Erro na rodada:', e.message);
    }
    await new Promise((ok) => setTimeout(ok, cfg.intervalo * 1000));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) loop();
