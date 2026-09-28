/*
 * Configuração do restaurante.
 * Este é o único arquivo que precisa ser editado para adaptar o template
 * a um novo restaurante: nome, Wi-Fi, mesas, cardápio e backend.
 */
window.NFC_CONFIG = {
  restaurante: {
    nome: 'Quintal Bistrô',
    descricao: 'Cozinha de brasa e horta',
    endereco: 'Rua dos Pinheiros, 412 — Pinheiros, São Paulo',
    mapsUrl: 'https://maps.google.com/?q=Rua+dos+Pinheiros+412+Sao+Paulo',
    instagram: 'quintalbistro',
    // Place ID do Google (https://developers.google.com/maps/documentation/places/web-service/place-id).
    // Vazio = abre uma busca pelo nome do restaurante no Google.
    googlePlaceId: '',
    // Taxa de serviço sugerida (%) usada na calculadora de divisão da conta.
    taxaServico: 10,
    // Dias: 0 = domingo ... 6 = sábado. Fechamento "00:00" ou depois da meia-noite é aceito.
    horarios: [
      { dias: [2, 3, 4], abre: '18:00', fecha: '23:30' },
      { dias: [5, 6], abre: '12:00', fecha: '00:30' },
      { dias: [0], abre: '12:00', fecha: '17:00' },
    ],
  },

  wifi: {
    rede: 'Quintal_Clientes',
    senha: 'brasaehorta',
    seguranca: 'WPA', // WPA | WEP | nopass
  },

  // Valores iniciais de mesas e widgets. Depois do primeiro uso, a equipe
  // edita isso pelo painel (abas "Mesas" e "Ajustes") — mexer aqui não
  // muda mais nada, pois o painel passa a guardar sua própria cópia.
  mesasPadrao: {
    total: 24,
    areas: [
      { nome: 'Salão', de: 1, ate: 14 },
      { nome: 'Varanda', de: 15, ate: 24 },
    ],
  },

  // tipo: 'cardapio' | 'wifi' | 'dividir' | 'google' | 'comentario' (embutidos,
  // só dá pra ativar/desativar e reordenar) ou 'link' (personalizado, a
  // equipe pode adicionar quantos quiser com título, ícone e URL próprios).
  widgetsPadrao: [
    { id: 'cardapio', tipo: 'cardapio', label: 'Cardápio', ativo: true, embutido: true },
    { id: 'wifi', tipo: 'wifi', label: 'Wi-Fi', ativo: true, embutido: true },
    { id: 'dividir', tipo: 'dividir', label: 'Dividir a conta', ativo: true, embutido: true },
    { id: 'google', tipo: 'google', label: 'Avaliar no Google', ativo: true, embutido: true },
    { id: 'comentario', tipo: 'comentario', label: 'Comentário anônimo', ativo: true, embutido: true },
  ],

  // Motivos de chamado exibidos para o cliente e para a equipe.
  motivos: [
    { id: 'atendimento', label: 'Atendimento', curto: 'Atendimento' },
    { id: 'pedido', label: 'Fazer pedido', curto: 'Pedido' },
    { id: 'conta', label: 'Fechar a conta', curto: 'Conta' },
    { id: 'agua', label: 'Água ou gelo', curto: 'Água/gelo' },
    { id: 'outro', label: 'Outro', curto: 'Outro' },
  ],
  pagamentos: ['Pix', 'Cartão', 'Dinheiro'],

  equipe: {
    // PIN do modo demonstração. Em produção use o modo Supabase (login com e-mail e senha).
    pin: '1234',
    // Minutos até o chamado ficar amarelo e vermelho no painel.
    alertaMin: [2, 5],
  },

  backend: {
    // 'local'    → demonstração: dados no navegador, sincroniza entre abas do mesmo aparelho.
    // 'supabase' → produção: tempo real entre o celular do cliente e o painel da equipe.
    tipo: 'local',
    supabaseUrl: '',
    supabaseAnonKey: '',
  },

  tags: {
    vegetariano: 'Vegetariano',
    vegano: 'Vegano',
    'sem-gluten': 'Sem glúten',
    picante: 'Picante',
    'sem-alcool': 'Sem álcool',
  },

  cardapio: [
    {
      id: 'comecar',
      nome: 'Para começar',
      itens: [
        { id: 'pao', nome: 'Pão de fermentação natural', desc: 'Manteiga de garrafa e flor de sal.', preco: 22, tags: ['vegetariano'] },
        { id: 'mandioca', nome: 'Mandioca na brasa', desc: 'Aioli de alho assado e salsinha.', preco: 34, tags: ['vegetariano', 'sem-gluten'] },
        { id: 'croquete', nome: 'Croquete de costela', desc: 'Seis unidades, maionese de pimenta-de-cheiro.', preco: 42, tags: ['picante'], destaque: true },
        { id: 'burrata', nome: 'Burrata da horta', desc: 'Tomates do quintal, pesto de rúcula e torrada.', preco: 58, tags: ['vegetariano'] },
      ],
    },
    {
      id: 'brasa',
      nome: 'Da brasa',
      itens: [
        { id: 'ancho', nome: 'Ancho 350 g', desc: 'Farofa de manteiga, vinagrete e chimichurri.', preco: 118, tags: ['sem-gluten'], destaque: true },
        { id: 'porco', nome: 'Barriga de porco laqueada', desc: 'Purê de abóbora cabotiá e couve crocante.', preco: 84, tags: [] },
        { id: 'peixe', nome: 'Peixe do dia na folha', desc: 'Assado em folha de bananeira, arroz de coco.', preco: 96, tags: ['sem-gluten'] },
        { id: 'couveflor', nome: 'Couve-flor inteira', desc: 'Tahine, castanha-de-caju e romã.', preco: 64, tags: ['vegano', 'sem-gluten'] },
      ],
    },
    {
      id: 'horta',
      nome: 'Da horta',
      itens: [
        { id: 'salada', nome: 'Folhas, figo e canastra', desc: 'Folhas do dia, figo grelhado e mel de engenho.', preco: 46, tags: ['vegetariano', 'sem-gluten'] },
        { id: 'arroz', nome: 'Arroz cremoso de cogumelos', desc: 'Shiitake, shimeji e parmesão curado.', preco: 68, tags: ['vegetariano'] },
      ],
    },
    {
      id: 'sobremesas',
      nome: 'Sobremesas',
      itens: [
        { id: 'pudim', nome: 'Pudim de doce de leite', desc: 'Calda de caramelo queimado.', preco: 28, tags: ['vegetariano', 'sem-gluten'], destaque: true },
        { id: 'abacaxi', nome: 'Abacaxi grelhado', desc: 'Sorvete de coco e hortelã.', preco: 32, tags: ['vegano', 'sem-gluten'] },
        { id: 'petit', nome: 'Petit gâteau de cupuaçu', desc: 'Sorvete de creme e castanha-do-pará.', preco: 36, tags: ['vegetariano'] },
      ],
    },
    {
      id: 'bebidas',
      nome: 'Bebidas',
      itens: [
        { id: 'limonada', nome: 'Limonada de capim-santo', desc: '400 ml.', preco: 16, tags: ['sem-alcool'] },
        { id: 'caipi', nome: 'Caipirinha de caju', desc: 'Cachaça de alambique mineira.', preco: 32, tags: [] },
        { id: 'chope', nome: 'Chope pilsen', desc: '300 ml.', preco: 18, tags: [] },
        { id: 'vinho', nome: 'Taça de vinho da casa', desc: 'Tinto ou branco — pergunte o rótulo da semana.', preco: 34, tags: [] },
        { id: 'agua', nome: 'Água mineral', desc: 'Com ou sem gás, 500 ml.', preco: 8, tags: ['sem-alcool'] },
      ],
    },
  ],
};
