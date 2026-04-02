const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerm = require('qrcode-terminal');
const qrcodeHtml = require('qrcode');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORTA_ZAP = 3005; 

const client = new Client({
    authStrategy: new LocalAuth(), 
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ],
    }
});

let zapPronto = false;
let lastQrCode = null;

client.on('qr', (qr) => {
    console.log('📱 ESCANEIE ESTE QR CODE COM O SEU CELULAR:');
    qrcodeTerm.generate(qr, { small: true });
    lastQrCode = qr;
});

client.on('ready', () => {
    console.log('✅ ROBÔ DO WHATSAPP CONECTADO E PRONTO PARA ENVIOS!');
    zapPronto = true;
    lastQrCode = null;
});

client.on('authenticated', () => {
    console.log('🔐 Autenticado com sucesso!');
});

client.on('auth_failure', msg => {
    console.error('❌ Falha na autenticação do Zap', msg);
    zapPronto = false;
});

client.on('disconnected', (reason) => {
    console.log('💔 WhatsApp desconectado:', reason);
    zapPronto = false;
});

client.initialize();

app.get('/qr', async (req, res) => {
    if (zapPronto) {
        return res.send('<h2>O Robô já está conectado e online! ✅</h2>');
    }
    if (lastQrCode) {
        try {
            const qrImage = await qrcodeHtml.toDataURL(lastQrCode);
            res.send(`
                <h2>Escaneie para conectar o Robô da Clínica</h2>
                <img src="${qrImage}" style="width: 300px; height: 300px;">
                <p>Atualize a página se o QR Code expirar.</p>
            `);
        } catch (err) {
            res.send("Erro ao gerar a imagem do QR Code.");
        }
    } else {
        res.send('<h2>Aguardando geração do QR Code... Atualize em 5 segundos.</h2>');
    }
});

app.post('/enviar', async (req, res) => {
    if (!zapPronto) {
        return res.status(503).json({ error: "O Robô do WhatsApp não está conectado." });
    }

    let { numero, mensagem } = req.body;

    if (!numero || !mensagem) {
        return res.status(400).json({ error: "Número e mensagem são obrigatórios." });
    }

    // Formata o número base
    let numeroLimpo = numero.replace(/\D/g, '');
    if (!numeroLimpo.startsWith('55')) numeroLimpo = '55' + numeroLimpo;

    try {
        // A MÁGICA: Pede pro WhatsApp descobrir a ID exata (Resolve a treta do 9º dígito)
        const numberDetails = await client.getNumberId(numeroLimpo);

        if (!numberDetails) {
            console.error(`❌ O número ${numeroLimpo} não possui WhatsApp registrado.`);
            return res.status(400).json({ error: "Número não possui WhatsApp." });
        }

        // Pega a ID oficial devolvida pelos servidores da Meta
        const numeroZap = numberDetails._serialized;

        await client.sendMessage(numeroZap, mensagem);
        console.log(`✉️ Mensagem enviada silenciosamente para: ${numeroZap}`);
        
        res.json({ success: true, message: "Enviado com sucesso!" });

    } catch (error) {
        console.error(`❌ Erro ao enviar para ${numero}:`, error);
        res.status(500).json({ error: "Falha interna no envio do WhatsApp." });
    }
});

app.listen(PORTA_ZAP, () => {
    console.log(`🤖 Servidor do WhatsApp rodando na porta ${PORTA_ZAP}`);
});
