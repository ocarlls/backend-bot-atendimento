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
const teamId = process.env.SLACK_TEAM_ID;
var telegramChatId;
const telegramApiUrl = `https://api.telegram.org/bot${telegramToken}`;
var newChannelId;
var telegramUserName;
var telegramUserId;
  
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
  aguardandoAtendimento: { type: Boolean, default: false },
  atendenteId: { type: String, default: null } // Adicione isso
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
app.post('/dialogflow', async (req, res) => {
  if (!req.body || !req.body.queryResult) {
    return res.status(400).send('Requisição inválida para o Dialogflow.');
  }

  const agent = new WebhookClient({ request: req, response: res });
  
  // Extraia o ID do usuário do Telegram
  const telegramUserId = agent.originalRequest.payload.data.from.id; // O ID do usuário do Telegram
  telegramChatId = telegramUserId;
  const usuario = await Usuario.findOne({ telegramId: telegramUserId });
  const data = agent.originalRequest.payload.data;
  const userMessage = agent.query;
  
  console.log('debugggggggg', JSON.stringify(usuario));

  
  // Verifique se o usuário está aguardando atendimento
  if (usuario && usuario.aguardandoAtendimento) {
    console.log('Usuário aguardando atendimento, mensagem não processada.');
    // Enviar a mensagem para o Slack
    await sendSlackMessage(newChannelId, userMessage);
    // Retorna um status 200 e encerra a execução sem processar a intenção
    return res.status(200).send(); 
  }

  // Chame a função para lidar com as intenções
  await handleIntent(agent, res);
});

// Função para lidar com as intenções
async function handleIntent(agent, res) {
  // Mapeie intents para funções
  let intentMap = new Map();
  intentMap.set('atendimento-humano', atendimento);
  intentMap.set('consulta-status-de-pedido', consultaPedido);
  intentMap.set('consulta-preco-produto', consultaPrecoProduto);
  intentMap.set('consulta-funcionalidades-produto', consultaFuncionalidadesProduto);
  intentMap.set('consulta-condicoes-pagamento', consultaCondicoesPagamento);

  // Adicione lógica para tratar plataforma específica (Telegram)
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


// Função de atendimento ajustada para lidar com diferentes plataformas
async function atendimento(agent) {
  // Extraindo o ID do usuário do Telegram
  const data = agent.originalRequest.payload.data;
  
  if (data && data.from) {
      telegramUserId = data.from.id; // ID do usuário
      telegramUserName = data.from.first_name; // Nome do usuário
  }

  if (!telegramUserId) {
      console.error("Erro: Não foi possível obter o ID do usuário do Telegram.");
      agent.add('Desculpe, não conseguimos conectar com um atendente humano no momento.');
      return;
  }

  const userMessage = agent.query;

  // Verifica se o usuário já existe
  let usuario = await Usuario.findOne({ telegramId: telegramUserId });

  if (!usuario) {
      // Cria um novo usuário se não existir
      usuario = new Usuario({
          telegramId: telegramUserId,
          aguardandoAtendimento: true, // Atualize diretamente para aguardando
          atendenteId: null,
      });
      await usuario.save(); // Salva o novo usuário no banco
  } else {
      // Se já existe, apenas atualize o status
      usuario.aguardandoAtendimento = true; 
      await usuario.save(); // Atualiza o status para aguardando
  }

  agent.add('Você será atendido em breve. Aguardando conexão com um atendente humano.');

  const buttonValue = JSON.stringify({
      userName: telegramUserName,
      chatTelegramId: telegramChatId
  });

  // Envia mensagem para o Slack com o botão
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
  let payload;
  try {
    payload = JSON.parse(req.body.payload); // Parse do payload enviado pelo Slack
  } catch (error) {
    console.error('Erro ao fazer parse do payload:', error);
    return res.sendStatus(400);
  }

  const action = payload.actions[0]; // Ação disparada no Slack

  // Verificar a ação clicada
  if (action.action_id === 'acessar_novo_canal') {
    console.log('clicouuuuuuuuuuuuuuuuuuu');


    // Criar a URL do canal
    const channelLink = `<slack://channel?team=${teamId}&id=${newChannelId}>`;

    // Enviar mensagem personalizada para o usuário do Slack
    await slackClient.chat.postMessage({
      channel: slackChannelId, // ID do usuário do Slack que clicou no botão
      text: `Você está cuidando desse atendimento? continue o atendimento por aqui: ${channelLink}`
    });

    

    return res.send(200); // Responder ao Slack com mensagem personalizada
  }


  // Extraindo valores do botão, verificando se o valor é JSON
  let userId, userName, chatTelegramId;
  try {
    ({ userId, userName, chatTelegramId } = JSON.parse(action.value));
  } catch (error) {
    console.error('Erro ao decodificar o valor da ação:', error);
    return res.sendStatus(400);
  }

  // Verifica se a ação é a de atendimento
  if (action.name === 'atendimento_callback') {
    const telegramUserId = userId;  // O valor do Telegram User ID
    const userSlackId = payload.user.id; // ID do usuário do Slack
    const userSlackName = payload.user.name;

    // Criar canal e adicionar o atendente
    newChannelId = await criarCanalEAdicionarAtendente(userSlackId, userName, chatTelegramId, userSlackName);
    const newChannelLink = `<slack://channel?team=${teamId}&id=${newChannelId}>`;

    // Responder ao Slack que a ação foi concluída
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
      atendenteId: userSlackId // ID do atendente do Slack
    });


    return res.send({ text: 'Você está iniciando o atendimento no canal!' }); // Mensagem personalizada ao Slack
  }

  console.error('Action ID não reconhecido:', action.action_id);
  return res.sendStatus(400); // Resposta de erro
});

