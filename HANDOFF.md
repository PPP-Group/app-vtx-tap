# HANDOFF — VTX Tap

Documento de passagem de contexto: tudo o que uma sessão nova precisa saber para continuar o trabalho.
Escrito em 04/10/2026, ao fim da sessão `claude/nfc-tag-platform-config-jdj7vk`.

Nenhum valor de chave, token ou senha aparece aqui: só os nomes das variáveis.

---

## 1. O projeto

**VTX Tap** (Vortex Systems) é uma plataforma para restaurantes, bares e cafés, usada a partir de uma plaquinha
NFC + QR Code na mesa, do tamanho de um cartão de crédito. Sem aplicativo para baixar: tudo abre no navegador.

Serviços vendidos (preços em `assets/js/precos.js`, espelhados no banco em `public.plano_preco`):

| Serviço | Mensal | Observação |
|---|---|---|
| Página da mesa + cardápio + sino (chamar o garçom) | R$ 79 | o "garçom" vem incluso |
| Programa de fidelidade (clube de pontos, cartão de selos ou os dois por horário) | R$ 229 | implantação +R$ 590 |
| Delivery próprio sem comissão | R$ 169 | |
| Prorrogação (happy hour que ganha minutos a cada chopp) | R$ 89 | adicional que entra no combo |
| Combo | 2 itens −10%, 3 itens −17% (página + fidelidade + delivery = R$ 399), os quatro R$ 449 | aprovado pelo usuário |
| Implantação por faixa de mesas | R$ 690 / 990 / 1.390 | 50% no contrato de 12 meses |
| Plaquinha padrão / personalizada | R$ 17,90 / R$ 29,90 | custo ~R$ 5 |
| Domínio próprio | R$ 190 uma vez + R$ 19/mês | |
| Conferência na SEFAZ | por nota | opcional |

Perfis:
- **Central / master** (`/master`, `central/`): operadores da Vortex. Cria restaurantes, plaquinhas e planos e vê a cobrança.
- **Painel / admin** (`/admin`): equipe do restaurante, que entra com PIN. Tem administrador e equipe.
- **Cliente final**: abre a página da mesa e usa cardápio, sino, clube de fidelidade, delivery e Prorrogação.
- **Telão** (`/telao`): relógio da Prorrogação na TV.
- **Landing page** (`lp/index.html`) e **orçamento** (`lp/orcamento.html`) em `tap.vortexsystems.tech`.

---

## 2. Objetivo desta sessão (pedidos do usuário, em ordem)

1. **Combo:** atualizar com os preços novos do colega e colocar a Prorrogação como 4º card do combo, na página inicial e no orçamento.
2. **Fidelidade:** mais destaque, incluindo o cartão de selos e os "dois por horário".
3. **Prorrogação na página inicial:** explicação e prints.
4. **Orçamento:** mais fácil de entender, com caminho mais curto a partir da página inicial.
5. **Artefato interno "VTX Steps":** atualizar (é o simulador interno).
6. **Painel:**
   - com o sino desligado, a aba Chamados some e Salão vira a primeira aba;
   - no celular, as abas de baixo se sobrepunham: agora são 4 abas + "Mais".
7. **Auditoria real** de todas as funções e jornadas.
8. **Supabase:** revisar e limpar (funções, gatilhos, tabelas e dados sem uso).
9. **Segurança:** revisão completa com as boas práticas do mercado.
10. **Escala:** arquitetura para muitos clientes, sem cair por causa do código.
11. **Pagamentos:** pesquisar o gateway mais barato (taxa e prazo) para cartão recorrente e Pix, e integrar.
12. **Contas e onboarding:**
    - login e recuperação por conta própria em todos os perfis: PIN do cliente sem depender do restaurante, PIN da equipe, senha da central;
    - onboarding pronto para clientes novos e para os clientes deles.
13. **Avisos por e-mail:**
    - para a Vortex quando alguém assina;
    - para o restaurante quando um cliente entra no clube;
    - todos seguindo o manual de marca.
