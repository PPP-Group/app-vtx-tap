# Plataforma NFC para restaurantes

Template de página de mesa acionada por plaquinha NFC, com painel da equipe em tempo real.

O cliente encosta o celular na plaquinha da mesa e abre uma página com a capa do restaurante, a logo, o nome e a plaquinha com o número da mesa. Nela ele encontra:

- **Chamar garçom**: escolhe o motivo (atendimento, pedido, conta, água, outro) e segura o sino por 1 segundo. Segurar em vez de tocar evita chamados acidentais. O cliente acompanha o status: *Enviado → Fulano está a caminho → Atendido*.
- **Cardápio** com busca, categorias fixas no topo e selos (vegetariano, sem glúten…). O cliente monta uma lista e chama o garçom com ela.
- **Wi-Fi**: rede, senha com botão de copiar e QR para conectar outro celular.
- **Dividir a conta** com taxa de serviço.
- **Avaliar no Google** (link direto para a avaliação).
- **Comentário anônimo**: estrelas, marcações e texto, sem pedir nome, e-mail ou telefone.
- **Widgets personalizados**: links que a equipe adiciona (carta de vinhos, delivery, reservas…).

O **painel da equipe** (`/admin`) funciona no celular (abas embaixo) e no desktop (menu lateral):

- **Chamados** em tempo real, com sino sonoro, vibração, notificação do sistema e cronômetro que fica amarelo e vermelho conforme o tempo passa.
- **Salão**: mapa das mesas com quem está chamando.
- **Comentários**: nota média, distribuição e marcações mais citadas.
- **Mesas**: quantidade de mesas, áreas do salão e qual plaquinha está em cada mesa (ligar, trocar ou desligar).
- **Ajustes**
  - *Restaurante*: logo, foto de capa, nome, frase curta, endereço, Instagram, link de avaliação do Google, taxa de serviço, Wi-Fi, horário de funcionamento e a equipe (quem tem conta, remover pessoas, trocar a senha da equipe).
  - *Cardápio*: categorias e pratos (nome, descrição, preço, selos, destaque da casa), com ordem ajustável.
  - *Widgets*: o que aparece na página da mesa e em que ordem.
  - *Aparelho*: som, lembrete de atrasados, notificações, manter a tela ligada e tema (claro por padrão).

Tudo o que muda no dia a dia do restaurante é editado no painel.

## Como funciona: um sistema para todos os restaurantes

Um app e um banco (Supabase) atendem a central da Vortex e todos os restaurantes:

- `tap.vortexsystems.tech` → **central** (painel da Vortex) e o **redirecionador** das plaquinhas (`/t/CODIGO`).
- `quintal.vortexsystems.tech` → **restaurante** "quintal": página da mesa (`/`) e painel da equipe (`/admin`).

Cada restaurante é uma linha em `restaurantes`, identificado pelo **subdomínio**. Tudo o que é dele (chamados, equipe, mesas, comentários, plaquinhas) tem `restaurante_id`, e as regras do banco (RLS) garantem que a equipe de um restaurante só enxerga o dela. Cliente novo = um cadastro na central; não há banco, deploy nem DNS novo por cliente.

### Plaquinhas

Toda plaquinha sai de fábrica com um código único (ex.: `K7P2QXA`). O NFC e o QR têm o **mesmo link**, `https://tap.vortexsystems.tech/t/K7P2QXA`, e ela não tem número de mesa impresso.

1. **Fábrica (central):** *Gerar lote* baixa o **PDF para a gráfica** (uma plaquinha de 12 × 6 cm por página, com QR e código). Depois, *Gravar NFC* (Chrome no Android) grava e bloqueia as etiquetas: **Ler o QR da plaquinha** (garante NFC igual ao QR) ou **Digitar o código** impresso, sem câmera. Câmera e NFC nunca ficam ligados juntos. As plaquinhas saem **sem dono**.
2. **Implantação (central):** *Novo restaurante* com nome, **subdomínio** e **senha da equipe**. A tela seguinte tem o site, o painel e a senha com botões de copiar, **Copiar tudo** e **Enviar no WhatsApp** (o mesmo fica em *Acesso*, no cartão do restaurante).
3. **Instalação (restaurante):** cola a plaquinha e encosta o celular → **Plaquinha nova** → digita o **endereço do restaurante** (só na primeira; o celular lembra) → entra com o PIN (ou cria a conta com a senha da equipe) → escolhe a mesa. Daí em diante, a plaquinha abre direto a mesa. Não existe código de ativação à parte: o login da equipe é a autorização.

