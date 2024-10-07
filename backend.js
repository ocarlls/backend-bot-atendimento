require('dotenv').config();
const express = require('express');
const { WebhookClient } = require('dialogflow-fulfillment');
const mongoose = require('mongoose');
const axios = require('axios');
const { WebClient } = require('@slack/web-api');
const bodyParser = require('body-parser');
const Fuse = require('fuse.js');

const app = express();

const slackToken = process.env.SLACK_TOKEN;
const slackClient = new WebClient(slackToken);
const slackChannelId = process.env.SLACK_CHANNEL_ID;
const telegramToken = process.env.TELEGRAM_TOKEN;
const teamId = process.env.SLACK_TEAM_ID;
var telegramChatId;
const telegramApiUrl = `https://api.telegram.org/bot${telegramToken}`;
var newChannelId;
var telegramUserName;
var telegramUserId;
  
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

mongoose.connect(process.env.MONGO_URI);


const db = mongoose.connection;
db.on('error', console.error.bind(console, 'Erro de conexão ao MongoDB:'));
db.once('open', () => {
  console.log('Conectado ao MongoDB');
});

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
  aguardandoAtendimento: { type: Boolean, default: false },
  atendenteId: { type: String, default: null } 
});

const Usuario = mongoose.model('Usuario', usuarioSchema);

let produtosCache = [];
let pedidosCache = [];

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

app.post('/dialogflow', async (req, res) => {
  if (!req.body || !req.body.queryResult) {
    return res.status(400).send('Requisição inválida para o Dialogflow.');
  }
  
  const agent = new WebhookClient({ request: req, response: res });
  console.log('aaaaaaaaa', agent.originalRequest.payload.data);
  if (agent.originalRequest.payload.data.callback_query) {
    console.log('Requisição de callback query');
    telegramUserId = agent.originalRequest.payload.data.callback_query.from.id;
    telegramUserName = agent.originalRequest.payload.data.callback_query.from.first_name; 
  } else if (agent.originalRequest.payload.data && agent.originalRequest.payload.data.from) {
    console.log('Requisição de mensagem normal');
    telegramUserId = agent.originalRequest.payload.data.from.id;
    telegramUserName = agent.originalRequest.payload.data.from.first_name; 
    
  } else {
    return res.status(400).send('Requisição sem dados de usuário.');
  }  
  telegramChatId = telegramUserId;
  const usuario = await Usuario.findOne({ telegramId: telegramUserId });
  const data = agent.originalRequest.payload.data;
  const userMessage = agent.query;
  
  if (usuario && usuario.aguardandoAtendimento) {
    console.log('Usuário aguardando atendimento, mensagem não processada.');
    await sendSlackMessage(newChannelId, userMessage);
    return res.status(200).send(); 
  }

  await handleIntent(agent, res);
});

async function handleIntent(agent, res) {
  let intentMap = new Map();
  intentMap.set('atendimento-humano', atendimento);
  intentMap.set('consulta-status-de-pedido', consultaPedido);
  intentMap.set('consulta-preco-produto', consultaPrecoProduto);
  intentMap.set('consulta-funcionalidades-produto', consultaFuncionalidadesProduto);
  intentMap.set('consulta-condicoes-pagamento', consultaCondicoesPagamento);

  await agent.handleRequest(intentMap);
}

async function sendSlackMessage(channelId, messageText) {
  try {
    await slackClient.chat.postMessage({
      channel: channelId,
      text: `Mensagem do Telegram: ${messageText}`,
    });
  } catch (error) {
    console.error('Erro ao enviar mensagem para o Slack:', error);
  }
}