14. **Plaquinha pela câmera:** abrir o 3D da plaquinha no celular, em realidade aumentada, no tamanho real.
15. **Texto da plaquinha:** ela chega pronta e o restaurante cadastra cada uma em menos de 10 s, só escolhendo a mesa. Não é a Vortex que "configura as tags".
16. **Fechamento:**
    - merge para o usuário verificar;
    - avisos internos para os operadores do master (os "dois Pedros");
    - mostrar o design dos e-mails;
    - explicar o Resend e a escolha do Asaas;
    - revisar o TODO.

---

## 3. Histórico do que foi feito (em ordem) e por quê

### 3.1 Preços, combo e páginas
- `precos.js`:
  - `DESCONTO = { 2: 0.1, 3: 0.17 }` e `TODOS = 449`;
  - a Prorrogação passou a contar no combo (`combo: true`, `COBRADOS`, `itens()`);
  - o banco (`plano_preco`) foi atualizado igual.
  - Por quê: o usuário pediu a Prorrogação como 4º card. Escolhi 17% para manter P+F+D em R$ 399 e os quatro em R$ 449; o usuário aprovou.
- Página inicial:
  - fidelidade reescrita: modos clube de pontos, cartão de selos ("Novo") e os dois por horário, com print do celular;
  - seção da Prorrogação com prints do telão (`hh-telao.webp`) e da mesa (`hh-mesa.webp`);
  - 4 cards de preço + card do combo;
  - CTA de orçamento no menu, no hero, em faixas no meio da página e num botão fixo no celular.
- Orçamento:
  - sugestões por tipo de casa e "o que vem incluso" em cada serviço;
  - formulário "Quero contratar", que chama a RPC `lead_enviar`, grava em `private.leads` e manda e-mail para a Vortex.
- Painel:
  - ordem das abas: Salão primeiro;
  - Chamados some com o sino desligado (`mesas.sino === false`);
  - celular: 4 abas fixas + botão "Mais" (sheet `#sh-mais`).

### 3.2 Auditoria
- As 80 chamadas RPC do front existem no banco com os parâmetros certos.
- Crawl com Playwright de todas as abas e sub-abas, no desktop e no celular, sem erros nem overflow.
- Jornadas testadas: mesa/sino, comentário, cardápio, sino desligado, Prorrogação, delivery, plaquinha e contas (13/13).

### 3.3 Segurança (corrigido)
- **Chamados:** o anônimo lia todos os chamados. Agora o acompanhamento é pela RPC `chamado_status(token, id)`, e a leitura direta sai no SQL manual (ver 4.3).
- **Comentários:** limite contra spam (`private.limita_comentarios`).
- **PIN da equipe:** contra força bruta, "aparelho confiável" (`private.equipe_aparelhos`). De um aparelho novo, o PIN só vale junto com o código da equipe.
- **PIN do cliente:** o PIN redefinido pela equipe vale só 24 h (`fid_pins.redefinir_ate`).
- **Administrador:** o único administrador não pode se tirar.
- **Cabeçalhos** (`deploy/seguranca.conf`):
  - CSP, HSTS, nosniff, Referrer-Policy, X-Frame-Options e Permissions-Policy;
  - o connect-src inclui `blob:`, por causa do modelo 3D.
- **supabase-js** fixado na versão 2.117.2, com SRI.
- **search_path** fixo nas funções e índices nas chaves estrangeiras.
- **Escala:** gzip no nginx (store.js de 167 KB para 44 KB). O relógio da Prorrogação na mesa consulta a cada 8 s quando está rodando e a cada 60 s parado.
- Avisos do Supabase que são por desenho:
  - SECURITY DEFINER nas RPCs;
  - tabelas `hh_*` com RLS e sem policy (acesso só por RPC).

### 3.4 Contas que se resolvem sozinhas
- **Cliente do clube** (`assets/js/fidelidade.js`):
  - "Esqueci meu PIN": código de 6 números no e-mail, válido 15 min, com 5 tentativas;
  - em "Meus dados e PIN": trocar PIN, mudar e-mail e telefone, apagar a conta (LGPD).
- **Equipe** (função `equipe`):
  - e-mail de recuperação próprio, e com ele "esqueci o PIN" por código (`esqueci` / `redefinir`);
  - "Desconectar todos os aparelhos";
  - a central troca o PIN e dá admin a alguém (`central_*`, só operadores).
