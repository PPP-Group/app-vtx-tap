// Testes do roteador de domínios. Rodar: node --test deploy/dominios/main.test.mjs
// O que importa: o arquivo do Traefik nunca pode sair inválido (ele é lido junto com o de todos os
// sites do servidor). Ou tem router, service e middleware com conteúdo, ou o arquivo não existe.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cfg, configTraefik, errosTraefik, yamlTraefik, escrever, aplicarTraefik, traefikAceitou, rodada, dominioValido } from './main.mjs';

let pasta;
beforeEach(() => {
  pasta = mkdtempSync(join(tmpdir(), 'vtx-dom-'));
  Object.assign(cfg, { arquivo: join(pasta, 'vtx-dominios.yaml'), app: 'http://app-vtx-tap:80', resolver: 'letsencrypt', http: 'http', https: 'https', traefikApi: '' });
});

// Leitor do YAML que este roteador gera (mapas por indentação, listas "- " e [..], textos entre aspas).
// Serve para conferir a estrutura do texto final, não só do objeto.
function lerYaml(texto) {
  const linhas = texto.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  const valor = (v) => {
    v = v.trim();
    if (v.startsWith('[')) return v === '[]' ? [] : v.slice(1, -1).split(/,\s*/).map(valor);
    if (v.startsWith('"')) return JSON.parse(v);
    if (v === 'true' || v === 'false') return v === 'true';
    if (v === '{}') return {};
    return v;
  };
  let i = 0;
  function bloco(ind) {
    let obj = null;
    while (i < linhas.length) {
      const l = linhas[i];
      const n = l.length - l.trimStart().length;
      if (n < ind) break;
      const t = l.trim();
      if (t.startsWith('- ')) {
        obj = obj || [];
        linhas[i] = ' '.repeat(n + 2) + t.slice(2);
        obj.push(bloco(n + 2));
        continue;
      }
      obj = obj || {};
      const [k, ...r] = t.split(':');
      const resto = r.join(':').trim();
      i++;
      obj[k] = resto ? valor(resto) : bloco(n + 1);
    }
    return obj;
  }
  return bloco(0);
}

test('zero domínios: nenhum arquivo, nada de bloco vazio', () => {
  assert.equal(configTraefik([]), null);
  assert.equal(yamlTraefik([]), null);
  assert.equal(yamlTraefik(undefined), null);
  // Só nomes inválidos também conta como zero.
  assert.equal(yamlTraefik(['', 'sem-ponto', 'a.com`) || Host(`x.com']), null);
});

test('zero domínios apaga o arquivo antigo (inclusive o com routers: {} que derrubou o Traefik)', async () => {
  writeFileSync(cfg.arquivo, 'http:\n  routers: {}\n  middlewares:\n    x:\n      redirectScheme:\n        scheme: https\n');
  assert.equal(await aplicarTraefik([]), 'removido');
  assert.equal(existsSync(cfg.arquivo), false);
  assert.equal(await aplicarTraefik([]), 'igual');
});

test('um domínio: router http e https, middleware e service com conteúdo', () => {
  const texto = yamlTraefik(['cardapio.restaurante.com.br']);
  assert.doesNotMatch(texto, /\{\}/);
  const y = lerYaml(texto);
  const h = y.http;
  assert.deepEqual(Object.keys(h).sort(), ['middlewares', 'routers', 'services']);
  assert.deepEqual(Object.keys(h.routers).sort(), ['vtx-dom-cardapio-restaurante-com-br', 'vtx-dom-cardapio-restaurante-com-br-http']);
  const https = h.routers['vtx-dom-cardapio-restaurante-com-br'];
  assert.equal(https.rule, 'Host(`cardapio.restaurante.com.br`)');
  assert.deepEqual(https.entryPoints, ['https']);
  assert.equal(https.service, 'vtx-dominios');
  assert.equal(https.tls.certResolver, 'letsencrypt');
  const http = h.routers['vtx-dom-cardapio-restaurante-com-br-http'];
  assert.deepEqual(http.entryPoints, ['http']);
  assert.deepEqual(http.middlewares, ['vtx-dominios-https']);
  assert.equal(h.middlewares['vtx-dominios-https'].redirectScheme.scheme, 'https');
  assert.equal(h.middlewares['vtx-dominios-https'].redirectScheme.permanent, true);
  assert.deepEqual(h.services['vtx-dominios'].loadBalancer.servers, [{ url: 'http://app-vtx-tap:80' }]);
  // O texto lido de volta passa na mesma validação do objeto.
  assert.deepEqual(errosTraefik(y), []);
});

test('vários domínios: um par de routers por domínio, sem repetidos, nomes inválidos fora', () => {
  const texto = yamlTraefik(['b.com.br', 'a.com.br', 'B.com.br.', 'x.com"\n  evil: 1', 'c.restaurante.com']);
  const y = lerYaml(texto);
  assert.equal(Object.keys(y.http.routers).length, 6);
  assert.ok(y.http.routers['vtx-dom-a-com-br'] && y.http.routers['vtx-dom-b-com-br'] && y.http.routers['vtx-dom-c-restaurante-com']);
  assert.doesNotMatch(texto, /evil/);
  assert.deepEqual(errosTraefik(y), []);
});