async function atendimento(agent) {
  const data = agent.originalRequest.payload.data;

  if (!telegramUserId) {
      console.error("Erro: Não foi possível obter o ID do usuário do Telegram.");
      agent.add('Desculpe, não conseguimos conectar com um atendente humano no momento.');
      return;
  }

  const userMessage = agent.query;

  let usuario = await Usuario.findOne({ telegramId: telegramUserId });

  if (!usuario) {
      usuario = new Usuario({
          telegramId: telegramUserId,
          aguardandoAtendimento: true,
          atendenteId: null,
      });
      await usuario.save(); 
  } else {
      usuario.aguardandoAtendimento = true; 
      await usuario.save(); 
  }

  agent.add('Você será atendido em breve. Aguardando conexão com um atendente humano.');

  const buttonValue = JSON.stringify({
      userName: telegramUserName,
      chatTelegramId: telegramChatId
  });

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
                      value: buttonValue,
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

function consultaCondicoesPagamento(agent) {
  const metodos = metodosPagamento.map(m => `${m.tipo}: ${m.descricao}`);
  agent.add(`Oferecemos as seguintes condições de pagamento:\n`);
  metodos.forEach((element) => agent.add(element));
}

app.post('/slack/actions', async (req, res) => {
  let payload;
  try {
    payload = JSON.parse(req.body.payload);
  } catch (error) {
    console.error('Erro ao fazer parse do payload:', error);
    return res.sendStatus(400);
  }

  const action = payload.actions[0];

  if (action.action_id === 'acessar_novo_canal') {
    console.log('clicouuuuuuuuuuuuuuuuuuu');


    const channelLink = `<slack://channel?team=${teamId}&id=${newChannelId}>`;

    await slackClient.chat.postMessage({
      channel: slackChannelId, 
      text: `Você está cuidando desse atendimento? continue o atendimento por aqui: ${channelLink}`
    });

    

    return res.send(200);
  }


  let userId, userName, chatTelegramId;
  try {
    ({ userId, userName, chatTelegramId } = JSON.parse(action.value));
  } catch (error) {
    console.error('Erro ao decodificar o valor da ação:', error);
    return res.sendStatus(400);
  }

  if (action.name === 'atendimento_callback') {
    const telegramUserId = userId;  // O valor do Telegram User ID
    const userSlackId = payload.user.id; // ID do usuário do Slack
    const userSlackName = payload.user.name;

    newChannelId = await criarCanalEAdicionarAtendente(userSlackId, userName, chatTelegramId, userSlackName);
    const newChannelLink = `<slack://channel?team=${teamId}&id=${newChannelId}>`;

    await slackClient.chat.postMessage({
      channel: slackChannelId,
      text: `Usuário ${userSlackName} foi adicionado ao canal.`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Acessar o novo canal => "
          },
          accessory: {
            type: "button",
            text: {
              type: "plain_text",
              text: "Acessar",
              emoji: true
            },
            style: "primary",
            value: newChannelLink,
            action_id: "acessar_novo_canal"
          }
        }
      ]
    });
    await Usuario.updateOne({ telegramId: telegramUserId }, { 
      aguardandoAtendimento: true,
      atendenteId: userSlackId
    });


    return res.send({ text: 'Você está iniciando o atendimento no canal!' });
  }

  console.error('Action ID não reconhecido:', action.action_id);
  return res.sendStatus(400); 
});

async function criarCanalEAdicionarAtendente(userSlackId, telegramUserName, chatTelegramId, userSlackName) {
  try {
    // Criação do canal
    const now = new Date();
    const formattedDateTime = now.toISOString().replace(/T/, '-').replace(/:/g, '-').split('.')[0]; // YYYY-MM-DD-HH-MM-SS
    const safeUserName = userSlackName.replace(/[^a-z0-9]/g, '-').toLowerCase(); // Remove caracteres não permitidos
    const channelName = `atendimento-${formattedDateTime}-${safeUserName}`;
    
    const createChannelRes = await slackClient.conversations.create({
      name: channelName,  
      is_private: false,  
    });

    if (!createChannelRes.ok) {
      console.error('Erro ao criar o canal:', createChannelRes.error);
      return;
    }

    const newChannelId = createChannelRes.channel.id;
    console.log(`Novo canal criado com ID: ${newChannelId}`);

    const inviteRes = await slackClient.conversations.invite({
      channel: newChannelId,
      users: userSlackId,  
    });

    if (!inviteRes.ok) {
      console.error('Erro ao adicionar o usuário ao canal:', inviteRes.error);
      return;
    }

    sendTelegramMessage(chatTelegramId, `Olá ${telegramUserName}, eu sou o ${userSlackName} e estarei dando continuidade em seu atendimento!`);
    const res = await slackClient.chat.postMessage({
      channel: newChannelId,
      text: `Usuário ${userSlackName} adicionado ao canal`,
    });
    
    await Usuario.updateOne({ telegramId: telegramUserId }, { 
      atendenteId: userSlackId
    });

    console.log('Mensagem enviada com sucesso:', res.ts);

    return newChannelId;  

  } catch (error) {
    console.error('Erro ao criar o canal ou adicionar o atendente:', error);
  }
}

app.post('/slack/events', async (req, res) => {
  const { type, event } = req.body;

  if (type === 'url_verification') {
    return res.status(200).send(req.body.challenge);
  }

  if (event && event.type === 'message' && !event.subtype) {
    console.log(`Nova mensagem no canal ${event.channel}: ${event.text}, ${telegramChatId}`);

    if (event.channel === newChannelId && !event.text.startsWith('Mensagem do Telegram:')) {
      sendTelegramMessage(telegramChatId, event.text);
    }
  }

  res.status(200).send();
});

app.post('/slack/encerrar', async (req, res) => {
  const { text, user_id, channel_id } = req.body;

  if (text.trim() !== '') {
    return res.status(200).send('Comando incorreto. Use apenas /encerrar');
  }

  try {
    const usuario = await Usuario.findOne({ atendenteId: user_id, aguardandoAtendimento: true });

    if (!usuario) {
      return res.status(200).send('Nenhum atendimento em andamento para encerrar.');
    }

    usuario.aguardandoAtendimento = false;
    await usuario.save();

    await slackClient.conversations.archive({ channel: channel_id });
    sendTelegramMessage(telegramUserId, 'Atendimento encerrado. Obrigado pelo seu contato!');
    
    return res.status(200).send('Atendimento encerrado e canal arquivado com sucesso.');
  } catch (error) {
    console.error('Erro ao encerrar atendimento:', error);
    return res.status(500).send('Erro ao encerrar atendimento.');
  }
});


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