- **Central:**
  - esqueci a senha (`resetPasswordForEmail`), primeiro acesso (`signUp`) e nova senha pelo link;
  - "Minha conta" com troca de senha e convite de operador;
  - ao criar um restaurante, informar o "E-mail do dono" dispara o e-mail de boas-vindas com o passo a passo.
- O código de ativação antigo das plaquinhas foi removido: agora se liga a plaquinha pelo endereço (slug) e PIN.

### 3.5 Avisos por e-mail
- Fluxo:
  1. `private.aviso()` enfileira em `private.avisos_fila`;
  2. `pg_net` chama a função `avisos`;
  3. a função manda pelo Resend;
  4. o cron `avisos-reenviar`, a cada 5 min, reenvia o que falhou.
- Sem `RESEND_API_KEY` nada quebra: os e-mails ficam na fila por até 2 dias.
- Modelo `private.email_html()` no manual de marca:
  - faixa noite #140B33 com o logo, linha roxa #7D27FC;
  - título em Big Shoulders caixa alta, texto em Schibsted Grotesk, código em IBM Plex Mono;
  - botão roxo, ponto ouro #FFC61A, rodapé "uma solução VORTEX";
  - sem emoji e sem exclamação.
- E-mails que existem:
  - boas-vindas ao clube;
  - código de PIN (cliente e equipe);
  - novo cliente no clube e novo pedido no delivery (para o restaurante);
  - boas-vindas ao dono;
  - convite de operador;
  - para a Vortex: pedido de contratação, restaurante novo, mudança de plano, pagamento recebido e fatura vencida;
  - mensalidade em aberto (para o restaurante).
- **Avisos internos** (`private.aviso_vortex`): vão para o e-mail de cada operador cadastrado no master (pedido do usuário: "os dois Pedros"), mais os extras opcionais em `private.avisos_config.vortex`.

### 3.6 Pagamentos (Asaas)
- **Pesquisa** (preços públicos de out/2026):

  | Gateway | Cartão | Pix | Recebimento / observação |
  |---|---|---|---|
  | **Asaas** | 2,99% + R$ 0,49 (1,99% nos 3 primeiros meses) | R$ 1,99 (promo R$ 0,99) | em até 2 dias úteis; sem mensalidade; API de assinatura completa; Pix Automático |
  | Efí | 3,49% | 1,19% | Pix Automático R$ 3,50 |
  | Mercado Pago | 4,98% | ~0,99% | recebimento na hora |
  | Pagar.me | 4,19% | 0,99% | |
  | Stripe BR | ~3,99%+ | só por convite | |
  | InfinitePay | 2,69% | grátis | API de assinatura fraca |

- **Escolha:** Asaas, pela menor taxa de cartão com assinatura recorrente de verdade, cartão guardado pelo próprio Asaas (PCI) e recebimento rápido. O usuário reclamou que a escolha foi feita sem consultá-lo; a explicação acima foi dada.
- **Implementação:**
  - função `pagamentos` com as ações `ativar`, `pagar`, `forma`, `cancelar` e `sincronizar` (chamada pelo banco), mais o webhook (`?webhook`, header `asaas-access-token`);
  - tabelas `private.assinaturas`, `private.faturas` e `private.pag_eventos`;
  - RPCs `minha_cobranca` (painel) e `central_cobrancas` (central);
  - gatilho `plano_mudou_cobranca`: mudou o plano, a função ajusta o valor e lança a taxa única das mesas.
- **Onde aparece:**
  - painel, em Ajustes › Plano › "Pagamento da mensalidade";
  - central, numa linha de cobrança em cada restaurante.
- O cartão é digitado na página do Asaas (`invoiceUrl`). O VTX Tap nunca vê o número.

### 3.7 Plaquinha em realidade aumentada
- Modelo `assets/3d/plaquinha-vtx.glb`:
  - 85,6 × 54 × 0,8 mm, cantos de 3,18 mm, frente e verso com as artes reais;
  - gerado por `deploy/placa-glb.py` a partir das artes;
  - conferido: dimensões, normais, frente e verso sem espelhar.
