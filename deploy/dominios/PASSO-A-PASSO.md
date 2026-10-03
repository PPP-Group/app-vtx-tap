# Domínio próprio dos restaurantes: passo a passo para ligar

Objetivo: o restaurante abre o site, o painel, o delivery e o clube por um endereço dele
(ex.: `cardapio.quintalbistro.com.br`), com HTTPS, além do subdomínio `quintal.vortexsystems.tech`,
que continua funcionando sempre.

## Como funciona

1. O restaurante digita o domínio em **Painel › Ajustes › Endereço**. O painel mostra o registro DNS que ele precisa criar.
2. A função `dominio` (Supabase) confere o DNS quando o painel pede.
3. O **roteador de domínios** (app `vtx-dominios` no EasyPanel) roda a cada 30 segundos e faz quatro coisas:
   - lê os domínios cadastrados;
   - confere o DNS de cada um;
   - escreve no Traefik a rota e o pedido de certificado (Let's Encrypt);
   - marca **No ar** quando o site abre com HTTPS.
4. Na primeira vez que o domínio fica no ar, ele entra no plano: **R$ 190 uma vez + R$ 19/mês**.

## Atenção: o Traefik é de todos os sites do servidor

O VPS (Hostinger, IP 72.60.49.32, EasyPanel, projeto `sites`) também roda o n8n, a Franccino e outros sites, todos atrás do mesmo Traefik.

- O Traefik lê a pasta `/etc/easypanel/traefik/config` inteira, com o `main.yaml` do EasyPanel e o `vtx-dominios.yaml` deste roteador.
- **Se um arquivo dessa pasta for inválido, o Traefik para de carregar a pasta toda.** Nenhum domínio novo de nenhum site ganha rota nem certificado: aparece o 404 do EasyPanel ou um certificado autoassinado.

**O que aconteceu em out/2026.**
- Com zero domínios cadastrados, a versão antiga escrevia `routers: {}` e deixava o middleware e o service soltos. O Traefik 3 recusou com "routers cannot be a standalone element", e os domínios da Franccino ficaram sem SSL.
- Correção paliativa: o `vtx-dominios` foi desligado e o arquivo foi tirado da pasta.

**Como a versão atual se protege** (`main.mjs`, com testes em `main.test.mjs`):
- **Sem domínio no ar, o arquivo é apagado.** Nunca sai bloco vazio.
- **Com domínios**, a configuração é montada, validada e só então gravada. Ela sempre tem router, service e middleware com conteúdo, e só entram nomes de domínio válidos.
- **Se a validação falhar, nada é gravado** e continua o último arquivo bom.
- **A gravação é atômica:** um `.tmp`, que o Traefik ignora, e depois a troca com `rename`.
- **Com `TRAEFIK_API`,** o roteador confere na API do Traefik se as rotas carregaram. Se não carregaram, volta o arquivo anterior.
- **Foi testada com o Traefik 3 de verdade:**
  - o arquivo antigo reproduz o erro e derruba a rota de outro site;
  - o novo carrega com zero, um e vários domínios sem nenhum erro;
  - a rota do outro site continua em todos os casos.

Nunca edite o `main.mjs` direto no VPS. O deploy do EasyPanel sobrescreve a pasta `code/` com o que está no GitHub, e a imagem que roda é a do último build. Mude no repositório e faça o Deploy.

## O que já está pronto

- Supabase: tabela `dominios`, funções `dominios_lista` e `dominio_marcar`, e a Edge Function `dominio` publicada.
- Código do roteador em `deploy/dominios` (`Dockerfile` + `main.mjs` + testes).
- Tela do painel em Ajustes › Endereço.

Falta **subir a versão corrigida do roteador** e **testar com um domínio de verdade**.

---

## Parte 1: chaves novas (segurança)

**Por que trocar.**
- A `service_role` dá **acesso total ao banco** e ignora todas as regras (RLS). Com ela dá para ler, mudar e apagar os CPFs, telefones, e-mails e pontos de todos os clientes de todos os restaurantes, criar usuários e apagar tudo.
- A chave atual vale **até 2036** e já apareceu em texto em conversas. Qualquer um que veja essas conversas ou logs consegue usá-la.
- O token da Hostinger mexe no DNS e na VPS: dá para desviar domínios e emitir certificados.

**Por que não é só "gerar outra".** Este projeto usa as chaves antigas (JWT). A `service_role` antiga não se troca sozinha: para ela parar de funcionar, é preciso passar tudo para as chaves novas (`sb_publishable_…` e `sb_secret_…`) e depois **desligar as chaves antigas**. O app principal já usa a chave pública nova. Faltam o roteador e as Edge Functions; o código dos dois já aceita as chaves novas.

**Passo A: chave nova do roteador (antes de religar).**
1. Supabase › Project Settings › **API Keys** › *Secret keys* › **New secret key**. Nome: `vtx-dominios`. Copie o `sb_secret_…`.
2. EasyPanel › `vtx-dominios` › Environment: troque o valor de `SUPABASE_SERVICE_ROLE_KEY` pelo `sb_secret_…`. O nome da variável continua o mesmo; `SUPABASE_URL` e `APP_URL` ficam como estão.
3. Siga a Parte 2: Deploy, 1 réplica e a conferência do log.

**Passo B: Edge Functions (no mesmo dia).**
1. Crie outra chave secreta, com o nome `edge-functions`.
2. Em Supabase › Edge Functions › **Secrets**, adicione:
   - `VTX_SECRET_KEY` = o `sb_secret_…` da `edge-functions`;
   - `VTX_PUBLISHABLE_KEY` = a chave pública `sb_publishable_…` (a mesma do app).
3. Publique de novo as funções `equipe`, `nfce`, `push` e `dominio`, com o código deste repositório.
4. Teste:
   - entrar no painel com o PIN;
   - a central;
   - ler uma nota no clube;
   - um aviso de pedido do delivery;
   - "Verificar agora" do domínio.

**Passo C: desligar as chaves antigas (o que mata a chave vazada).**
1. Antes, confira se nada mais usa a `service_role` ou a `anon` antigas, por exemplo fluxos do n8n ou scripts. Se usar, troque por uma chave nova.
2. Supabase › Project Settings › API Keys › *Legacy API keys* › **Disable JWT-based API keys**. A chave vazada para de funcionar na hora.
3. Teste de novo:
   - a página da mesa;
   - o painel;
   - a central;
   - o roteador: o log não pode ter "HTTP 401".

   Se algo quebrar, dá para religar as chaves antigas no mesmo lugar enquanto corrige.

**Hostinger** (só se o resolvedor `hostinger`, o do certificado coringa `*.vortexsystems.tech`, continuar em uso):
1. hPanel › Perfil › **API**: crie um token novo e apague o antigo.
2. EasyPanel › Settings › Traefik › Environment: troque o `HOSTINGER_API_TOKEN`.
   - Salvar reinicia o Traefik, e todos os sites ficam fora por alguns segundos. Faça num horário calmo.
3. Aproveite e tire o `TRAEFIK_LOG_LEVEL=DEBUG`.

Nunca cole chave ou token em conversa, print ou ticket. Se colar, gere outra.

## Parte 2: subir a versão corrigida (10 min)

O app `vtx-dominios` já existe no projeto `sites` (hoje com 0 réplicas). Confira:

1. **Source**:
   - GitHub, repositório `PPP-Group/app-vtx-tap`, branch `master`;
   - **Build path: `deploy/dominios`**;
   - Build: **Dockerfile**.
2. **Environment**:

   ```
   SUPABASE_URL=https://cmockootzrjkcuxkxlvy.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=sb_secret_...   (a chave nova do Passo A da Parte 1)
   APP_URL=http://app-vtx-tap:80
   ```

   - `APP_URL` é o nome interno do app principal no projeto `sites`.
   - Não ponha `CERT_RESOLVER=hostinger`: o padrão `letsencrypt` é o certo para os domínios dos restaurantes.
   - Opcional: `TRAEFIK_API=http://<endereço interno da API do Traefik>:8080`, se a API do Traefik estiver ligada na rede interna. Com ela o roteador confere se as rotas carregaram e desfaz se não carregaram. Sem ela, confira pelo log (passo 6).
3. **Mounts**: um *Bind mount* com host `/etc/easypanel/traefik/config` e container `/traefik`.
4. **Domains**: vazio. **Ports**: nenhuma.
5. Clique em **Deploy**, que faz o build pelo GitHub e gera a imagem nova. Só depois volte para **1 réplica**.
6. Espere o primeiro ciclo (30 s) e confira no servidor:

   ```
   docker logs --tail 50 $(docker ps -q -f name=traefik | head -1) 2>&1 | grep -i error
   ls -la /etc/easypanel/traefik/config/
   cat /etc/easypanel/traefik/config/vtx-dominios.yaml
   ```

   - **Não pode aparecer** `Error while building configuration`.
   - Sem domínio no ar, o `vtx-dominios.yaml` **não existe**: o `cat` dá "No such file". Isso é o certo.
   - Com domínio, o arquivo tem `routers:`, `middlewares:` e `services:`, todos preenchidos.
   - No log do `vtx-dominios` aparece `Roteador de domínios: app http://app-vtx-tap:80, arquivo /traefik/vtx-dominios.yaml, certificados letsencrypt…`.
   - Se aparecer erro no Traefik: volte o `vtx-dominios` para 0 réplicas, apague o `vtx-dominios.yaml` e mande o log.
7. O backup antigo (`vtx-dominios.yaml.bak`) pode ser apagado depois que tudo estiver certo.

## Parte 3: conferir os nomes do Traefik (5 min)

O roteador usa o resolvedor `letsencrypt` e os entrypoints `http` e `https`, que são os nomes do EasyPanel. Para conferir:

1. Rode `grep -n "certResolver\|entryPoints" /etc/easypanel/traefik/config/main.yaml | head`.
2. Se aparecer outro nome, ponha o mesmo em `CERT_RESOLVER`, `ENTRY_HTTP` ou `ENTRY_HTTPS` e faça o Deploy de novo.
   - Se um nome for inválido, o roteador nem começa e não grava nada: mostra "Variáveis inválidas".

## Parte 4: testar com um domínio de verdade (15 min + espera do DNS)

Use um domínio que vocês controlam. Pode ser um subdomínio de teste, ex.: `teste.vortexsystems.tech`.
Esse funcionaria até sem nada, por causa do coringa; melhor ainda é um domínio de outro dono, que é o caso real.

1. Entre no **painel de um restaurante** › **Ajustes › Endereço**. Digite o domínio (ex.: `cardapio.dominiodeteste.com.br`) e salve.
2. O painel mostra o registro DNS a criar. Crie no provedor do domínio (Registro.br, Hostinger, GoDaddy, Cloudflare…):

   | Caso | Tipo | Nome | Valor |
   |---|---|---|---|
   | Subdomínio (recomendado), ex. `cardapio.restaurante.com.br` | **CNAME** | `cardapio` | `tap.vortexsystems.tech` |
   | Domínio raiz, ex. `restaurante.com.br` | **A** | `@` | o **IP da VPS** |

   - **Cloudflare**: deixe a **nuvem cinza** (*DNS only*). Com a nuvem laranja (proxy), o certificado não sai.
   - **Registro.br**: em *DNS › Editar zona*, adicione o CNAME. Se a zona for a do Registro.br, ele aceita CNAME em subdomínio.
3. Espere o DNS propagar: de alguns minutos a algumas horas. Para conferir, rode no seu computador:

   ```
   nslookup -type=CNAME cardapio.dominiodeteste.com.br 1.1.1.1
   ```

   O resultado tem que mostrar `tap.vortexsystems.tech`.
4. No painel, em Ajustes › Endereço, toque em **Verificar agora**. O andamento vai assim:
   - **Aguardando o DNS**: o registro ainda não apareceu.
   - **Gerando o certificado**: o DNS está certo. O roteador já pôs a rota; o Let's Encrypt leva de 30 segundos a 2 minutos.
   - **No ar**: pronto.
5. Confira abrindo no celular, com HTTPS (cadeado):
   - `https://cardapio.dominiodeteste.com.br/` → página do restaurante
   - `https://cardapio.dominiodeteste.com.br/admin/` → painel
   - `https://cardapio.dominiodeteste.com.br/delivery/` → delivery (se tiver no plano)
   - `https://cardapio.dominiodeteste.com.br/?fidelidade` → clube (se tiver)
   - `https://cardapio.dominiodeteste.com.br/telao/` → telão da Prorrogação (se tiver)
6. **Plaquinhas**: encoste o celular numa plaquinha do restaurante (ou leia o QR). Ela tem que abrir já pelo domínio novo. O link gravado continua `tap.vortexsystems.tech/t/CODIGO`, e o redirecionador manda para o domínio próprio.
7. **Ativar plaquinha nova** digitando o domínio próprio no lugar do endereço (passo "Digite o endereço do restaurante").
8. **Cobrança**: na central, no restaurante, confira o plano com "Domínio próprio" e a mudança de **R$ 190 uma vez + R$ 19/mês**.

## Se algo não funcionar

| Sintoma | O que ver |
|---|---|
| Fica em **Aguardando o DNS** | O registro está com o nome ou valor errado, ou ainda não propagou. Confira com o `nslookup` acima. Na Cloudflare, nuvem cinza. |
| Fica em **Gerando o certificado** por mais de 10 min | Logs do `vtx-dominios`: o arquivo foi escrito? Logs do Traefik (EasyPanel › Settings › Traefik): erro do Let's Encrypt? O nome do resolvedor está certo (Parte 3)? A porta 80 da VPS está aberta? (O Let's Encrypt valida por HTTP.) |
| Abre com **certificado inválido** | Normalmente é a nuvem laranja da Cloudflare, ou o resolvedor errado. |
| Abre **404 do Traefik** | O `APP_URL` está errado: o nome interno do app principal não é esse. Corrija e faça o Deploy. |
| Outros sites do servidor sem SSL | Veja o log do Traefik (passo 6 da Parte 2). Se o erro apontar para `vtx-dominios.yaml`, deixe o roteador com 0 réplicas, apague o arquivo e abra um chamado com o log. |
| Abre outro restaurante | O domínio foi cadastrado no restaurante errado. Em Ajustes › Endereço, toque em **Trocar ou remover** e cadastre no certo. |

## Segurança

- A chave secreta do Supabase fica **só** no app `vtx-dominios`. Gere uma nova sempre que ela aparecer em conversa ou log.
- Tire `TRAEFIK_LOG_LEVEL=DEBUG` das variáveis do Traefik: o log em DEBUG pode mostrar dados sensíveis e enche o disco.
- Não mexa no `main.yaml` do EasyPanel, na configuração global do Traefik nem nos serviços de outros projetos (Franccino, n8n).
