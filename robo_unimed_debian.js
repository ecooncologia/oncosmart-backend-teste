require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const axios = require('axios');
const path = require('path');
const fs = require('fs'); 
const cron = require('node-cron');
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');

// ==========================================
// CONFIGURAÇÕES GERAIS
// ==========================================
const ANTI_CAPTCHA_KEY = 'e8460254856483ad8f0e18a5ea9abf43';
const UNIMED_URL_LOGIN = 'https://www.unimedcuritiba.com.br/login'; 
const UNIMED_USUARIO = 'giovana.krueger@ecooncologia.com.br'; 
const UNIMED_SENHA = 'Eco021224';   
      
// ==========================================
// CONFIGURAÇÃO DE E-MAIL
// ==========================================
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587, 
    secure: false,
    auth: { 
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// ==========================================
// BANCO DE DADOS (CONECTANDO DE DENTRO DA VM)
// ==========================================
const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1', // ⬅️ Na VM é localhost
    user: process.env.DB_USER || 'admin_eco',
    password: process.env.DB_PASS || 'Hzmffv10@',
    database: process.env.DB_NAME || 'eco_sistema',
    waitForConnections: true, 
    connectionLimit: 5, 
    queueLimit: 0
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
// 🔥 SESSÃO ÚNICA: LOGIN 1x → NAVEGA 1x → PROCESSA TODA A FILA
// ==========================================
async function processarFilaCompleta(pacientesPendentes) {
    let browser; let page;
    
    const printsDir = path.resolve(__dirname, 'public', 'prints');
    if (!fs.existsSync(path.resolve(__dirname, 'public'))) fs.mkdirSync(path.resolve(__dirname, 'public'));
    if (!fs.existsSync(printsDir)) fs.mkdirSync(printsDir);

    const resultados = [];

    try {
        console.log(`\n🚀 ==========================================`);
        console.log(`🚀 SESSÃO ÚNICA - ${pacientesPendentes.length} paciente(s) na fila`);
        console.log(`🚀 ==========================================`);
        
        browser = await puppeteer.launch({
            headless: true, // ⬅️ DEBIAN: MODO INVISÍVEL
            defaultViewport: { width: 1366, height: 768 }, // ⬅️ Força a resolução de PC
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage', // ⬅️ DEBIAN: Evita travamento de RAM
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled', 
                '--window-size=1366,768', 
                '--disable-web-security', 
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });
        
        page = await browser.newPage();
        
        // Reforço extra de tela para o Linux não achatar a janela
        await page.setViewport({ width: 1366, height: 768 });
        
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        
        // ---------------------------------------------------------
        // 1. LOGIN BLINDADO
        // ---------------------------------------------------------
        let maxTentativas = 6;
        let loginSucesso = false;

        for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
            console.log(`\n🔄 [TENTATIVA ${tentativa}/${maxTentativas}] Iniciando processo de login...`);
            
            try {
                await page.goto(UNIMED_URL_LOGIN, { waitUntil: 'networkidle2', timeout: 60000 });
                await new Promise(resolve => setTimeout(resolve, 10000)); 

                await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button, a'));
                    const cookieBtn = btns.find(b => b.innerText && b.innerText.match(/aceitar.*cookies|concordo/i));
                    if (cookieBtn) cookieBtn.click();
                });
                await new Promise(resolve => setTimeout(resolve, 2000)); 

                console.log('🔑 Preenchendo as Credenciais...');
                await page.waitForSelector('input[type="email"]', { timeout: 30000 }); 
                await page.click('input[type="email"]', { clickCount: 3 });
                await page.keyboard.press('Backspace');
                await page.type('input[type="email"]', UNIMED_USUARIO, { delay: 150 }); 
                
                await page.click('input[type="password"]', { clickCount: 3 });
                await page.keyboard.press('Backspace');
                await page.type('input[type="password"]', UNIMED_SENHA, { delay: 150 }); 
                await page.mouse.click(10, 10); 
                
                console.log('🔍 Coletando SiteKey do Captcha...');
                await page.waitForSelector('iframe[src*="google.com/recaptcha"]', { timeout: 30000 }); 
                const dynamicSiteKey = await page.evaluate(() => {
                    const iframe = document.querySelector('iframe[src*="google.com/recaptcha"]');
                    return iframe ? iframe.src.match(/[?&]k=([^&]+)/)?.[1] : null;
                });

                const tokenCaptcha = await quebrarCaptcha(UNIMED_URL_LOGIN, dynamicSiteKey);
                if (!tokenCaptcha) throw new Error("Falha ao obter Token do Captcha.");

                console.log('💉 Injetando Token na memória...');
                await page.evaluate((token) => {
                    const textArea = document.getElementById("g-recaptcha-response");
                    if (textArea) { textArea.value = token; textArea.innerHTML = token; }
                    if (typeof ___grecaptcha_cfg !== 'undefined') {
                        for (let clientId in ___grecaptcha_cfg.clients) {
                            let client = ___grecaptcha_cfg.clients[clientId];
                            let keys = Object.keys(client);
                            for (let i = 0; i < keys.length; i++) {
                                let component = client[keys[i]];
                                if (component && typeof component === 'object') {
                                    if ('callback' in component && typeof component.callback === 'function') { component.callback(token); return; }
                                    for (let subKey in component) {
                                        if (component[subKey] && typeof component[subKey] === 'object') {
                                            if ('callback' in component[subKey] && typeof component[subKey].callback === 'function') { component[subKey].callback(token); return; }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }, tokenCaptcha);
                
                await new Promise(resolve => setTimeout(resolve, 5000)); 
                
                console.log('🔄 Acordando o React...');
                await page.click('input[type="password"]');
                await page.type('input[type="password"]', ' '); 
                await page.keyboard.press('Backspace'); 
                await new Promise(resolve => setTimeout(resolve, 3000)); 

                console.log('🚪 Clicando em Entrar...');
                await page.evaluate(() => {
                    const btn = document.querySelector('button.submit-button');
                    if (btn) btn.removeAttribute('disabled');
                });
                await page.click('button.submit-button');
                
                console.log('⏳ Aguardando Área de Trabalho carregar (Aguardando até 20 segundos)...');
                await new Promise(r => setTimeout(r, 20000)); 
                
                const analise = await page.evaluate(() => {
                    if (document.querySelector('.icone-person') || document.body.innerText.includes('Área de trabalho')) return 'sucesso';
                    return 'falha';
                });

                if (analise === 'sucesso') {
                    console.log('✅ ESTAMOS DENTRO DA ÁREA LOGADA!');
                    loginSucesso = true;
                    break; 
                } else {
                    console.log(`⚠️ A Tentativa ${tentativa} falhou em achar o menu. Tentando de novo...`);
                }

            } catch (erroLoop) {
                console.error(`❌ Falha na Tentativa ${tentativa}: ${erroLoop.message}`);
            }
        } 

        if (!loginSucesso) throw new Error("Todas as tentativas de login falharam. Abortando.");

        await new Promise(resolve => setTimeout(resolve, 8000)); 

        // ---------------------------------------------------------
        // 2. NAVEGAÇÃO ATÉ A TELA DO BOTÃO "ACESSAR" (1 VEZ SÓ)
        // ---------------------------------------------------------
        console.log('👤 Passo 1: Clicando em Perfil...');
        
        try {
            await page.waitForSelector('.icone-person', { visible: true, timeout: 30000 }); 
            await page.evaluate(() => {
                const icon = document.querySelector('.icone-person');
                if (icon) (icon.closest('button') || icon).click();
            });
            await new Promise(r => setTimeout(r, 6000)); 
        } catch (erroPasso1) {
            // 🚨 SISTEMA DE CAPTURA DE ERRO 🚨
            console.log('\n❌ ERRO NO PASSO 1: O ícone de perfil não apareceu na tela!');
            console.log('🔗 URL atual:', page.url());
            
            // Tira um print da tela inteira
            const debugPath = path.resolve(__dirname, 'public', 'prints', `DEBUG_ERRO_MENU_${Date.now()}.png`);
            await page.screenshot({ path: debugPath, fullPage: true });
            
            console.log(`📸 PRINT DE DEPURACÃO SALVO EM: ${debugPath}`);
            console.log('🧐 Abra este arquivo no seu painel para vermos o que travou o robô!');
            
            // Pega o texto da tela para ajudar na leitura
            const textoTela = await page.evaluate(() => document.body.innerText.substring(0, 300).replace(/\n/g, ' '));
            console.log(`📄 Texto visível na tela: "${textoTela}..."`);
            
            throw new Error("Execução abortada para análise do Print de Erro.");
        }

        console.log('🖥️ Passo 2: Clicando em "Minha área de trabalho"...');
        await page.waitForSelector('a[href="/app/home-prestador"]', { visible: true, timeout: 30000 }); 
        await page.evaluate(() => document.querySelector('a[href="/app/home-prestador"]').click());
        await new Promise(r => setTimeout(r, 10000)); 

        console.log('📁 Passo 3: Clicando na "Área de Trabalho"...');
        await page.waitForSelector('#prestador_0', { visible: true, timeout: 30000 });
        await page.click('#prestador_0');
        await new Promise(r => setTimeout(r, 5000)); 

        console.log("🗺️ Passo 4: Clicando em 'Operações / Autorizações'...");
        await page.waitForSelector('#prestador_1', { visible: true, timeout: 30000 });
        await page.click('#prestador_1');
        await new Promise(r => setTimeout(r, 5000));

        console.log("🗺️ Passo 5: Clicando em 'Consulta de autorizações de internamento'...");
        await page.waitForSelector('#prestador_6', { visible: true, timeout: 30000 });
        await page.click('#prestador_6');
        await new Promise(r => setTimeout(r, 5000));

        // A partir daqui, 'page' é a pagPrincipal (tem o botão "Acessar")
        const pagPrincipal = page;
        const urlPrincipal = pagPrincipal.url();
        console.log(`📌 Página principal salva: ${urlPrincipal}`);

        // ---------------------------------------------------------
        // 3. LOOP DA FILA — ABRE/FECHA ABA PARA CADA PACIENTE
        // ---------------------------------------------------------
        console.log(`\n🔄 ==========================================`);
        console.log(`🔄 PROCESSANDO FILA: ${pacientesPendentes.length} PACIENTE(S)`);
        console.log(`🔄 ==========================================`);

        for (let idx = 0; idx < pacientesPendentes.length; idx++) {
            const paciente = pacientesPendentes[idx];
            const pos = `[${idx + 1}/${pacientesPendentes.length}]`;
            
            console.log(`\n${'═'.repeat(50)}`);
            console.log(`🔍 ${pos} Paciente: ${paciente.nome}`);
            console.log(`💳 ${pos} Carteirinha: ${paciente.carteirinha}`);
            console.log(`${'═'.repeat(50)}`);

            if (!paciente.carteirinha) {
                console.log(`⚠️ ${pos} Sem carteirinha. Pulando...`);
                resultados.push({ pac: paciente, printUrl: null });
                continue;
            }

            let pagConsulta = null;

            try {
                await pagPrincipal.bringToFront();

                console.log(`👉 ${pos} Clicando no botão 'Acessar'...`);
                await pagPrincipal.waitForSelector('button.custom-button.btn-primary', { visible: true, timeout: 30000 }); 
                await pagPrincipal.evaluate(() => {
                    const btn = Array.from(document.querySelectorAll('button')).find(el => el.innerText.includes('Acessar'));
                    if(btn) btn.click();
                });
                
                console.log(`⏳ ${pos} Aguardando nova aba abrir (15s)...`);
                await new Promise(r => setTimeout(r, 15000)); 

                const allPages = await browser.pages();
                if (allPages.length < 2) throw new Error("A nova aba não abriu a tempo.");
                pagConsulta = allPages[allPages.length - 1]; 
                await pagConsulta.bringToFront(); 
                
                console.log(`✅ ${pos} Nova aba capturada! Buscando campo de Beneficiário...`);
                await pagConsulta.waitForSelector('#ctl00_ContentPlaceHolder1_tbBenef', { visible: true, timeout: 30000 }); 

                console.log(`💳 ${pos} Inserindo a carteirinha do paciente: ${paciente.carteirinha}...`);
                await pagConsulta.click('#ctl00_ContentPlaceHolder1_tbBenef');
                await pagConsulta.keyboard.down('Control'); await pagConsulta.keyboard.press('A'); await pagConsulta.keyboard.up('Control'); await pagConsulta.keyboard.press('Backspace');
                await pagConsulta.type('#ctl00_ContentPlaceHolder1_tbBenef', paciente.carteirinha, { delay: 150 }); 

                console.log(`⌨️ ${pos} Pressionando TAB para acionar o PostBack...`);
                await pagConsulta.keyboard.press('Tab');
                await new Promise(r => setTimeout(r, 10000)); 

                console.log(`📅 ${pos} Preenchendo as datas de busca...`);
                
                const dataBdRaw = paciente.data_solicitacao || new Date().toISOString().split('T')[0];
                const dataApenasNumeros = dataBdRaw.replace(/\D/g, ''); 
                
                const ano = dataApenasNumeros.substring(0, 4);
                const mes = dataApenasNumeros.substring(4, 6);
                const dia = dataApenasNumeros.substring(6, 8);
                const dataInicialFormatada = `${dia}${mes}${ano}`; 
                const dataInicialComBarras = `${dia}/${mes}/${ano}`; 

                const hoje = new Date();
                const dataFinalFormatada = `${String(hoje.getDate()).padStart(2, '0')}${String(hoje.getMonth() + 1).padStart(2, '0')}${hoje.getFullYear()}`;

                await pagConsulta.waitForSelector('#ctl00_ContentPlaceHolder1_tbDataInicial', { visible: true, timeout: 30000 }); 
                
                await pagConsulta.click('#ctl00_ContentPlaceHolder1_tbDataInicial');
                await pagConsulta.keyboard.press('Home');
                for(let i=0; i<10; i++) await pagConsulta.keyboard.press('Delete');
                await pagConsulta.type('#ctl00_ContentPlaceHolder1_tbDataInicial', dataInicialFormatada, { delay: 150 }); 
                
                await new Promise(r => setTimeout(r, 2000));
                
                await pagConsulta.click('#ctl00_ContentPlaceHolder1_tbDataFinal');
                await pagConsulta.keyboard.press('Home');
                for(let i=0; i<10; i++) await pagConsulta.keyboard.press('Delete');
                await pagConsulta.type('#ctl00_ContentPlaceHolder1_tbDataFinal', dataFinalFormatada, { delay: 150 }); 

                await new Promise(r => setTimeout(r, 3000));

                console.log(`🚀 ${pos} Clicando no botão Consultar...`);
                await pagConsulta.click('#ctl00_ContentPlaceHolder1_btnBuscar');

                console.log(`⏳ ${pos} Aguardando a tabela de resultados aparecer...`);
                
                const resultado = await Promise.race([
                    pagConsulta.waitForSelector('table[id*="gvAutorizacoes"]', { visible: true, timeout: 40000 }).then(() => 'tabela'), 
                    pagConsulta.waitForSelector('#ctl00_ContentPlaceHolder1_lbGridVazio', { visible: true, timeout: 40000 }).then(() => 'vazio')
                ]).catch(() => 'timeout');

                if (resultado === 'vazio') {
                    console.log(`📭 ${pos} "Não existem autorizações a serem apresentadas." Próximo...`);
                    resultados.push({ pac: paciente, printUrl: null });
                    continue;
                }

                if (resultado === 'timeout') {
                    console.log(`⚠️ ${pos} Timeout na consulta. O site demorou demais. Próximo...`);
                    resultados.push({ pac: paciente, printUrl: null });
                    continue;
                }

                await new Promise(r => setTimeout(r, 5000));

                console.log(`🔍 ${pos} Procurando autorização com a data inicial: ${dataInicialComBarras}...`);
                
                const achouGuia = await pagConsulta.evaluate((dataDesejada) => {
                    const table = document.querySelector('table[id*="gvAutorizacoes"]');
                    if (!table) return false;
                    
                    const rows = Array.from(table.querySelectorAll('tr'));
                    
                    for (let i = 1; i < rows.length; i++) {
                        if (rows[i].innerText.includes(dataDesejada)) {
                            const linkAutorizacao = rows[i].querySelector('a[id*="lbAutorizacao"]');
                            if (linkAutorizacao) {
                                linkAutorizacao.click();
                                return true;
                            }
                        }
                    }
                    return false;
                }, dataInicialComBarras);

                if (!achouGuia) {
                    console.log(`⚠️ ${pos} Nenhuma autorização encontrada na Unimed para o dia ${dataInicialComBarras}.`);
                    resultados.push({ pac: paciente, printUrl: null });
                    continue;
                }

                console.log(`📸 ${pos} Guia encontrada! Aguardando o Print final carregar (15 segundos)...`);
                await new Promise(r => setTimeout(r, 15000)); 
                
                const fileName = `print_unimed_${Date.now()}.png`;
                const savePath = path.resolve(__dirname, 'public', 'prints', fileName);
                await pagConsulta.screenshot({ path: savePath, fullPage: true });
                
                const printUrl = `/prints/${fileName}`;
                console.log(`✅ ${pos} Print capturado! Salvo em: public/prints/${fileName}`);
                
                resultados.push({ pac: paciente, printUrl });

            } catch (erroPaciente) {
                console.error(`❌ ${pos} Erro ao processar ${paciente.nome}: ${erroPaciente.message}`);
                resultados.push({ pac: paciente, printUrl: null });
            } finally {
                if (pagConsulta && !pagConsulta.isClosed()) {
                    console.log(`🔒 ${pos} Fechando aba de consulta...`);
                    await pagConsulta.close();
                }
            }
        }

        // ---------------------------------------------------------
        // 4. RESUMO DA SESSÃO
        // ---------------------------------------------------------
        const encontrados = resultados.filter(r => r.printUrl);
        const naoEncontrados = resultados.filter(r => !r.printUrl);
        
        console.log(`\n📊 ==========================================`);
        console.log(`📊 RESUMO DA SESSÃO`);
        console.log(`📊 ✅ Guias encontradas: ${encontrados.length}`);
        console.log(`📊 ⏳ Sem autorização:   ${naoEncontrados.length}`);
        console.log(`📊 📋 Total processado:  ${resultados.length}`);
        console.log(`📊 ==========================================\n`);

        return resultados;

    } catch (error) {
        console.error('❌ Erro fatal na sessão:', error.message);
        return resultados;
    } finally {
        if (browser) {
            console.log('🔒 Fechando browser...');
            await browser.close();
        }
    }
}

// ==========================================
// ORQUESTRADOR E BANCO DE DADOS
// ==========================================
async function processarFilaPendentes() {
    console.log('==================================================');
    console.log('🕒 Iniciando verificação de fila (Banco VM - DEBIAN COM LOG) - ' + new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }));

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS fluxo_pacientes_unimed (
                id INT AUTO_INCREMENT PRIMARY KEY,
                id_firebase VARCHAR(100) UNIQUE,
                dados_extras JSON
            )
        `);

        const [rows] = await pool.query("SELECT * FROM fluxo_pacientes_unimed");
        
        let pacientesPendentes = [];
        
        console.log('\n--- 🔍 RAIO-X DO BANCO DE DADOS ---');
        
        rows.forEach(row => {
            let dados;
            try {
                dados = typeof row.dados_extras === 'string' ? JSON.parse(row.dados_extras) : row.dados_extras;
            } catch(e) {
                console.log(`⚠️ Erro ao ler JSON da linha ID ${row.id}`);
                return;
            }

            const nomePaciente = dados.nome || dados.Nome || dados.NOME || 'Sem Nome';
            const numCarteirinha = dados.carteirinha || dados.Carteirinha || dados.CARTEIRINHA || '';
            const dataSol = dados.data_solicitacao || dados.Data_solicitacao || dados.Data_Solicitacao || dados.dataSolicitacao || '';
            
            const statusRaw = dados.status || dados.Status || dados.STATUS || '';
            const statusAtual = String(statusRaw).toLowerCase().trim();
            
            console.log(`🔎 ID: ${row.id_firebase} | Paciente: ${nomePaciente} | Status no Banco: "${statusRaw}"`);

            if (statusAtual === 'pendente' || statusAtual.includes('fila')) {
                pacientesPendentes.push({
                    id: row.id_firebase,
                    nome: nomePaciente,
                    carteirinha: numCarteirinha, 
                    data_solicitacao: dataSol,
                    dadosCompletos: dados
                });
            }
        });
        
        console.log('-----------------------------------\n');

        if (pacientesPendentes.length === 0) {
            console.log('📭 Nenhum paciente com status "Fila Robô" no momento.');
            return;
        }

        console.log(`📋 Encontrados ${pacientesPendentes.length} paciente(s) aguardando guia...`);

        const resultados = await processarFilaCompleta(pacientesPendentes);

        console.log('\n💾 Atualizando banco de dados com os resultados...');

        for (const { pac, printUrl } of resultados) {
            const now = new Date();
            const dataHoraVarredura = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
            
            pac.dadosCompletos.ultima_varredura = dataHoraVarredura; 

            if (printUrl) {
                pac.dadosCompletos.status = 'nicolas'; 
                pac.dadosCompletos.print_url = printUrl;

                await pool.query(
                    `UPDATE fluxo_pacientes_unimed SET dados_extras = JSON_MERGE_PATCH(COALESCE(dados_extras, '{}'), ?) WHERE id_firebase = ?`,
                    [JSON.stringify(pac.dadosCompletos), pac.id]
                );
                
                console.log(`✅ Status de ${pac.nome} atualizado para 'nicolas'! Enviando e-mail com a Print...`);

                try {
                    let dataFormatadaBR = pac.data_solicitacao;
                    if(pac.data_solicitacao && pac.data_solicitacao.includes('-')) {
                        dataFormatadaBR = pac.data_solicitacao.split('-').reverse().join('/');
                    }
                    
                    await transporter.sendMail({
                        from: `"Sistema ONCO SMART" <${process.env.EMAIL_USER}>`, 
                        to: 'nicolas.araujo@ecooncologia.com.br', 
                        subject: `🟢 Autorização Liberada: Paciente ${pac.nome}`,
                        html: `
                            <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
                                <h2 style="color: #0056b3;">Autorização Unimed Concluída</h2>
                                <p>Olá Nicolas,</p>
                                <p>O paciente <strong>${pac.nome}</strong> teve a sua guia autorizada na Unimed referente à data de solicitação <strong>${dataFormatadaBR}</strong>.</p>
                                <p>O print da tela de aprovação segue em anexo a este e-mail. A guia também já está disponível para sua análise no sistema ONCO SMART.</p>
                                <br>
                                <hr style="border: 0; border-top: 1px solid #eee;">
                                <p style="font-size: 12px; color: #777;"><em>Robô de Varredura - Onco Smart</em></p>
                            </div>
                        `,
                        attachments: [
                            {
                                filename: `Guia_Autorizada_${pac.nome.replace(/\s+/g, '_')}.png`,
                                path: path.join(__dirname, 'public', printUrl) 
                            }
                        ]
                    });
                    console.log(`📧 E-mail enviado com sucesso para Nicolas com o anexo da Print!`);
                } catch (emailErr) {
                    console.error('❌ Erro ao enviar e-mail:', emailErr.message);
                }

            } else {
                await pool.query(
                    `UPDATE fluxo_pacientes_unimed SET dados_extras = JSON_MERGE_PATCH(COALESCE(dados_extras, '{}'), ?) WHERE id_firebase = ?`,
                    [JSON.stringify({ ultima_varredura: dataHoraVarredura }), pac.id] 
                );
                console.log(`⏳ Varredura registrada para ${pac.nome}. Continua na fila para a próxima checagem.`);
            }
        }
    } catch (error) {
        console.error('❌ Erro de conexão com o banco da VM:', error.message);
    }
}

// ==========================================
// INICIALIZAÇÃO (DEBIAN / LINUX)
// ==========================================
console.log('🤖 Robô Iniciado (Versão Debian c/ Captura de Erro).');

// Executa a primeira vez ao iniciar
processarFilaPendentes();

// Agendador (Cron) ativado para rodar a cada 1 hora no servidor
cron.schedule('0 * * * *', () => { 
    console.log('\n⏰ Iniciando varredura programada...');
    processarFilaPendentes(); 
});