- Botão "Ver na minha mesa" na seção "As plaquinhas" da página inicial:
  - carrega o `<model-viewer>` 4.3.1 (jsDelivr, com SRI) só no toque;
  - `ar-scale="fixed"` trava o tamanho real;
  - abre no Scene Viewer (Android) ou no Quick Look (iPhone).
- O nginx serve `.glb` como `model/gltf-binary`.
- Testado em Chromium headless: o modelo carrega e as dimensões estão certas. Falta testar num celular de verdade.

### 3.8 Textos
- "A plaquinha chega pronta; para ligar cada uma, alguém da equipe aproxima o celular e escolhe a mesa, em menos de 10 segundos."
- Aplicado na página inicial, na FAQ, no orçamento e no simulador interno.
- Saíram as menções a "instalação pela nossa equipe".

### 3.9 Publicação
- PR #43 mergeado no `master`; o EasyPanel publicou (botão AR conferido em produção).
- Banco aplicado pela ferramenta MCP em lotes (ver 4.3).
- Funções publicadas: `equipe` v5, `avisos` v1 e `pagamentos` v1, todas com `verify_jwt=false` porque fazem a própria checagem.
- URLs gravadas em `private.avisos_config.url` e `private.pag_config.url`.

---

## 4. Estado atual

### 4.1 Pronto e no ar
- Tudo da seção 3: site, painel, central, LP e orçamento no `master` e em produção.
- No banco:
  - contas e avisos (fila, modelos, gatilhos, cron de reenvio);
  - segurança (`chamado_status`, limite de comentários, aparelho confiável com permissão só para `service_role`);
  - pagamentos completos.

### 4.2 Pronto, mas esperando configuração do usuário
- **E-mails:** só saem depois de `RESEND_API_KEY` e `AVISOS_DE` (e do domínio verificado no Resend). Até lá ficam na fila.
- **Pagamentos:** sem `ASAAS_API_KEY`, a função responde "Pagamentos ainda não configurados". Também falta cadastrar o webhook no Asaas.
- **Central:** o "esqueci a senha" e o primeiro acesso dependem de ligar o signup e o SMTP no Supabase Auth.

### 4.3 Pela metade: SQL que precisa rodar no SQL Editor
A ferramenta `apply_migration` / `execute_sql` do MCP do Supabase **trava (timeout de 60 s)** em qualquer SQL com
`delete from` ou `drop ...`, porque pede uma confirmação que não chega à sessão. Então:

- **Já aplicado:** tudo o que não apaga nada (lotes `contas_avisos_1_tabelas`, `contas_avisos_lote0`, `contas_avisos_lote1`, `contas_seguranca_lote2`, `pagamentos_1_assinaturas`, `pagamentos_lote3`).
- **Falta o usuário rodar:** `supabase/migracoes/2026-10-04-rodar-no-sql-editor.sql`. Ele contém:
  - funções com `delete`:
    - `fid_redefinir_pin`, `codigo_conferir`, `fid_pin_codigo`, `fid_trocar_pin`, `fid_apagar_minha_conta`;
    - `equipe_codigo_conferir` (depende de `codigo_conferir`);
    - `equipe_aparelhos_esquecer`, `faxina`;
  - limpeza: drop de `ativar_etiqueta`, `trocar_codigo_ativacao`, da tabela `tentativas_ativacao` e da coluna `codigo_ativacao`;
  - `drop policy "cliente acompanha chamados recentes"` e `revoke select on public.chamados from anon`;
  - o cron `faxina-diaria`;
  - todos os blocos de permissão de novo.
- **Enquanto não rodar, ficam sem funcionar:**
  - esqueci o PIN com código (cliente e equipe);
  - trocar PIN e apagar conta do cliente;
  - "Desconectar todos os aparelhos";
  - a faxina diária.
- O restante funciona. O site novo já usa `chamado_status`, então tirar a leitura direta dos chamados não quebra nada.
- Depois de rodar, conferir com:
  ```sql
  select to_regprocedure('public.fid_pin_codigo(uuid,text,text,text)'), to_regprocedure('private.faxina()');
  ```