Os códigos nunca repetem (o código é a chave primária de `etiquetas`); gere sempre pela central. *Atribuir a um restaurante* continua na central para casos manuais.

### Sino liberado pela equipe (antitrote)

A página da mesa abre para qualquer um (cardápio, Wi-Fi etc.), mas o sino só funciona depois que a equipe libera **aquele celular**:

- O cliente informa o nome → o pedido aparece em *Chamados* com som → o garçom confere e toca em **Liberar** (ou **Recusar**).
- Quem foi liberado vê o **código da mesa** (4 números) e pode passá-lo a quem está junto: com o código, o sino libera na hora.
- **Fechar mesa** bloqueia o sino de todos e troca o código. A liberação vence sozinha depois de 6 h.
- Garantido no banco: não existe chamado sem liberação válida, e mesa e restaurante vêm da liberação, não do link.

### Central (painel da Vortex)

- *Visão geral*: leituras por dia (7, 30 ou 90 dias), ranking dos restaurantes com variação contra o período anterior, **chamados e tempo médio de resposta** de cada restaurante, plaquinhas nunca lidas e alerta de restaurante parado há 7 dias.
- *Plaquinhas*: gerar lote (com PDF), PDF de novo pela seleção, atribuir, devolver ao estoque, imprimir QR ou etiquetas de código, exportar CSV e gravar NFC.
- *Restaurantes*: subdomínio, dados de acesso para mandar ao restaurante (copiar ou WhatsApp), nova senha da equipe, ativar ou desativar.

## Estrutura

```
index.html              página da mesa (cliente)          →  quintal.vortexsystems.tech/?tag=CODIGO
admin/index.html        painel da equipe do restaurante   →  quintal.vortexsystems.tech/admin
central/                central da Vortex e redirecionador →  tap.vortexsystems.tech  e  /t/CODIGO
central/placa.js        layout do PDF das plaquinhas (o @ e os textos ficam no topo)
env.js                  gerado no servidor a partir das variáveis de ambiente
assets/js/config.js     dados iniciais do restaurante e leitura do subdomínio
assets/js/store.js      dados: modo demonstração (navegador) ou Supabase
assets/js/cliente.js    página da mesa;   assets/js/admin.js   painel da equipe
supabase/schema.sql     banco único: tabelas, regras de acesso, funções, imagens e tempo real
supabase/functions/     função "equipe": criar conta e entrar por PIN (por restaurante)
Dockerfile, deploy/     nginx: central no CENTRAL_HOST, restaurantes em qualquer outro subdomínio
```

## Testar agora (modo demonstração)

```bash
python -m http.server 5500
```

- Restaurante: `http://localhost:5500/admin` (crie a conta; a primeira senha vira a da equipe) e `http://localhost:5500/?mesa=12`.
- Central: `http://localhost:5500/central/` (o redirecionador fica em `/central/t.html?c=CODIGO`).

Sem as variáveis do Supabase, os dados ficam no navegador e sincronizam só entre abas do mesmo aparelho.

## Colocar em produção (VPS Hostinger com EasyPanel + Supabase)

**1. Supabase (um projeto só).** No *SQL Editor*, execute `supabase/schema.sql` (pode rodar de novo a cada atualização). Publique a função da equipe com a verificação de JWT desligada (ela faz a própria checagem):

```bash
supabase functions deploy equipe --no-verify-jwt --project-ref SEU-PROJETO
```

Operadores da central: convide o e-mail e crie o usuário em *Authentication › Users › Add user* com *Auto Confirm User*; ele vira operador na hora.

```sql
insert into public.operadores_convite (email, nome) values ('voce@empresa.com', 'Seu nome');
```

Recomendado: em *Authentication › Sign In / Providers*, desative **Allow new users to sign up**.

**2. DNS na Hostinger (uma vez).** Dois registros A apontando para o IP da VPS:

| Nome | Tipo | Valor |
|---|---|---|
| `tap` | A | IP da VPS |
| `*` | A | IP da VPS |

O `*` faz qualquer subdomínio novo (`quintal`, `nonna`…) chegar à VPS sem mexer no DNS de novo.

**3. EasyPanel: um app só.** *Source*: este repositório, Dockerfile na raiz. *Environment*:

```
SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_ANON_KEY=sua-chave-publishable
CENTRAL_HOST=tap.vortexsystems.tech
BASE_DOMAIN=vortexsystems.tech
```

