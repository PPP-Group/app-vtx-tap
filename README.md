# Plataforma NFC para restaurantes

Template de página de mesa acionada por plaquinha NFC, com painel da equipe em tempo real.

O cliente encosta o celular na plaquinha da mesa e abre uma página com:

- **Chamar garçom**: escolhe o motivo (atendimento, pedido, conta, água, outro) e segura o sino por 1 segundo. Segurar em vez de tocar evita chamados acidentais. O cliente acompanha o status: *Enviado → Fulano está a caminho → Atendido*.
- **Cardápio** com busca, categorias fixas no topo e selos (vegetariano, sem glúten…). O cliente monta uma lista e chama o garçom com ela.
- **Wi-Fi**: rede, senha com botão de copiar e QR para conectar outro celular.
- **Dividir a conta** com taxa de serviço.
- **Avaliar no Google** (link direto para a avaliação).
- **Comentário anônimo**: estrelas, marcações e texto, sem pedir nome, e-mail ou telefone.

O **painel da equipe** (`admin.html`) funciona no celular (abas embaixo) e no desktop (menu lateral):

- **Chamados** em tempo real, com sino sonoro, vibração, notificação do sistema e cronômetro que fica amarelo e vermelho conforme o tempo passa.
- **Salão**: mapa das mesas com quem está chamando.
- **Comentários**: nota média, distribuição e marcações mais citadas.
- **Mesas**: quantidade de mesas e áreas do salão (editável ali, sem mexer em código), link de cada mesa, QR para imprimir e gravação direta da etiqueta NFC (Chrome no Android).
- **Ajustes**: quais widgets aparecem na página da mesa (dá pra desativar qualquer um, reordenar, ou adicionar um link personalizado — cardápio de vinhos, delivery, avaliação no iFood…), som, lembrete de atrasados, notificações, manter a tela ligada e tema escuro.

## Estrutura

```
index.html              página da mesa (cliente)  →  index.html?mesa=12
admin.html              painel da equipe
assets/js/config.js     ← edite aqui: nome, Wi-Fi, cardápio, backend (ponto de partida)
assets/js/store.js      dados: modo demonstração (local) ou Supabase — também guarda mesas e widgets
assets/js/ui.js         utilitários, ícones e folhas deslizantes
assets/js/cliente.js    lógica da página da mesa
assets/js/admin.js      lógica do painel
assets/css/             base.css (tokens e componentes), cliente.css, admin.css
supabase/schema.sql     tabelas, segurança e tempo real para produção
```

Não há etapa de build: são arquivos estáticos.

## Testar agora (modo demonstração)

```bash
python -m http.server 5500
```

1. Abra `http://localhost:5500/admin.html`, entre com seu nome e o PIN `1234`.
2. Em outra aba, abra `http://localhost:5500/index.html?mesa=12`.
3. Segure o sino na aba da mesa: o chamado aparece no painel com som. Toque em “Estou indo” e veja a mesa atualizar.

No modo demonstração os dados ficam no navegador e sincronizam só entre abas do mesmo aparelho. O painel tem um botão “Simular chamado” para testes.

## Colocar em produção

1. **Supabase**: crie um projeto, abra o *SQL Editor* e execute `supabase/schema.sql`.
2. **Equipe**: em *Authentication › Users*, crie um usuário por funcionário (ou um compartilhado para o tablet do balcão). Em *Authentication › Sign In / Providers*, **desative novos cadastros** — qualquer usuário autenticado vê os chamados e comentários.
3. **Config**: em `assets/js/config.js`, preencha `backend` com `tipo: 'supabase'`, a URL do projeto e a chave *anon/publishable* (ela é pública por natureza; a proteção vem das regras RLS do `schema.sql`).
4. **Hospedagem**: publique a pasta em qualquer host estático com HTTPS (Netlify, Vercel, Cloudflare Pages, GitHub Pages). HTTPS é obrigatório para NFC, notificações e manter a tela ligada.
5. **Mesas**: no painel, em *Mesas*, ajuste a quantidade e as áreas do salão, confirme o link base e grave cada etiqueta (NTAG213/215). Depois de testar, bloqueie as etiquetas contra regravação.

## Personalizar

- **Quantidade de mesas, áreas do salão e widgets da página da mesa**: pelo próprio painel (abas *Mesas* e *Ajustes*), sem mexer em código. Isso é o que muda o tempo todo no dia a dia do restaurante.
- **Restaurante, Wi-Fi, horários e cardápio**: em `config.js`. `mesasPadrao` e `widgetsPadrao`, nesse arquivo, só valem na primeira vez que o painel abre — depois disso a equipe edita pelo painel e o arquivo deixa de ser lido para isso.
- **Google**: preencha `googlePlaceId` para abrir direto a tela de avaliação.
- **Cores e fontes**: tokens no topo de `assets/css/base.css` (`--cobalt` é a cor da placa, `--brass` a do sino).

## Observações

- O link de avaliação do Google aparece para todos os clientes, independentemente da nota dada no comentário anônimo. Mostrar o Google só para quem deu nota alta viola as políticas de avaliações do Google.
- O cliente anônimo consegue ler chamados das últimas 3 horas (necessário para acompanhar o status em tempo real). Eles contêm apenas mesa, motivo e itens — nenhum dado pessoal.
- Qualquer pessoa que conheça o link de uma mesa consegue chamar por ela. O `schema.sql` limita a 5 chamados por mesa a cada 2 minutos; para mais proteção, grave nas etiquetas um token por mesa e valide-o no banco.
- O PIN do modo demonstração fica visível no código. Em produção o login é feito pelo Supabase Auth.
