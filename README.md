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

## Plaquinhas pré-configuradas e sino liberado pela equipe

**Plaquinhas genéricas.** Toda plaquinha sai de fábrica com um código único (ex.: `K7P2QXA`). O NFC e o QR têm o **mesmo link**, que aponta para a central de vocês: `https://tap.seudominio.com.br/t/K7P2QXA`. A plaquinha não tem número de mesa impresso.

1. **Fábrica (vocês, na central):** gerar lote → imprimir os QR / exportar CSV → gravar e bloquear o NFC (Chrome no Android).
2. **Venda (vocês, na central):** cadastrar o restaurante com o endereço do site dele e entregar as plaquinhas a ele.
3. **Instalação (restaurante):** cola a plaquinha na mesa e encosta o celular. Aparece **Plaquinha nova** → *Sou da equipe · configurar* → PIN → escolhe a mesa. Daí em diante, a plaquinha abre direto aquela mesa.

O caminho de cada toque: `central/t/CODIGO` → site do restaurante `/?tag=CODIGO` → o banco do restaurante diz qual é a mesa. A central só sabe *de qual restaurante* é o código; *qual mesa* fica no banco do restaurante. Mudou o domínio do cliente? Troque o endereço na central e todas as plaquinhas dele continuam funcionando.

**Sino liberado pela equipe (antitrote).** A página da mesa abre para qualquer um (cardápio, Wi-Fi etc.), mas o sino só funciona depois que a equipe libera **aquele celular**:

- O cliente informa o nome → o pedido aparece em *Chamados* com som → o garçom confere que a pessoa está na mesa e toca em **Liberar** (ou **Recusar**).
- Quem foi liberado vê o **código da mesa** (4 números) e pode passá-lo para quem está junto: com o código, o sino libera na hora, sem incomodar o garçom.
- **Fechar mesa** (no chamado de conta, ou em *Salão › mesa*) bloqueia o sino de todos e troca o código. A liberação também vence sozinha depois de 6 h.
- A regra é garantida no banco: o navegador não consegue criar chamado sem uma liberação válida, e a mesa vem da liberação, não do link. O código não precisa ser alterado para adaptar a plataforma a um novo restaurante.

## Estrutura

```
index.html              página da mesa (cliente)  →  seusite.com/?mesa=12
admin/index.html        painel da equipe          →  seusite.com/admin
env.js                  gerado no servidor a partir das variáveis de ambiente
assets/js/config.js     dados iniciais de demonstração (copiados para o banco no primeiro uso)
assets/js/store.js      dados: modo demonstração (navegador) ou Supabase
assets/js/ui.js         utilitários, ícones e folhas deslizantes
assets/js/cliente.js    lógica da página da mesa
assets/js/admin.js      lógica do painel
assets/css/             base.css (tokens e componentes), cliente.css, admin.css
supabase/schema.sql     tabelas, segurança, imagens e tempo real
supabase/functions/     função "equipe": criar conta e entrar por PIN
Dockerfile, deploy/     servidor nginx que gera o env.js na subida
```

O painel mora em `admin/index.html` para a URL ficar `/admin`, sem extensão.

## Testar agora (modo demonstração)

```bash
python -m http.server 5500
```

1. Abra `http://localhost:5500/admin` e toque em **Criar conta**: seu nome, um PIN e uma senha da equipe (na primeira conta, a senha digitada passa a ser a da equipe).
2. Em outra aba, abra `http://localhost:5500/?mesa=12`.
3. Segure o sino na aba da mesa: o chamado aparece no painel com som. Toque em “Estou indo” e veja a mesa atualizar.

Sem as variáveis do Supabase, os dados ficam no navegador e sincronizam só entre abas do mesmo aparelho.

## Colocar em produção — site do restaurante (EasyPanel + Supabase)

1. **Supabase**: crie um projeto, abra o *SQL Editor* e execute `supabase/schema.sql` (pode rodar de novo a cada atualização, sem erro).
2. **Função da equipe**: publique `supabase/functions/equipe` com a verificação de JWT desligada — ela faz a própria checagem (PIN, senha da equipe e sessão):

   ```bash
   supabase functions deploy equipe --no-verify-jwt --project-ref SEU-PROJETO
   ```

   Opcional, mas recomendado: em *Authentication › Sign In / Providers*, desative **Allow new users to sign up**. Mesmo sem isso, só quem está na equipe acessa os dados.
3. **EasyPanel › seu app › Source**: método de build **Dockerfile** (arquivo `Dockerfile` na raiz).
4. **EasyPanel › seu app › Environment**:

   ```
   SUPABASE_URL=https://SEU-PROJETO.supabase.co
   SUPABASE_ANON_KEY=sua-chave-anon-ou-publishable
   ```

   Os dois valores ficam no Supabase em *Project Settings › API* (“Project URL” e a chave `anon` / `publishable`). Essa chave é pública por natureza; a proteção vem das regras do `schema.sql`. **Nunca** use a chave `service_role` / `secret` aqui.
