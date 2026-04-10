require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const axios = require('axios');
const path = require('path');
const cron = require('node-cron');
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');

// ==========================================
// CONFIGURAÇÕES
// ==========================================
const ANTI_CAPTCHA_KEY = 'e8460254856483ad8f0e18a5ea9abf43';
const UNIMED_URL_LOGIN = 'https://www.unimedcuritiba.com.br/login'; 
const UNIMED_USUARIO = 'giovana.krueger@ecooncologia.com.br'; 
const UNIMED_SENHA = 'Eco021224';         

// Configuração do E-mail
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 587, secure: false,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// Configuração do Banco de Dados
const pool = mysql.createPool({
    host: '127.0.0.1',
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true, connectionLimit: 5, queueLimit: 0
});

// ==========================================
// ANTI-CAPTCHA
// ==========================================
async function quebrarCaptcha(url, siteKey) {
    console.log('🤖 Solicitando Token à API Anti-Captcha...');
    try {
        const createTaskRes = await axios.post('https://api.anti-captcha.com/createTask', {
            clientKey: ANTI_CAPTCHA_KEY, task: { type: "NoCaptchaTaskProxyless", websiteURL: url, websiteKey: siteKey }
        });
        if (createTaskRes.data.errorId !== 0) return null;
        const taskId = createTaskRes.data.taskId;
        let resolvido = false; let gRecaptchaResponse = '';
        
        while (!resolvido) {
            await new Promise(resolve => setTimeout(resolve, 5000)); 
            const resultRes = await axios.post('https://api.anti-captcha.com/getTaskResult', { clientKey: ANTI_CAPTCHA_KEY, taskId: taskId });
            if (resultRes.data.status === 'ready') { resolvido = true; gRecaptchaResponse = resultRes.data.solution.gRecaptchaResponse; } 
            else if (resultRes.data.status !== 'processing') return null;
        }
        return gRecaptchaResponse;
    } catch (error) { return null; }
}