### 4.4 Quebrado / riscos conhecidos
- Nada quebrado conhecido em produção.
- Celulares que entravam no painel antes do novo login vão pedir o **código da equipe** uma vez: é o aparelho confiável funcionando como previsto.
- O código antigo de ativação de plaquinha deixa de existir quando o SQL manual rodar. O front novo não usa mais.

---

## 5. Próximos passos exatos

**Do usuário:**
1. Rodar `supabase/migracoes/2026-10-04-rodar-no-sql-editor.sql` no SQL Editor do Supabase.
2. **Resend:**
   - criar a conta e verificar o domínio `vortexsystems.tech` (registros DNS que o Resend mostra);
   - nos secrets das Edge Functions, criar `RESEND_API_KEY` e `AVISOS_DE` (ex.: `VTX Tap <avisos@vortexsystems.tech>`).
3. **Supabase › Authentication:**
   - ligar "Allow new users to sign up";
   - SMTP próprio pelo Resend;
   - "Leaked password protection".
4. **Asaas:**
   - criar a conta, começando pelo sandbox;
   - secrets `ASAAS_API_KEY`, `ASAAS_URL` (sandbox `https://api-sandbox.asaas.com/v3`; produção `https://api.asaas.com/v3`) e `ASAAS_WEBHOOK_TOKEN`;
   - webhook em `https://cmockootzrjkcuxkxlvy.supabase.co/functions/v1/pagamentos?webhook`, com o mesmo token e os eventos `PAYMENT_*`.
5. Testar a plaquinha em AR num Android (Chrome) e num iPhone (Safari).
6. Testar a Prorrogação num restaurante de verdade e o domínio próprio com um domínio real (itens do `TODO.txt`).
7. Confirmar que `INFOSIMPLES_TOKEN` está nos secrets (o usuário mesmo configura).

**Do Claude, na próxima sessão:**
1. Depois que o usuário rodar o SQL manual, conferir no banco (consulta do item 4.3) e testar os fluxos de esqueci o PIN.
2. Depois do Resend, mandar um e-mail de teste (um `lead_enviar`, por exemplo) e conferir `private.avisos_fila`, colunas `enviado_em` e `erro`.
3. Depois do Asaas sandbox:
   - ativar a cobrança de um restaurante de teste pelo painel;
   - pagar com cartão de teste e conferir o webhook (`private.faturas`, `private.pag_eventos`);
   - mudar o plano e ver o valor mudar no Asaas.
4. Considerar o Pix Automático do Asaas (`paymentCreationMode`), se o usuário quiser Pix recorrente sem cartão.
5. Tarefa aberta #51 (limpeza do Supabase): fica completa com o SQL manual. Depois, rodar `get_advisors` de novo.

---

## 6. Problemas encontrados e como foram resolvidos
- **MCP do Supabase trava com `delete`/`drop`:**
  - lotes sem esses comandos, aplicados pela ferramenta;
  - o resto num arquivo para o SQL Editor;
  - `drop trigger` + `create trigger` trocados por `create or replace trigger`;
  - permissões em laços com `continue when to_regprocedure(f) is null` para não falhar antes de as funções existirem.
- **Função `language sql` que chama função ainda inexistente** falha na criação (`equipe_codigo_conferir`): foi para o arquivo manual.
- **Postgres:** UPDATE com RETURNING dentro de subconsulta não é permitido. Resolvido com CTE + `select ... into`.
- **Ordem de publicação:**
  - a revogação da leitura de `chamados` e a função `equipe` nova só depois do merge do site novo, para não quebrar o site antigo;
  - a permissão das funções de aparelho confiável foi aplicada já, para ninguém anônimo criar aparelho confiável.
- **CSP bloqueou as texturas do modelo 3D** (`blob:`): `blob:` adicionado ao connect-src.
- **O model-viewer com `reveal="manual"`** não desenha na captura de tela: só afeta o teste; no AR não importa.
- **Chromium do container não acessa Google Fonts nem jsDelivr:** os testes interceptam com `curl` (scripts `fontes.js` e `cdn.js` do scratchpad).
- **Postgres local cai quando o container reinicia:**
  ```bash
  su postgres -c "/usr/lib/postgresql/*/bin/pg_ctl -D /tmp/pgdata/d -o '-p 5433 -k /tmp/pgs' start"
  ```

---

