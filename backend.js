require('dotenv').config();
const express = require('express');
const { WebhookClient } = require('dialogflow-fulfillment');
const mongoose = require('mongoose');
const axios = require('axios');
const { WebClient } = require('@slack/web-api');
const bodyParser = require('body-parser');
const Fuse = require('fuse.js');

const app = express();

// Carregar segredos do arquivo .env
const slackToken = process.env.SLACK_TOKEN;
const slackClient = new WebClient(slackToken);
const slackChannelId = process.env.SLACK_CHANNEL_ID;
const telegramToken = process.env.TELEGRAM_TOKEN;
const telegramApiUrl = `https://api.telegram.org/bot${telegramToken}`;

// Middleware para parsing de JSON e URL encoded
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Conexão ao MongoDB com URI do .env
mongoose.connect(process.env.MONGO_URI);


const db = mongoose.connection;
db.on('error', console.error.bind(console, 'Erro de conexão ao MongoDB:'));
db.once('open', () => {
  console.log('Conectado ao MongoDB');
});

// Modelos de Produto, Pedido e Usuario
const produtoSchema = new mongoose.Schema({
  nome: String,
  preco: Number,
  funcionalidades: [String]
});

const Produto = mongoose.model('Produto', produtoSchema);

const pedidoSchema = new mongoose.Schema({
  pedidoId: String,
  status: String,
  dataCriacao: Date
});

const Pedido = mongoose.model('Pedido', pedidoSchema);

const usuarioSchema = new mongoose.Schema({
  telegramId: String,
  aguardandoAtendimento: { type: Boolean, default: false }
});

const Usuario = mongoose.model('Usuario', usuarioSchema);

// Cache
let produtosCache = [];
let pedidosCache = [];

// Função para carregar dados do MongoDB para cache
async function carregarDados() {
  try {
    produtosCache = await Produto.find({}).lean();
    pedidosCache = await Pedido.find({}).lean();
    console.log('Dados de produtos e pedidos carregados no cache.');
    atualizarFuse();
  } catch (error) {
    console.error('Erro ao carregar dados do MongoDB:', error);
  }
}
carregarDados();

let fuse;
function atualizarFuse() {
  const fuseOptions = {
    keys: ['nome'],
    threshold: 0.4,
    ignoreLocation: true,
    distance: 100,
    isCaseSensitive: false,
  };
  fuse = new Fuse(produtosCache, fuseOptions);
}
atualizarFuse();

function sanitizeInput(input) {
  return input.trim().toLowerCase();
}

const metodosPagamento = [
  { tipo: 'Cartão de crédito', descricao: 'Parcelamos em até 12x sem juros.' },
  { tipo: 'Boleto bancário', descricao: 'Pagamento à vista com 5% de desconto.' },
  { tipo: 'Pix', descricao: 'Transferência instantânea com 10% de desconto.' },
  { tipo: 'Cartão de débito', descricao: 'Pagamento à vista sem desconto.' }
];

// Rota para tratar requisições do Dialogflow
app.post('/dialogflow', (req, res) => {
  //nsole.log("Requisição recebida do Dialogflow:", req.body);
  
  if (!req.body || !req.body.queryResult) {
    return res.status(400).send('Requisição inválida para o Dialogflow.');
  }

  const agent = new WebhookClient({ request: req, response: res });

  // Verificar de qual plataforma a requisição está vindo (Telegram, no seu caso)
  const requestSource = agent.requestSource;

  // Mapear intents para funções
  let intentMap = new Map();
  intentMap.set('atendimento-humano', atendimento);
  intentMap.set('consulta-status-de-pedido', consultaPedido);
  intentMap.set('consulta-preco-produto', consultaPrecoProduto);
  intentMap.set('consulta-funcionalidades-produto', consultaFuncionalidadesProduto);
  intentMap.set('consulta-condicoes-pagamento', consultaCondicoesPagamento);

  // Adicionar lógica para tratar plataforma específica (Telegram)
  agent.handleRequest(intentMap);
});

// Função de atendimento ajustada para lidar com diferentes plataformas
async function atendimento(agent) {
  const requestSource = agent.requestSource;

  // Log para inspecionar a estrutura do payload
  console.log("Original Request Payload:", agent.originalRequest);

  let telegramUserId;

  // Verificar se é uma mensagem ou uma interação de callback
  if (agent.originalRequest.payload && agent.originalRequest.payload.data) {
    if (agent.originalRequest.payload.data.from) {
      // Caso seja uma mensagem escrita
      telegramUserId = agent.originalRequest.payload.data.from.id;
    } else if (agent.originalRequest.payload.data.callback_query) {
      // Caso seja um callback de botão rich text
      telegramUserId = agent.originalRequest.payload.data.callback_query.from.id;
    }
  }

  // Verificar se o ID do usuário foi obtido corretamente
  if (!telegramUserId) {
    console.error("Erro: Não foi possível obter o ID do usuário do Telegram.");
    agent.add('Desculpe, não conseguimos conectar com um atendente humano no momento.');
    return;
  }

  const userMessage = agent.query;

  if (requestSource === 'TELEGRAM') {
    await sendTelegramMessage(telegramUserId, 'Um atendente humano foi solicitado. Por favor, aguarde enquanto alguém te atende.');
    agent.add('Você será atendido em breve. Aguardando conexão com um atendente humano.');
  } else {
    agent.add('Estamos processando seu atendimento. Por favor, aguarde.');
  }

  await slackClient.chat.postMessage({
    channel: slackChannelId,
    text: `Novo atendimento solicitado no Telegram.`,
    attachments: [
      {
        text: `Mensagem do usuário: "${userMessage}". Para responder, clique no botão abaixo:`,
        callback_id: 'atendimento_callback',
        actions: [
          {
            type: 'button',
            text: 'Iniciar atendimento',
            value: telegramUserId,
            name: 'atendimento_callback',
            action_id: 'atendimento_callback',
          }
        ]
      }
    ]
  }).catch(error => {
    console.error('Erro ao enviar mensagem para o Slack:', error);
    agent.add('Desculpe, não conseguimos conectar com um atendente humano no momento.');
  });
}


