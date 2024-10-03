const express = require('express');
const app = express();
const { WebhookClient } = require('dialogflow-fulfillment');
var bodyParser = require('body-parser');

app.use(express.static("public"));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended:true}));

const pedidos = [ 
  { pedidoId: "123", status: "Enviado" },
  { pedidoId: "456", status: "Processando" },
  { pedidoId: "789", status: "Entregue" }
];

// Endpoint que recebe as solicitações do Dialogflow
app.post('/dialogflow', (req, res) => {
    const agent = new WebhookClient({request: req, response: res});
    let intentMap = new Map();
    intentMap.set('consulta-status-de-pedido', consultaPedido);
    agent.handleRequest(intentMap);
    
    
  
  function consultaPedido(agent){
        const pedidoId = req.body.queryResult.parameters.pedidoId;
        const pedido = pedidos.find(p => p.pedidoId == pedidoId);
        
        if (pedido) {
            agent.add(`O status do seu pedido #${pedidoId} é: ${pedido.status}`);
        } if(pedidoId == ""){
          agent.add(`Por favor, forneça o número de seu pedido`);
          
        } else {
            agent.add(`Não encontramos o pedido #${pedidoId}. Verifique o número do pedido e tente novamente.`);
        }
  }/*
    if (intent === 'consulta-status-de-pedido') {
        
    } else if (intent === 'Abertura de Ticket de Suporte') {
        const problema = req.body.queryResult.parameters.problema;
        // Aqui você pode salvar o problema em uma base de dados, por exemplo.
        res.json({
            fulfillmentText: `Obrigado por relatar o problema: "${problema}". Nossa equipe entrará em contato em breve.`
        });
    } else {
        res.json({
            fulfillmentText: 'Estou aqui para ajudar com qualquer outra solicitação!'
        });
    }*/
});

app.listen(process.env.PORT, () => {
    console.log(`Servidor rodando na porta ${process.env.PORT}`); 
});
