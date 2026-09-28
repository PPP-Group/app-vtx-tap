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
- **Mesas**: quantidade de mesas, áreas do salão, link de cada mesa, QR para imprimir e gravação direta da etiqueta NFC (Chrome no Android).
- **Ajustes**
  - *Restaurante*: logo, foto de capa, nome, frase curta, endereço, Instagram, link de avaliação do Google, taxa de serviço, Wi-Fi, horário de funcionamento e a equipe (quem tem conta, remover pessoas, trocar a senha da equipe).
  - *Cardápio*: categorias e pratos (nome, descrição, preço, selos, destaque da casa), com ordem ajustável.
  - *Widgets*: o que aparece na página da mesa e em que ordem.
  - *Aparelho*: som, lembrete de atrasados, notificações, manter a tela ligada e tema (claro por padrão).

Tudo o que muda no dia a dia do restaurante é editado no painel. O código não precisa ser alterado para adaptar a plataforma a um novo restaurante.

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

## Colocar em produção (EasyPanel + Supabase)

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
7. **Painel**: abra `/admin` e toque em **Criar conta**. A primeira conta define a senha da equipe; as próximas pessoas criam a conta delas com essa senha e depois entram só com o PIN. Preencha *Ajustes* e grave as plaquinhas em *Mesas* (NTAG213/215). Depois de testar, bloqueie as etiquetas contra regravação.

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
- Qualquer pessoa que conheça o link de uma mesa consegue chamar por ela. O `schema.sql` limita a 5 chamados por mesa a cada 2 minutos; para mais proteção, grave nas etiquetas um token por mesa e valide-o no banco.
- **Login por PIN**: cada pessoa tem um PIN único (4 a 8 números) e entra só com ele. O servidor bloqueia um aparelho por 15 minutos depois de 10 PINs errados e limita o total de tentativas; prefira PINs de 6 números. Quem sai da equipe é removido em *Ajustes › Restaurante › Equipe* e perde o acesso na hora.
- Criar conta exige a senha da equipe; trocar essa senha não desconecta ninguém.
- No modo demonstração, contas e PINs ficam guardados só no navegador.