// Função para consultar status de pedido
function consultaPedido(agent) {
  const pedidoId = agent.parameters.pedidoId;
  if (pedidoId === "") {
    const ultimoPedido = pedidosCache.sort((a, b) => new Date(b.dataCriacao) - new Date(a.dataCriacao))[0];
    agent.add(`Seu último pedido é o pedido #${ultimoPedido.pedidoId} e o status é: ${ultimoPedido.status}`);
  } else {
    const pedido = pedidosCache.find(p => p.pedidoId == pedidoId);
    if (pedido) {
      agent.add(`O status do seu pedido #${pedidoId} é: ${pedido.status}`);
    } else {
      agent.add(`Não encontramos o pedido #${pedidoId}. Verifique o número e tente novamente.`);
    }
  }
}

// Função para consultar preço de produto
function consultaPrecoProduto(agent) {
  const produtoNome = sanitizeInput(agent.parameters.produto);
  console.log("Produto buscado (sanitizado):", produtoNome);
  const resultados = fuse.search(produtoNome);
  console.log("Resultados da busca:", resultados);
  if (resultados.length > 0) {
    const produto = resultados[0].item;
    agent.add(`O preço do ${produto.nome} é R$${produto.preco}.`);
  } else {
    agent.add(`Desculpe, não encontrei o produto "${produtoNome}".`);
  }
}

// Função para consultar funcionalidades de produto
function consultaFuncionalidadesProduto(agent) {
  const produtoNome = agent.parameters.produto;
  const resultados = fuse.search(produtoNome);
  if (resultados.length > 0) {
    const produto = resultados[0].item;
    agent.add(`O ${produto.nome} tem as seguintes funcionalidades: ${produto.funcionalidades.join(', ')}.`);
  } else {
    agent.add(`Desculpe, não encontrei nenhum produto correspondente a "${produtoNome}".`);
  }
}

// Função para consultar condições de pagamento
function consultaCondicoesPagamento(agent) {
  const metodos = metodosPagamento.map(m => `${m.tipo}: ${m.descricao}`);
  agent.add(`Oferecemos as seguintes condições de pagamento:\n`);
  metodos.forEach((element) => agent.add(element));
}

// Rota para tratar ações do Slack
app.post('/slack/actions', async (req, res) => {
  //console.log("Requisição recebida do Slack:", req.body);
  
  console.log('Payload recebido:', req.body);
  
  let payload;
  try {
    payload = JSON.parse(req.body.payload); // Parse do payload enviado pelo Slack
  } catch (error) {
    console.error('Erro ao fazer parse do payload:', error);
    return res.sendStatus(400);
  }

  const action = payload.actions[0]; // Ação disparada no Slack
  console.log(action);
  if (action.name == 'atendimento_callback') {
    const telegramUserId = action.value;  // O valor do Telegram User ID

    // Enviar mensagem ao Telegram dizendo que o atendente está disponível
    await sendTelegramMessage(telegramUserId, 'Um atendente está disponível para você!');

    // Responder ao Slack que a ação foi concluída
    res.send({ text: 'Você está iniciando o atendimento!' });

    // Agora o atendente pode iniciar o atendimento diretamente no Telegram
  } else {
    console.error('Action ID não reconhecido:', action.action_id);
    res.sendStatus(400);
  }
});

// Função para resetar o status de aguardando atendimento
async function resetarStatusAtendimento(telegramUserId) {
  try {
    const resultado = await Usuario.findOneAndUpdate(
      { telegramId: telegramUserId },
      { aguardandoAtendimento: false },
      { new: true }
    );

    if (resultado) {
      console.log(`Status do atendimento para o usuário ${telegramUserId} foi resetado.`);
    } else {
      console.log(`Usuário ${telegramUserId} não encontrado para resetar o status.`);
    }
  } catch (error) {
    console.error('Erro ao resetar status de atendimento:', error);
  }
}

// Função para enviar mensagem via Telegram
// Função para enviar mensagem via Telegram
async function sendTelegramMessage(chatId, text) {
  try {
    await axios.post(`${telegramApiUrl}/sendMessage`, {
      chat_id: chatId,
      text: text
    });
  } catch (error) {
    console.error('Erro ao enviar mensagem para o Telegram:', error);
  }
}

// Inicialização do servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