## 7. Arquitetura, arquivos e comandos

**Front:** JavaScript puro, sem build. Um app só para todos os restaurantes; o restaurante sai do subdomínio (`slug.vortexsystems.tech`) ou do domínio próprio.

**Arquivos do front:**
- `index.html` + `assets/js/cliente.js`: página da mesa.
- `assets/js/fidelidade.js`: clube.
- `assets/js/prorrogacao.js` e `telao/`: Prorrogação.
- `delivery/`: delivery.
- `admin/index.html` + `assets/js/admin.js` + `assets/css/admin.css`: painel.
- `central/` (`central.js`, `index.html`): master.
- `assets/js/store.js`: camada de dados.
  - Modo demonstração: localStorage `nfc-demo-db-v1`, sem Supabase.
  - Modo Supabase: RPCs e Realtime.
- `assets/js/precos.js`: tabela de preços única (LP, orçamento, painel).
- `lp/index.html`, `lp/orcamento.html`: venda.

**Backend Supabase** (projeto `cmockootzrjkcuxkxlvy`):
- `supabase/schema.sql`: esquema completo, idempotente.
- `supabase/migracoes/*.sql`: o que entrou em 03 e 04/10.
- `supabase/functions/`: `equipe`, `avisos`, `pagamentos`, `nfce`, `push`, `dominio` (Deno).

**Deploy:**
- `Dockerfile` (nginx), `deploy/comum.conf`, `deploy/seguranca.conf`, `deploy/templates/default.conf.template`.
- `deploy/40-env-js.sh` gera o `env.js`.
- Roteador de domínios: `deploy/dominios/`.
- Modelo 3D: `deploy/placa-glb.py`.

**Hospedagem:**
- VPS Hostinger com EasyPanel e Traefik. O app principal publica sozinho a cada push no `master`.
- Não mexer: serviços e volume do Franccino, `main.yaml` do EasyPanel, configuração global do Traefik.

**Comandos:**
- Demonstração local:
  ```bash
  python3 -m http.server 5500
  ```
  Depois abrir `http://localhost:5500/` e `/admin/`.
- Container igual ao de produção:
  ```bash
  docker build -t vtx-teste .
  docker run -p 8089:80 vtx-teste
  ```
  Hosts `tap.localhost` e `<slug>.localhost`.
- Testes do roteador:
  ```bash
  node --test deploy/dominios/main.test.mjs
  ```
- Checagem de sintaxe:
  ```bash
  node --check assets/js/*.js central/central.js
  ```
- Funções:
  ```bash
  supabase functions deploy <nome> --no-verify-jwt --project-ref cmockootzrjkcuxkxlvy
  ```
  Ou pelo MCP do Supabase: `deploy_edge_function` com `verify_jwt: false`.
- Modelo 3D:
  ```bash
  python3 deploy/placa-glb.py <frente.webp> <verso.webp> assets/3d/plaquinha-vtx.glb
  ```
- Testes E2E com Playwright, sem script versionado no repo:
  - Chromium em `/opt/pw-browsers/chromium`;
  - `NODE_PATH=/opt/node22/lib/node_modules`.

---

## 8. Variáveis de ambiente, APIs e integrações (só nomes)

**EasyPanel, app principal:** `SUPABASE_URL`, `SUPABASE_ANON_KEY` (a publishable), `CENTRAL_HOST`, `BASE_DOMAIN`.

