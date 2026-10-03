// Roteador de domínios próprios da VTX Tap.
//
// Roda ao lado do app no EasyPanel. A cada INTERVALO segundos:
//   1. lê os domínios próprios cadastrados pelos restaurantes (public.dominios_lista, service role);
//   2. confere o DNS de cada um (DNS-over-HTTPS): CNAME para ALVO, ou A com os mesmos IPs do ALVO;
//   3. escreve a configuração dinâmica do Traefik (TRAEFIK_ARQUIVO) com uma rota por domínio certo,
//      com certificado HTTPS do Let's Encrypt (CERT_RESOLVER) — o Traefik lê o arquivo sozinho;
//   4. testa o HTTPS de cada domínio e marca 'ativo' quando o site abre (public.dominio_marcar).
// Sem dependências: só Node 22. Testes: node --test deploy/dominios/main.test.mjs
//
// CUIDADO: o Traefik do EasyPanel lê a pasta de configuração inteira, e ela é de todos os sites do
// servidor. Um arquivo inválido ali faz o Traefik parar de carregar a pasta toda: nenhum domínio novo
// de nenhum site ganha rota nem certificado. Por isso o arquivo é sempre válido ou não existe:
//   - sem domínio no ar, o arquivo é apagado (nunca "routers: {}" ou middleware/service soltos);
//   - a configuração é montada como objeto, validada (errosTraefik) e só então vira YAML;
//   - se a validação falhar, nada é gravado e o último arquivo bom continua;
//   - a gravação é atômica (arquivo .tmp + rename) e, com TRAEFIK_API, conferida no próprio Traefik:
//     se as rotas não aparecerem, o arquivo anterior volta.
//
// Variáveis:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   obrigatórias
//   APP_URL          endereço interno do app no EasyPanel (padrão http://vtx_tap:80 = <projeto>_<serviço>)
//   TRAEFIK_ARQUIVO  arquivo da configuração dinâmica (padrão /traefik/vtx-dominios.yaml)
//   CERT_RESOLVER    resolvedor de certificados do Traefik (padrão letsencrypt)
//   ENTRY_HTTP, ENTRY_HTTPS  entrypoints do Traefik (padrão http e https)
//   INTERVALO        segundos entre as rodadas (padrão 30)
//   TRAEFIK_API      opcional: API interna do Traefik (ex.: http://traefik:8080) para conferir que as rotas entraram
import { writeFileSync, readFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
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
  traefikApi: (E.TRAEFIK_API || '').replace(/\/+$/, ''),
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

/* ---------- Configuração do Traefik ---------- */
const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const NOME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const URL_APP_RE = /^https?:\/\/[A-Za-z0-9._-]+(?::\d{1,5})?\/?$/;
// Só nome de domínio de verdade entra numa regra do Traefik (nada de aspas, crases ou espaços).
export const dominioValido = (d) => HOST_RE.test(String(d || ''));
const idDe = (d) => 'vtx-dom-' + d.replace(/[^a-z0-9]+/g, '-');

// Configuração como objeto. null = nenhum domínio válido: o arquivo não deve existir.
export function configTraefik(dominios) {
  const lista = [...new Set((dominios || []).map(semPonto))].filter(dominioValido).sort();
  if (!lista.length) return null;
  const routers = {};
  for (const d of lista) {
    routers[`${idDe(d)}-http`] = { rule: `Host(\`${d}\`)`, entryPoints: [cfg.http], middlewares: ['vtx-dominios-https'], service: 'vtx-dominios' };
    routers[idDe(d)] = { rule: `Host(\`${d}\`)`, entryPoints: [cfg.https], service: 'vtx-dominios', tls: { certResolver: cfg.resolver } };
  }
  return {
    http: {
      routers,
      middlewares: { 'vtx-dominios-https': { redirectScheme: { scheme: 'https', permanent: true } } },
      services: { 'vtx-dominios': { loadBalancer: { passHostHeader: true, servers: [{ url: cfg.app }] } } },
    },
  };
}

// Problemas de estrutura (lista vazia = pode gravar). Bloco vazio nunca passa: o Traefik 3 recusa
// "routers cannot be a standalone element" e derruba a pasta inteira.
export function errosTraefik(c) {
  if (c === null) return [];
  const e = [];
  const cheio = (o) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length > 0;
  const h = c && c.http;
  if (!cheio(c) || Object.keys(c).some((k) => k !== 'http')) return ['a configuração precisa ter só o bloco http'];
  if (!cheio(h)) return ['bloco http vazio'];
  for (const k of Object.keys(h)) if (!['routers', 'middlewares', 'services'].includes(k)) e.push(`chave desconhecida http.${k}`);
  for (const k of ['routers', 'services', 'middlewares']) if (k in h && !cheio(h[k])) e.push(`http.${k} vazio`);
  if (!('routers' in h)) e.push('http.routers faltando');
  if (!('services' in h)) e.push('http.services faltando');
  const services = h.services || {};
  const middlewares = h.middlewares || {};
  for (const [n, s] of Object.entries(services)) {
    const srv = s && s.loadBalancer && s.loadBalancer.servers;
    if (!NOME_RE.test(n)) e.push(`nome de service inválido: ${n}`);
    if (!Array.isArray(srv) || !srv.length || !srv.every((x) => x && URL_APP_RE.test(x.url || ''))) e.push(`service ${n} sem servidor válido`);
  }
  for (const [n, m] of Object.entries(middlewares)) {
    if (!NOME_RE.test(n)) e.push(`nome de middleware inválido: ${n}`);
    if (!cheio(m)) e.push(`middleware ${n} vazio`);
  }
  for (const [n, r] of Object.entries(h.routers || {})) {
    if (!NOME_RE.test(n)) e.push(`nome de router inválido: ${n}`);
    if (!r || !/^Host\(`[a-z0-9.-]+`\)$/.test(r.rule || '')) e.push(`router ${n} sem rule válida`);
    if (!r || !Array.isArray(r.entryPoints) || !r.entryPoints.length || !r.entryPoints.every((x) => NOME_RE.test(x))) e.push(`router ${n} sem entryPoints`);
    if (!r || !services[r.service]) e.push(`router ${n} aponta para um service que não existe`);
    for (const m of (r && r.middlewares) || []) if (!middlewares[m]) e.push(`router ${n} usa o middleware ${m}, que não existe`);
    if (r && r.tls && !NOME_RE.test(r.tls.certResolver || '')) e.push(`router ${n} sem certResolver`);
  }
  return e;
}

// YAML do subconjunto usado aqui: mapas, listas, textos e booleanos. Textos sempre entre aspas
// duplas (o texto JSON é texto YAML válido), então nenhum valor quebra a estrutura.
function yaml(v, nivel = 0) {
  const pad = '  '.repeat(nivel);
  const val = (x) => (typeof x === 'boolean' || typeof x === 'number' ? String(x) : JSON.stringify(String(x)));
  return Object.entries(v).map(([k, x]) => {
    if (Array.isArray(x)) {
      if (x.every((i) => i === null || typeof i !== 'object')) return `${pad}${k}: [${x.map(val).join(', ')}]`;
      return `${pad}${k}:\n` + x.map((i) => `${pad}  - ` + yaml(i, nivel + 2).trimStart()).join('\n');
    }
    if (x && typeof x === 'object') return `${pad}${k}:\n${yaml(x, nivel + 1)}`;
    return `${pad}${k}: ${val(x)}`;
  }).join('\n');
}

const CABECALHO = '# Gerado pelo roteador de domínios da VTX Tap (deploy/dominios). Não edite: é reescrito sozinho.\n';

// Texto do arquivo do Traefik. null = nenhum domínio: o arquivo não deve existir.
// Lança erro se a configuração montada não passar na validação (aí nada é gravado).
export function yamlTraefik(dominios) {
  const c = configTraefik(dominios);
  if (c === null) return null;
  const erros = errosTraefik(c);
  if (erros.length) throw new Error(`Configuração do Traefik inválida (${erros.join('; ')})`);
  return CABECALHO + yaml(c) + '\n';
}

export function lerArquivo() {
  try { return readFileSync(cfg.arquivo, 'utf8'); } catch { return null; }
}

// Grava de uma vez (arquivo .tmp, que o Traefik ignora, e rename) ou apaga, com null.
// O Traefik nunca lê um arquivo pela metade. Devolve se mudou alguma coisa.
export function escrever(conteudo) {
  const antes = lerArquivo();
  if (antes === conteudo) return false;
  if (conteudo === null) {
    try { unlinkSync(cfg.arquivo); } catch { /* já não existia */ }
    return true;
  }
  mkdirSync(dirname(cfg.arquivo), { recursive: true });
  const tmp = `${cfg.arquivo}.tmp`;
  writeFileSync(tmp, conteudo);
  renameSync(tmp, cfg.arquivo);
  return true;
}

// Confere na API do Traefik (TRAEFIK_API) que as rotas https dos domínios carregaram.
// true = aceitou; false = a API respondeu e as rotas não estão lá; null = sem API ou fora do ar (não dá para saber).
export async function traefikAceitou(dominios, { tentativas = 10, espera = 1500, buscar = fetch } = {}) {
  if (!cfg.traefikApi) return null;
  const nomes = [...new Set((dominios || []).map(semPonto))].filter(dominioValido).map((d) => `${idDe(d)}@file`);
  if (!nomes.length) return null;
  for (let i = 0; i < tentativas; i++) {
    if (i) await new Promise((ok) => setTimeout(ok, espera));
    try {
      const st = await Promise.all(nomes.map(async (n) => (await buscar(`${cfg.traefikApi}/api/http/routers/${encodeURIComponent(n)}`, { signal: AbortSignal.timeout(4000) })).status));
      if (st.every((x) => x === 200)) return true;
      if (st.some((x) => x !== 200 && x !== 404)) return null;
    } catch {
      return null;
    }
  }
  return false;
}

// Grava a configuração dos domínios com todas as proteções. Devolve 'igual', 'gravado', 'removido',
// 'invalido' (não gravou) ou 'desfeito' (o Traefik não aceitou e o arquivo anterior voltou).
export async function aplicarTraefik(dominios, opcoes = {}) {
  let texto;
  try {
    texto = yamlTraefik(dominios);
  } catch (e) {
    log(`${e.message}: nada foi gravado, continua o último arquivo bom.`);
    return 'invalido';
  }
  const antes = lerArquivo();
  if (!escrever(texto)) return 'igual';
  if (texto === null) {
    log(`Traefik: nenhum domínio no ar, arquivo ${cfg.arquivo} removido.`);
    return 'removido';
  }
  log(`Traefik: ${dominios.filter(dominioValido).length} domínio(s) no arquivo ${cfg.arquivo}.`);
  if ((await traefikAceitou(dominios, opcoes)) === false) {
    escrever(antes);
    log('O Traefik não carregou as rotas novas: voltou o arquivo anterior. Veja o log do Traefik.');
    return 'desfeito';
  }
  return 'gravado';
}

// Uma rodada completa. Devolve o que fez (usado nos testes).
export async function rodada({ listar = () => rpc('dominios_lista'), consultar = doh, testarHttps = httpsOk, aplicar = aplicarTraefik,
  marcar = (d, s, m) => rpc('dominio_marcar', { p_dominio: d, p_status: s, p_mensagem: m || null }) } = {}) {
  const lista = await listar();
  const alvo = lista.alvo;
  const certos = [];
  const feito = [];
  for (const x of lista.dominios || []) {
    if (!dominioValido(semPonto(x.dominio))) {
      log(`Domínio com nome inválido, fica fora do Traefik: ${JSON.stringify(x.dominio)}`);
      continue;
    }
    const c = await dnsCerto(x.dominio, alvo, consultar);
    if (!c.ok) {
      // DNS ainda não está certo (ou deixou de estar): fica fora do Traefik.
      if (x.status !== 'dns') await marcar(x.dominio, 'dns', `O DNS não aponta mais para a VTX Tap (${c.encontrado}).`);
      feito.push([x.dominio, 'dns']);
      continue;
    }
    certos.push(x);
  }
  const resultado = await aplicar(certos.map((x) => semPonto(x.dominio)));
  // Configuração não gravada ou desfeita: não marca nada como no ar nesta rodada.
  if (resultado === 'invalido' || resultado === 'desfeito') return feito;
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
  const ruins = [!URL_APP_RE.test(cfg.app) && `APP_URL (${cfg.app})`, !NOME_RE.test(cfg.resolver) && 'CERT_RESOLVER',
    !NOME_RE.test(cfg.http) && 'ENTRY_HTTP', !NOME_RE.test(cfg.https) && 'ENTRY_HTTPS', !/\.ya?ml$/.test(cfg.arquivo) && 'TRAEFIK_ARQUIVO (precisa terminar em .yaml)'].filter(Boolean);
  if (ruins.length) {
    console.error(`Variáveis inválidas: ${ruins.join(', ')}. Nada foi gravado.`);
    process.exit(1);
  }
  log(`Roteador de domínios: app ${cfg.app}, arquivo ${cfg.arquivo}, certificados ${cfg.resolver}, a cada ${cfg.intervalo}s${cfg.traefikApi ? `, conferindo em ${cfg.traefikApi}` : ''}`);
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
