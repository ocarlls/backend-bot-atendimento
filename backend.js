const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const pedidos = [
  { pedidoId: "123", status: "Enviado" },
  { pedidoId: "456", status: "Processando" },
  { pedidoId: "789", status: "Entregue" }
];

// Endpoint que recebe as solicitações do Dialogflow
app.post('/webhook', (req, res) => {
    const intent = req.body.queryResult.intent.displayName;
    
    if (intent === 'Consulta de Status de Pedido') {
        const pedidoId = req.body.queryResult.parameters.pedidoId;
        const pedido = pedidos.find(p => p.pedidoId === pedidoId);
        
        if (pedido) {
            res.json({
                fulfillmentText: `O status do seu pedido #${pedidoId} é: ${pedido.status}`
            });
        } else {
            res.json({
                fulfillmentText: `Não encontramos o pedido #${pedidoId}. Verifique o número do pedido e tente novamente.`
            });
        }
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
    }
});

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`); 
});