**EasyPanel, roteador de domínios:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_URL`, opcionais `CERT_RESOLVER`, `ENTRY_HTTP`, `ENTRY_HTTPS`.

**Traefik:** `TRAEFIK_CERTIFICATESRESOLVERS_HOSTINGER_*`, `HOSTINGER_API_TOKEN`.

**Secrets das Edge Functions (Supabase):**
- `VTX_SECRET_KEY` ou `SUPABASE_SERVICE_ROLE_KEY`, e `SUPABASE_URL` (automático);
- `RESEND_API_KEY`, `AVISOS_DE` (função `avisos`);
- `ASAAS_API_KEY`, `ASAAS_URL`, `ASAAS_WEBHOOK_TOKEN` (função `pagamentos`);
- `INFOSIMPLES_TOKEN` (função `nfce`, conferência SEFAZ);
- as chaves VAPID da função `push` (ver o código da função).

**Configuração no banco** (sem segredo exposto: os segredos internos são gerados no banco):
- `private.avisos_config`: `url`, `segredo`, `vortex`;
- `private.pag_config`: `url`, `segredo`.

**APIs externas:**
- Resend (e-mail);
- Asaas (pagamentos);
- Infosimples (NFC-e/SEFAZ);
- ViaCEP e Nominatim (endereço do delivery);
- Google Fonts;
- jsDelivr (supabase-js 2.117.2, model-viewer 4.3.1, zxing-wasm).

---

## 9. Conectores / MCPs usados nesta sessão
- **Supabase MCP:**
  - `execute_sql` e `apply_migration` para aplicar SQL (atenção ao travamento com `delete`/`drop`);
  - `deploy_edge_function` e `list_edge_functions` para as funções;
  - `get_advisors` para a revisão de segurança.
- **GitHub MCP:** `create_pull_request`, `list_pull_requests`, `merge_pull_request` (PR #43).
- **Artifact:** simulador interno "VTX Steps" em https://claude.ai/artifact/KWHJ2TLFEbLHo3MebFgZhj (custo da plaquinha em R$ 5). O fonte fica no scratchpad da sessão, então numa sessão nova é preciso ler com `Artifact read` antes de republicar.
- **WebSearch/WebFetch:** pesquisa de gateways de pagamento e documentação do Asaas.
- **SendUserFile:** prévia dos e-mails (imagem).

---

## 10. Branches e PRs
- Branch de trabalho: `claude/nfc-tag-platform-config-jdj7vk`, recriada a partir do `master` depois do merge do PR #43.
- PR #43 (mergeado): https://github.com/PPP-Group/app-vtx-tap/pull/43
- PRs anteriores fechados: #33 a #37.
- Branches remotas antigas de outras pessoas ou sessões, não mexidas: `develop`, `feat/admin-clean-url`, `feat/campos-no-padrao`, `feat/fidelidade-cartao-selos`, `feat/login-por-pin`, `feat/plaquinha-frente-verso-e-precos`, `feat/precos-sugestao-b`, `feat/pwa-painel`.

---

## 11. Preferências e restrições do usuário (respeitar sempre)
- **Comunicação:** responder em **português**; manter `TODO.txt` e a lista de tarefas atualizados; "faz tudo do seu TODO, não para".
- **Decisões:** não decidir sozinho coisas de negócio relevantes (ex.: gateway de pagamento) sem explicar e comparar.
- **Fluxo de git:**
  - depois do merge de um PR, recomeçar a branch a partir do `origin/master`;
  - pode fazer merge quando o usuário pedir;
  - sem identificador de modelo em commits e PRs;
  - rodapé de commit:
    ```
    Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
    Claude-Session: https://claude.ai/code/session_01SquUYhy9CJfd3RStheVeY3
    ```
- **Chaves e segredos:**
  - **não insistir em rotação de chaves** (frase do usuário: "nao vou trocar, vou manter todas elas e ja tirei o debug, nao tente me convencer");
  - nunca repetir `HOSTINGER_API_TOKEN` nem a chave `service_role`/secret do Supabase;
  - o usuário mesmo configura o `INFOSIMPLES_TOKEN`.
- **Dados sensíveis:** nunca commitar nem repetir CPFs reais, a foto do recibo ou os XMLs de notas dos restaurantes.
- **Proibido:** contornar o captcha da SEFAZ-MG; mexer nos serviços e volume do Franccino, no `main.yaml` do EasyPanel ou na configuração global do Traefik.
- **Supabase:** nada destrutivo sem aprovação. Lista de limpeza passa pelo usuário (aprovada nesta sessão).
- **Manual de marca:**
  - cores: roxo #7D27FC, noite #140B33, ouro #FFC61A;
  - fontes: Big Shoulders Display, Schibsted Grotesk, IBM Plex Mono;
  - sem emoji e sem exclamação em texto institucional;
  - e-mails também seguem o manual.
- **Produto:** a plaquinha chega pronta; quem liga é o restaurante (menos de 10 s por plaquinha).