test('validação recusa qualquer bloco vazio ou referência quebrada', () => {
  assert.deepEqual(errosTraefik(null), []);
  assert.ok(errosTraefik({ http: {} }).length);
  assert.ok(errosTraefik({ http: { routers: {} } }).length);
  assert.ok(errosTraefik({ http: { middlewares: { m: { redirectScheme: { scheme: 'https' } } } } }).length);
  const bom = configTraefik(['a.com.br']);
  assert.deepEqual(errosTraefik(bom), []);
  const semService = structuredClone(bom);
  semService.http.services = {};
  assert.ok(errosTraefik(semService).some((e) => /services vazio/.test(e)));
  const semMiddleware = structuredClone(bom);
  delete semMiddleware.http.middlewares;
  assert.ok(errosTraefik(semMiddleware).some((e) => /middleware vtx-dominios-https/.test(e)));
});

test('configuração inválida não grava e mantém o último arquivo bom', async () => {
  assert.equal(await aplicarTraefik(['a.com.br']), 'gravado');
  const bom = readFileSync(cfg.arquivo, 'utf8');
  cfg.app = 'http://app vtx'; // URL quebrada: a validação recusa
  assert.throws(() => yamlTraefik(['a.com.br', 'b.com.br']));
  assert.equal(await aplicarTraefik(['a.com.br', 'b.com.br']), 'invalido');
  assert.equal(readFileSync(cfg.arquivo, 'utf8'), bom);
});

test('gravação atômica: não sobra arquivo .tmp e nada além do .yaml na pasta', () => {
  assert.equal(escrever(yamlTraefik(['a.com.br'])), true);
  assert.equal(escrever(yamlTraefik(['a.com.br'])), false);
  assert.deepEqual(readdirSync(pasta), ['vtx-dominios.yaml']);
});

test('com TRAEFIK_API: rotas carregadas = gravado; rotas ausentes = volta o arquivo anterior', async () => {
  await aplicarTraefik(['a.com.br']);
  const antes = readFileSync(cfg.arquivo, 'utf8');
  cfg.traefikApi = 'http://traefik:8080';
  const nao = async () => ({ status: 404 });
  assert.equal(await aplicarTraefik(['a.com.br', 'b.com.br'], { buscar: nao, tentativas: 2, espera: 1 }), 'desfeito');
  assert.equal(readFileSync(cfg.arquivo, 'utf8'), antes);
  const sim = async () => ({ status: 200 });
  assert.equal(await aplicarTraefik(['a.com.br', 'b.com.br'], { buscar: sim }), 'gravado');
  // API fora do ar: não dá para saber, não desfaz.
  assert.equal(await traefikAceitou(['c.com.br'], { buscar: async () => { throw new Error('sem rede'); } }), null);
});

test('rodada sem domínio cadastrado não deixa arquivo', async () => {
  writeFileSync(cfg.arquivo, 'http:\n  routers: {}\n');
  const feito = await rodada({ listar: async () => ({ alvo: 'tap.vortexsystems.tech', dominios: [] }), marcar: async () => {} });
  assert.deepEqual(feito, []);
  assert.equal(existsSync(cfg.arquivo), false);
});

test('rodada: só o domínio com DNS certo entra; o resto fica fora', async () => {
  const consultar = async (nome, tipo) => (nome === 'ok.com.br' && tipo === 'CNAME' ? { Answer: [{ type: 5, data: 'tap.vortexsystems.tech.' }] } : { Answer: [] });
  const marcados = [];
  const feito = await rodada({
    listar: async () => ({ alvo: 'tap.vortexsystems.tech', dominios: [{ dominio: 'ok.com.br', status: 'dns' }, { dominio: 'falta.com.br', status: 'dns' }, { dominio: 'ruim com', status: 'dns' }] }),
    consultar, testarHttps: async () => false, marcar: async (d, s) => marcados.push([d, s]),
  });
  assert.deepEqual(feito, [['falta.com.br', 'dns'], ['ok.com.br', 'certificado']]);
  assert.deepEqual(marcados, [['ok.com.br', 'certificado']]);
  const y = lerYaml(readFileSync(cfg.arquivo, 'utf8'));
  assert.deepEqual(Object.keys(y.http.routers).sort(), ['vtx-dom-ok-com-br', 'vtx-dom-ok-com-br-http']);
});

test('nomes de domínio', () => {
  assert.ok(dominioValido('cardapio.quintal.com.br'));
  assert.ok(!dominioValido('cardapio.quintal.com.br`'));
  assert.ok(!dominioValido('-a.com'));
  assert.ok(!dominioValido('localhost'));
});