// ==========================================
// FUNÇÃO DE NAVEGAÇÃO PUPPETEER (CORE)
// ==========================================
async function capturarPrintUnimed(nomePaciente, dataInicio, dataFim) {
    let browser; let page; 
    
    try {
        console.log("🚀 Abrindo navegador...");
        browser = await puppeteer.launch({
            headless: false, // 💡 MUDADO PARA FALSE: Abre o navegador visível no Windows!
            defaultViewport: null, 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1366,768']
        });
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        
        console.log("🔑 Fazendo Login...");
        await page.goto(UNIMED_URL_LOGIN, { waitUntil: 'networkidle2' });
        await new Promise(resolve => setTimeout(resolve, 4000));
        
        await page.type('input[type="email"]', UNIMED_USUARIO, { delay: 50 }); 
        await page.type('input[type="password"]', UNIMED_SENHA, { delay: 50 });
        
        const siteKey = await page.evaluate(() => document.querySelector('iframe[src*="google.com/recaptcha"]')?.src.match(/[?&]k=([^&]+)/)?.[1]);
        const token = await quebrarCaptcha(UNIMED_URL_LOGIN, siteKey);
        
        if (!token) throw new Error("Captcha falhou.");

        await page.evaluate((t) => {
            document.getElementById("g-recaptcha-response").value = t;
            if (typeof ___grecaptcha_cfg !== 'undefined') {
                for (let c in ___grecaptcha_cfg.clients) {
                    let client = ___grecaptcha_cfg.clients[c];
                    for (let k in client) {
                        if (client[k] && client[k].callback) { client[k].callback(t); return; }
                    }
                }
            }
        }, token);
        await new Promise(r => setTimeout(r, 2000));
        
        await page.click('input[type="password"]'); await page.type('input[type="password"]', ' '); await page.keyboard.press('Backspace');
        await page.evaluate(() => document.querySelector('button.submit-button')?.removeAttribute('disabled'));
        await page.click('button.submit-button');
        
        console.log("⏳ Aguardando carregamento da área logada...");
        await new Promise(r => setTimeout(r, 8000));

        console.log("🗺️ Navegando para Consultas de Autorização...");
        await page.evaluate(() => Array.from(document.querySelectorAll('a, button')).find(el => el.innerText.includes('Área de trabalho') || el.innerText.includes('Operações'))?.click());
        await new Promise(r => setTimeout(r, 3000));

        await page.evaluate(() => Array.from(document.querySelectorAll('a, span, button')).find(el => el.innerText.includes('Consulta de Autorizações de Internamento'))?.click());
        await new Promise(r => setTimeout(r, 3000));

        await page.evaluate(() => Array.from(document.querySelectorAll('button, a')).find(el => el.innerText.includes('Acessar'))?.click());
        await new Promise(r => setTimeout(r, 3000));

        console.log(`🔍 Buscando paciente: ${nomePaciente}`);
        await page.click('.icone-lupa-beneficiario'); // Ajuste conforme a classe da Unimed
        await new Promise(r => setTimeout(r, 2000));

        await page.type('input[name="nomeBeneficiario"]', nomePaciente); 
        await page.evaluate(() => Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Buscar'))?.click());
        await new Promise(r => setTimeout(r, 3000));

        // Verifica se achou o paciente (se a tabela de busca retornou algo)
        const achouPaciente = await page.evaluate(() => {
            const btnSel = Array.from(document.querySelectorAll('button, a')).find(b => b.innerText.includes('Selecionar'));
            if(btnSel) { btnSel.click(); return true; }
            return false;
        });

        if (!achouPaciente) {
            console.log(`⚠️ Paciente ${nomePaciente} não localizado na Unimed neste momento.`);
            return null; // Retorna nulo, o robô tentará de novo na próxima hora
        }

        await new Promise(r => setTimeout(r, 2000));

        // Insere as datas se foram informadas no Front
        if (dataInicio && dataFim) {
            await page.type('input[name="dataInicio"]', dataInicio); 
            await page.type('input[name="dataFim"]', dataFim);
        }

        await page.evaluate(() => Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Consultar'))?.click());
        await new Promise(r => setTimeout(r, 5000));

        console.log("📸 Gerando Print...");
        const clicouAutorizacao = await page.evaluate(() => {
            const link = document.querySelector('table tbody tr td a');
            if(link) { link.click(); return true; }
            return false;
        });

        if (!clicouAutorizacao) {
            console.log(`⚠️ Nenhuma autorização encontrada para ${nomePaciente} no período.`);
            return null;
        }

        await new Promise(r => setTimeout(r, 4000));

        const fileName = `print_unimed_${Date.now()}.png`;
        const savePath = path.resolve(__dirname, 'public', 'prints', fileName);
        await page.screenshot({ path: savePath, fullPage: true });
        
        console.log(`✅ Print capturado: ${fileName}`);
        return `/prints/${fileName}`;

    } catch (error) {
        console.error('❌ Erro de navegação:', error.message);
        return null;
    } finally {
        if (browser) {
            console.log("Fechando navegador...");
            await browser.close();
        }
    }
}

// ==========================================
// ORQUESTRADOR: BUSCA NO BANCO E DISPARA
// ==========================================
async function processarFilaPendentes() {
    console.log('==================================================');
    console.log('🕒 Iniciando verificação de fila - ' + new Date().toLocaleString());

    try {
        // 🛡️ GABARITO DE SEGURANÇA: Cria a tabela se ela não existir
        await pool.query(`
            CREATE TABLE IF NOT EXISTS fluxo_pacientes_unimed (
                id INT AUTO_INCREMENT PRIMARY KEY,
                id_firebase VARCHAR(100) UNIQUE,
                dados_extras JSON
            )
        `);

        const [rows] = await pool.query("SELECT * FROM fluxo_pacientes_unimed");
        
        let pacientesPendentes = [];
        rows.forEach(row => {
            let dados = typeof row.dados_extras === 'string' ? JSON.parse(row.dados_extras) : row.dados_extras;
            if (dados.status === 'pendente') {
                pacientesPendentes.push({
                    id: row.id_firebase,
                    nome: dados.nome,
                    dtInicio: dados.dataInicioBusca || '',
                    dtFim: dados.dataFimBusca || '',
                    dadosCompletos: dados
                });
            }
        });

        if (pacientesPendentes.length === 0) {
            console.log('📭 Nenhum paciente pendente na fila.');
            return;
        }

        console.log(`📋 Encontrados ${pacientesPendentes.length} paciente(s) aguardando guia...`);

        for (const pac of pacientesPendentes) {
            const printUrl = await capturarPrintUnimed(pac.nome, pac.dtInicio, pac.dtFim);

            if (printUrl) {
                pac.dadosCompletos.status = 'nicolas';
                pac.dadosCompletos.print_url = printUrl;

                await pool.query(
                    `UPDATE fluxo_pacientes_unimed SET dados_extras = JSON_MERGE_PATCH(COALESCE(dados_extras, '{}'), ?) WHERE id_firebase = ?`,
                    [JSON.stringify(pac.dadosCompletos), pac.id]
                );

                console.log(`📧 Simulando envio de e-mail para o Nicolas sobre o paciente ${pac.nome}...`);
                /*
                await transporter.sendMail({
                    from: '"Sistema ONCO SMART" <suporte.ecooncologia@gmail.com>',
                    to: 'nicolas.exemplo@ecooncologia.com.br', 
                    subject: `🟡 Ação Necessária: Verificar Dosagem - Paciente ${pac.nome}`,
                    html: `
                        <h2>Verificação de Dosagem Pendente</h2>
                        <p>O paciente <strong>${pac.nome}</strong> acaba de ter a guia localizada na Unimed e aguarda a sua verificação de dosagem.</p>
                        <p>Por favor, acesse o ONCO SMART para validar a autorização e visualizar o print.</p>
                    `
                });
                */
                console.log(`✅ Fluxo do paciente ${pac.nome} concluído com sucesso! Status atualizado.`);
            } else {
                console.log(`⏳ ${pac.nome} continua pendente. O robô tentará novamente mais tarde.`);
            }
        }
    } catch (error) {
        console.error('❌ Erro no orquestrador da fila:', error);
    }
}

// ==========================================
// CRON JOB
// ==========================================
cron.schedule('0 * * * *', () => {
    processarFilaPendentes();
});

console.log('🤖 Robô Iniciado.');

// 💡 ISSO FAZ O ROBÔ RODAR NA HORA QUE VOCÊ DER O COMANDO NO TERMINAL
// processarFilaPendentes(); // <-- Comentei a busca no banco por enquanto

// Forçando o robô a fazer o caminho visual com um paciente inventado:
console.log("🛠️ MODO TESTE VISUAL ATIVADO");
capturarPrintUnimed('PACIENTE TESTE ECO', '01/04/2024', '10/04/2024');