async function criarCanalEAdicionarAtendente(userSlackId, telegramUserName, chatTelegramId, userSlackName) {
  try {
    // Criação do canal
    const now = new Date();
    // Formatar a data e hora para um nome de canal válido
    const formattedDateTime = now.toISOString().replace(/T/, '-').replace(/:/g, '-').split('.')[0]; // YYYY-MM-DD-HH-MM-SS
    // Substituir caracteres especiais no nome do usuário e no nome do canal
    const safeUserName = userSlackName.replace(/[^a-z0-9]/g, '-').toLowerCase(); // Remove caracteres não permitidos
    const channelName = `atendimento-${formattedDateTime}-${safeUserName}`;
    
    const createChannelRes = await slackClient.conversations.create({
      name: channelName,  // Nome único do canal
      is_private: false,  // Público (se preferir privado, defina como true)
    });

    if (!createChannelRes.ok) {
      console.error('Erro ao criar o canal:', createChannelRes.error);
      return;
    }

    const newChannelId = createChannelRes.channel.id;
    console.log(`Novo canal criado com ID: ${newChannelId}`);

    // Adicionar o atendente (usuário do Slack que clicou no botão) ao novo canal
    const inviteRes = await slackClient.conversations.invite({
      channel: newChannelId,
      users: userSlackId,  // ID do usuário do Slack que clicou no botão
    });

    if (!inviteRes.ok) {
      console.error('Erro ao adicionar o usuário ao canal:', inviteRes.error);
      return;
    }

    sendTelegramMessage(chatTelegramId, `Olá ${telegramUserName}, eu sou o ${userSlackName} e estarei dando continuidade em seu atendimento!`);
    // Enviar mensagem para o novo canal
    const res = await slackClient.chat.postMessage({
      channel: newChannelId,
      text: `Usuário ${userSlackName} adicionado ao canal`,
    });
    
    await Usuario.updateOne({ telegramId: telegramUserId }, { 
      atendenteId: userSlackId // ID do atendente do Slack
    });

    console.log('Mensagem enviada com sucesso:', res.ts);

    return newChannelId;  // Retorna o ID do canal para possíveis usos futuros

  } catch (error) {
    console.error('Erro ao criar o canal ou adicionar o atendente:', error);
  }
}

app.post('/slack/events', async (req, res) => {
  const { type, event } = req.body;

  if (type === 'url_verification') {
    // O Slack envia uma verificação de URL quando você ativa os eventos
    return res.status(200).send(req.body.challenge);
  }

  if (event && event.type === 'message' && !event.subtype) {
    // Isso é uma mensagem que não é um subtipo (ou seja, uma mensagem normal)
    console.log(`Nova mensagem no canal ${event.channel}: ${event.text}, ${telegramChatId}`);

    // Verifique se a mensagem não começa com "Mensagem do Telegram:"
    if (event.channel === newChannelId && !event.text.startsWith('Mensagem do Telegram:')) {
      sendTelegramMessage(telegramChatId, event.text);
    }
  }

  // Responder com 200 para o Slack
  res.status(200).send();
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