5. **EasyPanel › Domains**: porta do container **80**.
6. Faça o deploy. No log deve aparecer `env.js gerado (Supabase: configurado)`.
7. **Painel**: abra `/admin` e toque em **Criar conta**. A primeira conta define a senha da equipe; as próximas pessoas criam a conta delas com essa senha e depois entram só com o PIN. Preencha *Ajustes*. As plaquinhas são ligadas às mesas encostando o celular em cada uma (veja acima).

> **Atualizando uma instalação existente:** rode o `supabase/schema.sql` de novo **antes** de publicar o site novo. A página da mesa passa a chamar pelas funções `chamar()`/`sessao_*()` e o acesso direto do cliente à tabela de chamados é removido.

## Colocar em produção — central de plaquinhas (uma só, de vocês)

A pasta `central/` é um segundo app, independente dos restaurantes: o redirecionador (`/t/CODIGO`) e o painel interno para gerar, entregar, imprimir e gravar as plaquinhas.

1. **Supabase da central** (um projeto só de vocês, separado dos restaurantes): execute `central/schema.sql` no *SQL Editor*.
2. **Operadores:** em *Authentication › Users › Add user*, crie o usuário com e-mail e senha (marque *Auto confirm*). Depois, no SQL Editor:

   ```sql
   insert into public.operadores (user_id, nome)
   select id, 'Seu nome' from auth.users where email = 'voce@empresa.com';
   ```

   Recomendado: desative *Allow new users to sign up* nesse projeto.
3. **EasyPanel › novo app › Source**: Dockerfile em `central/Dockerfile`, com o contexto de build na **raiz** do repositório.
4. **Environment**: `SUPABASE_URL` e `SUPABASE_ANON_KEY` do Supabase **da central**.
5. **Domains**: o domínio fixo das plaquinhas (ex.: `tap.seudominio.com.br`), porta **80**. Esse domínio vai gravado em todas as plaquinhas: escolha um que vocês vão manter para sempre.
6. Abra o domínio, entre com o operador, cadastre o restaurante em *Restaurantes* (endereço do site dele) e use *Plaquinhas* para gerar, entregar, imprimir e gravar.

**O que a central tem:**

- *Visão geral*: leituras por dia (7, 30 ou 90 dias), ranking dos restaurantes mais acessados com a variação contra o período anterior, plaquinhas entregues que nunca foram lidas e alerta de restaurante parado há 7 dias ou mais.
- *Gerar lote* baixa na hora o **PDF para a gráfica**: uma plaquinha de 12 × 6 cm por página, cada uma com o QR e o código único dela (layout em `central/placa.js`; o @ e os textos ficam no topo desse arquivo). O mesmo PDF pode ser gerado de novo pela seleção (*PDF das plaquinhas*) ou para uma plaquinha só.
- *Plaquinhas*: gerar lote, entregar a um restaurante, devolver ao estoque, imprimir QR, imprimir etiquetas só com o código (para o verso), exportar CSV para a gráfica e gravar NFC.
- *Gravar NFC* (Chrome no Android): no modo **Ler o QR da plaquinha**, a câmera lê o QR impresso e o NFC recebe exatamente o mesmo código. Assim não tem como o NFC de uma plaquinha ficar diferente do QR dela.
- **Códigos nunca repetem**: o código é a chave primária da tabela `etiquetas`. O banco recusa fisicamente um segundo código igual, e o gerador só devolve códigos que conseguiu gravar. Gere sempre pela central (nunca numa planilha) e mande para a gráfica o CSV exportado.

Para testar localmente sem Supabase: `python -m http.server 5500` na raiz e abra `http://localhost:5500/central/` (o redirecionador fica em `/central/t.html?c=CODIGO`). Cadastre o restaurante com o endereço `http://localhost:5500`.

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
- As plaquinhas dependem do domínio da central estar no ar. Mantenham esse domínio e o app da central sempre ativos (custa praticamente nada: um nginx e um Supabase pequeno).
- Os nomes que os clientes digitam ficam só na tabela `sessoes`, que só a equipe lê.
- **Login por PIN**: cada pessoa tem um PIN único (4 a 8 números) e entra só com ele. O servidor bloqueia um aparelho por 15 minutos depois de 10 PINs errados e limita o total de tentativas; prefira PINs de 6 números. Quem sai da equipe é removido em *Ajustes › Restaurante › Equipe* e perde o acesso na hora.
- Criar conta exige a senha da equipe; trocar essa senha não desconecta ninguém.
- No modo demonstração, contas e PINs ficam guardados só no navegador.
