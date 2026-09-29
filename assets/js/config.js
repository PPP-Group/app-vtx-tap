/*
 * Dados iniciais de demonstração.
 * Na primeira vez que o painel abre, estes valores são copiados para o banco;
 * a partir daí tudo (restaurante, logo, capa, Wi-Fi, horários, cardápio, mesas
 * e widgets) é editado pelo painel da equipe, em Ajustes e Mesas.
 */
(function () {
const env = window.NFC_ENV || {};

// quintal.vortexsystems.tech → "quintal". Para testar sem subdomínio (ou no
// endereço provisório do EasyPanel): ?r=quintal, que fica lembrado neste aparelho.
function slugDoEndereco(base) {
  const host = location.hostname.toLowerCase();
  base = String(base || '').toLowerCase().replace(/^\.+|\.+$/g, '');
  if (base && host.endsWith('.' + base)) {
    const s = host.slice(0, -(base.length + 1));
    if (s && !s.includes('.')) return s;
  }
  const p = new URLSearchParams(location.search).get('r');
  try {
    if (p) localStorage.setItem('nfc-restaurante', p.toLowerCase());
    return (p || localStorage.getItem('nfc-restaurante') || '').toLowerCase();
  } catch {
    return (p || '').toLowerCase();
  }
}
window.NFC_CONFIG = {
  restaurante: {
    nome: 'Quintal Bistrô',
    descricao: 'Cozinha de brasa e horta',
    endereco: 'Rua dos Pinheiros, 412 — Pinheiros, São Paulo',
    instagram: 'quintalbistro',
    telefone: '11987654321',
    // Link "Pedir avaliações" do Perfil da Empresa no Google. Vazio = busca pelo nome.
    googleUrl: 'https://www.google.com/search?q=Quintal+Bistr%C3%B4+avalia%C3%A7%C3%B5es',
    logo: '',
    capa: '',
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

  mesasPadrao: {
    total: 24,
    areas: [
      { nome: 'Salão', de: 1, ate: 14 },
      { nome: 'Varanda', de: 15, ate: 24 },
    ],
  },

  // Embutidos (cardapio, wifi, dividir, google, comentario) ou 'link' personalizado.
  widgetsPadrao: [
    { id: 'cardapio', tipo: 'cardapio', label: 'Cardápio', ativo: true, embutido: true },
    { id: 'wifi', tipo: 'wifi', label: 'Wi-Fi', ativo: true, embutido: true },
    { id: 'dividir', tipo: 'dividir', label: 'Dividir a conta', ativo: true, embutido: true },
    { id: 'google', tipo: 'google', label: 'Avaliar no Google', ativo: true, embutido: true },
    { id: 'comentario', tipo: 'comentario', label: 'Comentário anônimo', ativo: true, embutido: true },
    { id: 'info', tipo: 'info', label: 'Informações do restaurante', ativo: true, embutido: true },
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
    // Minutos até o chamado ficar amarelo e vermelho no painel.
    alertaMin: [2, 5],
  },

  // Vem das variáveis de ambiente do servidor (env.js). Sem elas: modo demonstração.
  backend: {
    tipo: env.SUPABASE_URL && env.SUPABASE_ANON_KEY ? 'supabase' : 'local',
    supabaseUrl: env.SUPABASE_URL || '',
    supabaseAnonKey: env.SUPABASE_ANON_KEY || '',
    // Restaurante deste endereço: o subdomínio (quintal.vortexsystems.tech → "quintal").
    slug: slugDoEndereco(env.BASE_DOMAIN),
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
})();