Nunca use a chave `service_role` / `secret` aqui. No log do deploy deve aparecer `env.js gerado (Supabase: configurado; central: tap.vortexsystems.tech; restaurantes: *.vortexsystems.tech)`.

**4. Domínios e HTTPS no EasyPanel.** No app, adicione dois domínios, porta **80**:

- `tap.vortexsystems.tech` (certificado normal, automático);
- `vortexsystems.tech` com a opção **Wildcard domain** ligada (atende `*.vortexsystems.tech`).

O certificado coringa exige validação pelo DNS. Em *Settings › Traefik › Environment*, crie um resolvedor com a Hostinger (gere o token em hPanel › Perfil › API):

```
TRAEFIK_CERTIFICATESRESOLVERS_HOSTINGER_ACME_EMAIL=seu@email.com
TRAEFIK_CERTIFICATESRESOLVERS_HOSTINGER_ACME_STORAGE=/data/acme.json
TRAEFIK_CERTIFICATESRESOLVERS_HOSTINGER_ACME_DNSCHALLENGE_PROVIDER=hostinger
TRAEFIK_CERTIFICATESRESOLVERS_HOSTINGER_ACME_DNSCHALLENGE_RESOLVERS=1.1.1.1,8.8.8.8
HOSTINGER_API_TOKEN=seu-token
```

Reinicie o Traefik e, no domínio coringa, informe o resolvedor `hostinger`. O provedor `hostinger` existe no gerador de certificados do Traefik a partir das versões recentes; se a sua versão não reconhecer, a alternativa é passar o DNS do domínio para a Cloudflare (grátis) e usar o provedor `cloudflare`.

Pronto: cada restaurante criado na central já responde em `https://subdominio.vortexsystems.tech`, com HTTPS, sem nenhum passo manual.

## App do painel no celular

O painel (`/admin`) pode ser instalado como app (PWA), com ícone na tela inicial e abertura em tela cheia.

- **Android (Chrome)**: o painel mostra um convite para instalar. Também dá para instalar em *Ajustes › Aparelho › Instalar* ou pelo menu **⋮ › Instalar app**.
- **iPhone/iPad**: no Safari, toque em **Compartilhar › Adicionar à Tela de Início**. Os passos também aparecem em *Ajustes › Aparelho*.
- Exige HTTPS, que o EasyPanel já fornece. Os arquivos ficam em `admin/manifest.webmanifest`, `admin/sw.js` e `admin/icons/`.
- O app sempre busca a versão mais nova quando há internet; sem internet, abre a última cópia salva.
- As notificações de chamado aparecem enquanto o app está aberto ou em segundo plano recente. Aviso com o app totalmente fechado exige Web Push, que ainda não está implementado.

## Personalizar a aparência

Cores e fontes estão nos tokens do topo de `assets/css/base.css` (`--cobalt` é a cor da placa, `--brass` a do sino).

## Observações

- O link de avaliação do Google aparece para todos os clientes, independentemente da nota dada no comentário anônimo. Mostrar o Google só para quem deu nota alta viola as políticas de avaliações do Google.
- O cliente anônimo consegue ler chamados das últimas 3 horas (necessário para acompanhar o status em tempo real). Eles contêm apenas mesa, motivo e itens — nenhum dado pessoal.
- A senha do Wi-Fi fica visível para quem abre a página da mesa, como numa plaquinha impressa.
- Quem tem o link de uma mesa vê a página, mas só chama o garçom depois que a equipe libera aquele celular (ou com o código da mesa). Limites no banco: 5 chamados por mesa a cada 2 minutos, 4 pedidos de liberação pendentes por mesa e 6 tentativas de código por mesa a cada 10 minutos.
- As plaquinhas dependem do domínio `tap.vortexsystems.tech` estar no ar: é o link gravado em todas elas.
- Os nomes que os clientes digitam ficam só na tabela `sessoes`, que só a equipe lê.
- **Login por PIN**: cada pessoa tem um PIN único (4 a 8 números) e entra só com ele. O servidor bloqueia um aparelho por 15 minutos depois de 10 PINs errados e limita o total de tentativas; prefira PINs de 6 números. Quem sai da equipe é removido em *Ajustes › Restaurante › Equipe* e perde o acesso na hora.
- Criar conta exige a senha da equipe; trocar essa senha não desconecta ninguém.
- No modo demonstração, contas e PINs ficam guardados só no navegador.
