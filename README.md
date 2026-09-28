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
  - *Restaurante*: logo, foto de capa, nome, frase curta, endereço, Instagram, link de avaliação do Google, taxa de serviço, Wi-Fi, horário de funcionamento e PIN da equipe (modo demonstração).
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
Dockerfile, deploy/     servidor nginx que gera o env.js na subida
```

O painel mora em `admin/index.html` para a URL ficar `/admin`, sem extensão.

## Testar agora (modo demonstração)

```bash
python -m http.server 5500
```

1. Abra `http://localhost:5500/admin`, entre com seu nome e o PIN `1234`.
2. Em outra aba, abra `http://localhost:5500/?mesa=12`.
3. Segure o sino na aba da mesa: o chamado aparece no painel com som. Toque em “Estou indo” e veja a mesa atualizar.

Sem as variáveis do Supabase, os dados ficam no navegador e sincronizam só entre abas do mesmo aparelho.

## Colocar em produção (EasyPanel + Supabase)

1. **Supabase**: crie um projeto, abra o *SQL Editor* e execute `supabase/schema.sql` (pode rodar de novo a cada atualização, sem erro).
2. **Equipe**: em *Authentication › Users*, crie um usuário por funcionário (ou um compartilhado para o tablet do balcão). Em *Authentication › Sign In / Providers*, **desative novos cadastros** — qualquer usuário autenticado edita o restaurante e vê os chamados.
3. **EasyPanel › seu app › Source**: método de build **Dockerfile** (arquivo `Dockerfile` na raiz).
4. **EasyPanel › seu app › Environment**:

   ```
   SUPABASE_URL=https://SEU-PROJETO.supabase.co
   SUPABASE_ANON_KEY=sua-chave-anon-ou-publishable
   ```

   Os dois valores ficam no Supabase em *Project Settings › API* (“Project URL” e a chave `anon` / `publishable`). Essa chave é pública por natureza; a proteção vem das regras do `schema.sql`. **Nunca** use a chave `service_role` / `secret` aqui.
5. **EasyPanel › Domains**: porta do container **80**.
6. Faça o deploy. No log deve aparecer `env.js gerado (Supabase: configurado)`.
7. **Painel**: entre em `/admin` com o e-mail e a senha criados no passo 2, preencha *Ajustes* e grave as plaquinhas em *Mesas* (NTAG213/215). Depois de testar, bloqueie as etiquetas contra regravação.

## Personalizar a aparência

Cores e fontes estão nos tokens do topo de `assets/css/base.css` (`--cobalt` é a cor da placa, `--brass` a do sino).

## Observações

- O link de avaliação do Google aparece para todos os clientes, independentemente da nota dada no comentário anônimo. Mostrar o Google só para quem deu nota alta viola as políticas de avaliações do Google.
- O cliente anônimo consegue ler chamados das últimas 3 horas (necessário para acompanhar o status em tempo real). Eles contêm apenas mesa, motivo e itens — nenhum dado pessoal.
- A senha do Wi-Fi fica visível para quem abre a página da mesa, como numa plaquinha impressa.
- Qualquer pessoa que conheça o link de uma mesa consegue chamar por ela. O `schema.sql` limita a 5 chamados por mesa a cada 2 minutos; para mais proteção, grave nas etiquetas um token por mesa e valide-o no banco.
- No modo demonstração o PIN fica guardado no navegador. Com o Supabase conectado, o login é por e-mail e senha.
