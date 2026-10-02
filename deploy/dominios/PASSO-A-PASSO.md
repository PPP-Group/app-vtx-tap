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

## O que já está pronto

- Supabase: tabela `dominios`, funções `dominios_lista` e `dominio_marcar`, e a Edge Function `dominio` publicada.
- Código do roteador em `deploy/dominios` (`Dockerfile` + `main.mjs`).
- Tela do painel em Ajustes › Endereço.

Falta só **subir o roteador no EasyPanel** e **testar com um domínio de verdade**.

---

## Parte 1: pegar os dados necessários (5 min)

1. **URL do Supabase**: Supabase › Project Settings › API › Project URL
   (`https://cmockootzrjkcuxkxlvy.supabase.co`).
2. **Chave service_role** (secreta): Supabase › Project Settings › API Keys › `service_role` / `secret` › Reveal.
   - Ela vai **só** no app `vtx-dominios`, nunca no app principal nem no navegador.
3. **Nome interno do app principal no EasyPanel**: é `<projeto>_<app>`, tudo em minúsculas.
   - Exemplo: projeto `vtx`, app `tap` dá `vtx_tap`.
   - Confira no EasyPanel: abra o app principal; o nome aparece no topo e em *Advanced › Service name*.
   - O `APP_URL` fica `http://vtx_tap:80` (com o nome certo).

## Parte 2: criar o app do roteador no EasyPanel (10 min)

1. EasyPanel › abra o **mesmo projeto** do app principal › **+ Service › App**. Nome: `vtx-dominios`.
2. **Source**:
   - GitHub, repositório `PPP-Group/app-vtx-tap`, branch `master`.
   - **Build path: `deploy/dominios`**.
   - Build: **Dockerfile** (o arquivo `Dockerfile` dessa pasta).
3. **Environment**: cole e troque os valores:

   ```
   SUPABASE_URL=https://cmockootzrjkcuxkxlvy.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=COLE-A-CHAVE-SERVICE-ROLE
   APP_URL=http://vtx_tap:80
   ```

   Opcionais, só se o seu Traefik usar outros nomes (veja a Parte 3):
   `CERT_RESOLVER=letsencrypt`, `ENTRY_HTTP=http`, `ENTRY_HTTPS=https`, `INTERVALO=30`.
4. **Mounts › Add Bind Mount**:
   - Host path: `/etc/easypanel/traefik/config`
   - Mount path: `/traefik`

   É a pasta de onde o Traefik do EasyPanel lê as configurações. O roteador grava ali o arquivo `vtx-dominios.yaml`.
5. **Domains**: deixe **vazio**. Este app não recebe visitas; não precisa de domínio nem de porta.
6. Clique em **Deploy**.
7. Abra **Logs**. Tem que aparecer uma linha assim:

   ```
   Roteador de domínios: app http://vtx_tap:80, arquivo /traefik/vtx-dominios.yaml, certificados letsencrypt
   ```

   - **Erro de HTTP 401/403** em `dominios_lista`: a chave service_role está errada.
   - **"EACCES" ou "permission denied" em /traefik**: o Bind Mount não foi criado, ou o caminho está errado.

## Parte 3: conferir os nomes do Traefik (5 min)

O roteador usa por padrão o resolvedor `letsencrypt` e os entrypoints `http` e `https`, que são os nomes do EasyPanel. Para conferir:

1. No servidor (terminal da VPS ou *Console* do EasyPanel), rode:

   ```
   cat /etc/easypanel/traefik/config/main.yaml | head -40
   ```

   ou abra *Settings › Traefik › Custom config* no EasyPanel.
2. Procure `certResolver:` e os `entryPoints:` das rotas que já existem.
3. Se aparecer outro nome (ex.: `certResolver: le`), ponha o mesmo em `CERT_RESOLVER` no app `vtx-dominios` e faça o Deploy de novo.

Se você criou o resolvedor `hostinger` para o domínio coringa, não use ele aqui. Para os domínios dos restaurantes o certificado é o normal, por HTTP, e o resolvedor padrão do EasyPanel (`letsencrypt`) funciona.

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
| Abre outro restaurante | O domínio foi cadastrado no restaurante errado. Em Ajustes › Endereço, toque em **Trocar ou remover** e cadastre no certo. |

## Segurança (aproveitando que vai mexer no servidor)

- Gere um **token novo da API da Hostinger** e apague o antigo, que apareceu em conversa e deve ser tratado como exposto. Depois atualize o `HOSTINGER_API_TOKEN` no Traefik.
- Tire `TRAEFIK_LOG_LEVEL=DEBUG` das variáveis do Traefik. O log em DEBUG pode mostrar dados sensíveis e enche o disco.
- A chave `service_role` fica **só** no app `vtx-dominios`.
