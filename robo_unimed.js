const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx'); 
const https = require('https'); 

// ==========================================
// CONFIGURAÇÕES DO ROBÔ E INTEGRAÇÃO
// ==========================================
const ANTI_CAPTCHA_KEY = 'e8460254856483ad8f0e18a5ea9abf43';
const UNIMED_URL_LOGIN = 'https://www.unimedcuritiba.com.br/login'; 
const UNIMED_USUARIO = 'giovana.krueger@ecooncologia.com.br'; 
const UNIMED_SENHA = 'Eco021224';         
const API_URL = 'https://127.0.0.1:4000/repasse_unimed'; // ATENÇÃO: Mudou para a porta 4000 (Ambiente de Teste)

// ------------------------------------------
// 🧠 DICIONÁRIO DE CÓDIGOS TUSS (AGRUPADOR)
// ------------------------------------------
const MAPA_TUSS = {
    '90487478': 'ELOXATIN', '90487460': 'ELOXATIN',
    '90241983': 'TEVAOXALI', '90241975': 'TEVAOXALI', '90242009': 'TEVAOXALI',
    '90051327': 'GEMZAR', '90051319': 'GEMZAR',
    '90144554': 'FAULDOXO', '90144562': 'FAULDOXO',
    '90483111': 'TAXOTERE', '90483103': 'TAXOTERE',
    '90548361': 'PADCEV', '55768': 'PADCEV',
    '90348737': 'OPDIVO', '90348729': 'OPDIVO',
    '90321766': 'KADCYLA', '90321758': 'KADCYLA',
    '90144457': 'FAULDFLUOR', '51318': 'FAULDFLUOR',
    '90232330': 'FAULDCARBO', '90232321': 'FAULDCARBO', '90232313': 'FAULDCARBO',
    '90537041': 'KEYTRUDA',
    '90184114': 'AVASTIN', '90184106': 'AVASTIN',
    '90349083': 'CYRAMZA', '90349075': 'CYRAMZA',
    '90160266': 'ERBITUX', '90160282': 'ERBITUX',
    '90144384': 'FAULDCISPLA', '90144376': 'FAULDCISPLA', '90144368': 'FAULDCISPLA'
};

// ------------------------------------------
// 🗑️ LISTA NEGRA: MEDICAMENTOS DESCARTADOS
// ------------------------------------------
const LIXO_MEDICAMENTOS = [
    'ANDROCORTIL', 
    'ANSENTRON', 'ANSETRON', // Pegando o erro de digitação da Unimed
    'GLICOSE', 
    'CIMETIDINA',
    'CLORETO', 
    'DIFENIDRIN', 
    'DIPIRONA', 
    'FISIOLOGICA', 'FISIOLÓGICA',
    'EQUIPLEX',
    'B.BRAUN',
    'BAXTER',
    'EMEND'
];

// ==========================================
// FUNÇÃO DA API ANTI-CAPTCHA
// ==========================================
async function quebrarCaptcha(url, siteKey) {
    console.log('🤖 Solicitando Token à API Anti-Captcha...');
    try {
        const createTaskRes = await axios.post('https://api.anti-captcha.com/createTask', {
            clientKey: ANTI_CAPTCHA_KEY,
            task: { 
                type: "NoCaptchaTaskProxyless", 
                websiteURL: url, 
                websiteKey: siteKey 
            }
        });

        if (createTaskRes.data.errorId !== 0) {
            console.error(`❌ RECUSADO PELO ANTI-CAPTCHA: ${createTaskRes.data.errorCode}`);
            return null;
        }

        const taskId = createTaskRes.data.taskId;
        if (!taskId) {
            throw new Error("Falha ao criar tarefa no Anti-Captcha");
        }
        
        console.log(`⏳ Tarefa criada (ID: ${taskId}). Aguardando Token...`);

        let resolvido = false;
        let gRecaptchaResponse = '';

        while (!resolvido) {
            await new Promise(resolve => setTimeout(resolve, 5000)); 
            
            const resultRes = await axios.post('https://api.anti-captcha.com/getTaskResult', {
                clientKey: ANTI_CAPTCHA_KEY, 
                taskId: taskId
            });

            if (resultRes.data.status === 'ready') {
                resolvido = true;
                gRecaptchaResponse = resultRes.data.solution.gRecaptchaResponse;
                console.log('✅ Token gerado com sucesso!');
            } else if (resultRes.data.status !== 'processing') {
                console.error(`❌ Erro durante a resolução: ${resultRes.data.errorCode}`);
                return null;
            }
        }
        return gRecaptchaResponse;
    } catch (error) {
        console.error('❌ Erro de conexão com o Anti-Captcha:', error.message);
        return null;
    }
}

// ==========================================
// O FLUXO PRINCIPAL DO ROBÔ (PRODUÇÃO VM)
// ==========================================
async function executarRoboUnimed() {
    console.log('==================================================');
    console.log('🚀 INICIANDO ROBÔ UNIMED (INTELIGÊNCIA TUSS E ANTI-DUPLICAÇÃO) - ' + new Date().toLocaleString());

    // 🕒 REGRA DE TEMPO: Exatos 2 meses atrás
    const hoje = new Date();
    hoje.setMonth(hoje.getMonth() - 1);
    const alvoMesIndex = hoje.getMonth(); 
    const alvoAno = hoje.getFullYear();
    const competenciaStr = `${String(alvoMesIndex + 1).padStart(2, '0')}/${alvoAno}`; 
    
    console.log(`📅 Competência calculada para extração: ${competenciaStr}`);
    
    // 🧹 LIMPANDO A PASTA ANTES DE COMEÇAR (Evita ler planilha velha)
    const downloadPath = path.resolve(__dirname, 'downloads_unimed');
    if (!fs.existsSync(downloadPath)) {
        fs.mkdirSync(downloadPath);
    } else {
        console.log('🧹 Limpando planilhas antigas da pasta de downloads...');
        const arquivosAntigos = fs.readdirSync(downloadPath);
        for (const arq of arquivosAntigos) {
            try { fs.unlinkSync(path.join(downloadPath, arq)); } catch(e) {}
        }
    }

    let browser;
    let page; 
    
    try {
        browser = await puppeteer.launch({
            headless: 'new', 
            defaultViewport: null, 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-blink-features=AutomationControlled', 
                '--window-size=1366,768', 
                '--disable-web-security', 
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });

        page = await browser.newPage();
        
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
            window.chrome = { runtime: {} };
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1366, height: 768 });
        
        // ==========================================
        // 1. O LOGIN HOMOLOGADO
        // ==========================================
        let maxTentativas = 6;
        let loginSucesso = false;

        for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
            console.log(`\n🔄 [TENTATIVA ${tentativa}/${maxTentativas}] Iniciando processo de login...`);
            
            try {
                await page.goto(UNIMED_URL_LOGIN, { waitUntil: 'networkidle2' });
                await new Promise(resolve => setTimeout(resolve, 4000));

                // Remover Cookies
                await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button'));
                    const cookieBtn = btns.find(b => b.innerText.match(/aceitar.*cookies/i) || b.innerText.match(/concordo/i));
                    if (cookieBtn) {
                        cookieBtn.click();
                    }
                });
                await new Promise(resolve => setTimeout(resolve, 1000));

                console.log('🔑 Preenchendo as Credenciais...');
                await page.waitForSelector('input[type="email"]', { timeout: 15000 });
                await page.click('input[type="email"]');
                await page.type('input[type="email"]', UNIMED_USUARIO, { delay: 90 }); 
                
                await page.click('input[type="password"]');
                await page.type('input[type="password"]', UNIMED_SENHA, { delay: 90 });
                await page.mouse.click(10, 10); 
                
                console.log('🔍 Coletando SiteKey do Captcha...');
                await page.waitForSelector('iframe[src*="google.com/recaptcha"]', { timeout: 15000 });
                const dynamicSiteKey = await page.evaluate(() => {
                    const iframe = document.querySelector('iframe[src*="google.com/recaptcha"]');
                    return iframe ? iframe.src.match(/[?&]k=([^&]+)/)?.[1] : null;
                });

                const tokenCaptcha = await quebrarCaptcha(UNIMED_URL_LOGIN, dynamicSiteKey);

                if (!tokenCaptcha) {
                    throw new Error("Falha ao obter Token do Captcha. Abortando.");
                }

                console.log('💉 Injetando Token na memória do React...');
                await page.evaluate((token) => {
                    const textArea = document.getElementById("g-recaptcha-response");
                    if (textArea) { 
                        textArea.value = token; 
                        textArea.innerHTML = token; 
                    }

                    if (typeof ___grecaptcha_cfg !== 'undefined') {
                        for (let clientId in ___grecaptcha_cfg.clients) {
                            let client = ___grecaptcha_cfg.clients[clientId];
                            let keys = Object.keys(client);
                            for (let i = 0; i < keys.length; i++) {
                                let component = client[keys[i]];
                                if (component && typeof component === 'object') {
                                    if ('callback' in component && typeof component.callback === 'function') {
                                        component.callback(token); 
                                        return;
                                    }
                                    for (let subKey in component) {
                                        if (component[subKey] && typeof component[subKey] === 'object') {
                                            if ('callback' in component[subKey] && typeof component[subKey].callback === 'function') {
                                                component[subKey].callback(token); 
                                                return;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }, tokenCaptcha);
                
                console.log('⏳ Token injetado. Aguardando 3s...');
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                console.log('🔄 Acordando o React...');
                await page.click('input[type="password"]');
                await page.type('input[type="password"]', ' '); 
                await page.keyboard.press('Backspace'); 
                await new Promise(resolve => setTimeout(resolve, 1000));

                console.log('🚪 Simulando Mouse físico e clicando em Entrar...');
                await page.waitForSelector('button.submit-button', { visible: true });
                
                await page.evaluate(() => {
                    const btn = document.querySelector('button.submit-button');
                    if (btn) btn.removeAttribute('disabled');
                });

                const btnEntrar = await page.$('button.submit-button');
                if (btnEntrar) {
                    const box = await btnEntrar.boundingBox();
                    if (box) {
                        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
                        await new Promise(r => setTimeout(r, 200));
                        await page.mouse.down();
                        await new Promise(r => setTimeout(r, 100));
                        await page.mouse.up();
                    } else {
                        await page.keyboard.press('Enter');
                    }
                }
                
                console.log('⏳ Aguardando Área de Trabalho ou bloqueio do WAF...');
                
                let statusDessaTentativa = 'aguardando';
                for (let i = 0; i < 30; i++) { 
                    await new Promise(r => setTimeout(r, 2000));
                    
                    const analise = await page.evaluate(() => {
                        if (document.body.innerText.includes('Canal de Prestadores') || document.body.innerText.includes('Área de Trabalho')) {
                            return 'sucesso';
                        }
                        if (document.body.innerText.includes('Ocorreu um erro inesperado')) {
                            return 'bloqueio_waf';
                        }
                        return 'aguardando';
                    });

                    if (analise !== 'aguardando') {
                        statusDessaTentativa = analise;
                        break;
                    }
                }

                if (statusDessaTentativa === 'sucesso') {
                    console.log('✅ ESTAMOS DENTRO DA ÁREA LOGADA NA VM!');
                    loginSucesso = true;
                    break; 
                } else if (statusDessaTentativa === 'bloqueio_waf') {
                    console.log(`🚨 O Firewall bloqueou a Tentativa ${tentativa}! O robô vai recarregar a página e tentar de novo...`);
                    await new Promise(resolve => setTimeout(resolve, 5000)); 
                } else {
                    console.log(`⚠️ A Tentativa ${tentativa} não saiu do lugar (timeout). Tentando novamente...`);
                }

            } catch (erroLoop) {
                console.error(`❌ Falha na Tentativa ${tentativa}: ${erroLoop.message}`);
            }
        } 

        if (!loginSucesso) {
            await page.screenshot({ path: path.resolve(__dirname, 'erro_linux_desistiu.png'), fullPage: true });
            throw new Error("Todas as 3 tentativas de login falharam. Abortando.");
        }

        await new Promise(resolve => setTimeout(resolve, 4000));

        // ==========================================
        // 1.5 LIMPANDO POP-UPS E ATIVANDO DOWNLOAD
        // ==========================================
        console.log('🧹 Varrendo pop-ups e avisos indesejados da Unimed...');
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, a'));
            const closeBtn = btns.find(b => 
                (b.innerText && b.innerText.match(/fechar|ciente|prosseguir|pular|concordar/i)) || 
                b.getAttribute('aria-label') === 'Close'
            );
            if (closeBtn) {
                closeBtn.click();
            }
        });
        await new Promise(resolve => setTimeout(resolve, 1500));

        console.log('⚙️ Ativando módulo de Downloads silencioso...');
        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadPath });

        // ==========================================
        // 2. A ROTA DO DOWNLOAD E CALENDÁRIO
        // ==========================================
        console.log('🗺️ Navegando para o Demonstrativo...');
        
        // ------------------------------------------
        // NOVO FLUXO: CLICAR NO PERFIL E ÁREA DE TRABALHO
        // ------------------------------------------
        console.log('👤 Abrindo menu de Perfil...');
        await page.evaluate(() => {
            const btnPerfil = document.querySelector('button.navbar-login');
            if (btnPerfil) btnPerfil.click();
        });
        await new Promise(resolve => setTimeout(resolve, 2000)); // Aguarda o menu abrir

        console.log('🖥️ Clicando em "Minha área de trabalho"...');
        await page.evaluate(() => {
            // Tenta achar pelo link exato
            const linkArea = document.querySelector('a[href="/app/home-prestador"]');
            if (linkArea) {
                linkArea.click();
            } else {
                // Fallback de segurança procurando pelo texto
                const links = Array.from(document.querySelectorAll('a'));
                const myArea = links.find(a => a.innerText && a.innerText.includes('Minha área de trabalho'));
                if (myArea) myArea.click();
            }
        });
        await new Promise(resolve => setTimeout(resolve, 4000)); // Aguarda a nova página carregar por completo
        // ------------------------------------------

        await page.evaluate(() => {
            const btn = document.querySelector('button#prestador_0');
            if (btn) btn.click();
        });
        await new Promise(resolve => setTimeout(resolve, 2000));

        await page.evaluate(() => {
            const btn = document.querySelector('button[title="Movimentações"]');
            if (btn) btn.click();
        });
        await new Promise(resolve => setTimeout(resolve, 2000));

        await page.evaluate(() => {
            const btn = document.querySelector('button[title="Demonstrativo de pagamento"]');
            if (btn) btn.click();
        });

        await page.waitForSelector('label[for="custom-switch"]', { visible: true, timeout: 30000 });
        
        await page.evaluate(() => {
            const btn = document.querySelector('label[for="custom-switch"]');
            if (btn) btn.click();
        });
        await new Promise(resolve => setTimeout(resolve, 2000));

        console.log(`📅 Selecionando competência no calendário via Força Bruta JS: ${competenciaStr}...`);
        
        await page.evaluate(() => {
            const inputMes = document.querySelector('input[title="Mês"]');
            if (inputMes) {
                inputMes.focus();
                inputMes.click(); 
            }
        });
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        await page.evaluate((alvo) => {
            let el = document.querySelector('.react-datepicker-year-header');
            if (el) {
                let currentYear = parseInt(el.innerText.trim(), 10);
                while (currentYear > alvo) {
                    let prevBtn = document.querySelector('button.react-datepicker__navigation--previous');
                    if (prevBtn) { 
                        prevBtn.click(); 
                        currentYear--; 
                    } else { 
                        break; 
                    }
                }
            }
        }, alvoAno);
        await new Promise(resolve => setTimeout(resolve, 1000));

        const monthSelector = `.react-datepicker__month-${alvoMesIndex}`;
        await page.evaluate((sel) => {
            const btnMes = document.querySelector(sel);
            if (btnMes) btnMes.click();
        }, monthSelector);
        
        await new Promise(resolve => setTimeout(resolve, 2000));

        console.log('🚀 Solicitando geração do relatório...');
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const btnGerar = btns.find(b => b.innerText && b.innerText.includes('Gerar documentos'));
            if (btnGerar) {
                btnGerar.click();
            }
        });

        console.log(`⏳ Aguardando a Unimed processar a linha ${competenciaStr}...`);
        
        let relatorioPronto = false;
        for (let i = 0; i < 90; i++) { 
            relatorioPronto = await page.evaluate((comp) => {
                const linhas = Array.from(document.querySelectorAll('table tbody tr'));
                const minhaLinha = linhas.find(tr => tr.innerText.includes(comp));
                
                if (minhaLinha) {
                    const textoStatus = minhaLinha.innerText.toLowerCase();
                    if (textoStatus.includes('disponível') || textoStatus.includes('disponivel')) {
                        const botaoXls = minhaLinha.querySelector('[title*="XLS" i], [title*="xls" i], [alt*="XLS" i]');
                        if (botaoXls && !botaoXls.disabled) {
                            botaoXls.click();
                            return true;
                        }
                    }
                }
                return false;
            }, competenciaStr);

            if (relatorioPronto) {
                break;
            }
            await new Promise(r => setTimeout(r, 2000));
        }

        if (!relatorioPronto) {
            throw new Error(`Tempo esgotado. O relatório de ${competenciaStr} não processou.`);
        }

        console.log(`⬇️ Botão da linha ${competenciaStr} acionado! Aguardando o término do download...`);
        
        // 🛡️ ESPERA INTELIGENTE DE DOWNLOAD (Garante que o arquivo termine de baixar)
        let arquivoBaixado = null;
        for (let sec = 0; sec < 60; sec++) {
            await new Promise(r => setTimeout(r, 1000));
            const files = fs.readdirSync(downloadPath);
            
            const isDownloading = files.some(f => f.endsWith('.crdownload') || f.endsWith('.tmp'));
            const finalFile = files.find(f => f.endsWith('.xls') || f.endsWith('.xlsx'));
            
            if (!isDownloading && finalFile) {
                arquivoBaixado = finalFile;
                console.log(`✅ Planilha baixada com sucesso: ${arquivoBaixado}`);
                break;
            }
        }

        if (!arquivoBaixado) {
            throw new Error("O download falhou ou demorou mais de 60 segundos.");
        }

        // ==========================================
        // 3. LEITURA, FUSÃO TUSS E INJEÇÃO NO BANCO
        // ==========================================
        const caminhoExcel = path.join(downloadPath, arquivoBaixado);
        console.log(`📊 Iniciando leitura da planilha: ${arquivoBaixado}`);

        const workbook = xlsx.readFile(caminhoExcel);
        let sheetName = workbook.SheetNames.find(n => n.toUpperCase().includes("GUIA DE SERVI"));
        
        if (!sheetName) {
            sheetName = workbook.SheetNames[0];
        }
        
        if (sheetName) {
            const worksheet = workbook.Sheets[sheetName];
            const jsonData = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
            
            let headerRowIndex = -1;
            for (let i = 0; i < Math.min(jsonData.length, 20); i++) {
                const rowStr = JSON.stringify(jsonData[i]).toUpperCase();
                if (rowStr.includes("NOME") && rowStr.includes("VALOR") && rowStr.includes("DATA ATEND.")) { 
                    headerRowIndex = i; 
                    break; 
                }
            }
            
            if (headerRowIndex !== -1) {
                const finalData = xlsx.utils.sheet_to_json(worksheet, { range: headerRowIndex, raw: false });

                console.log(`⚙️ Formatando, cortando horas e aplicando Dicionário TUSS...`);
                
                const parseNumberStrict = (val) => {
                    if (val === null || val === undefined || val === '') return 0;
                    if (typeof val === 'number') return Number(val.toFixed(2));
                    
                    let s = String(val).replace(/R\$\s?/ig, '').trim();
                    if (s.includes('.') && s.includes(',')) {
                        let lastDot = s.lastIndexOf('.');
                        let lastComma = s.lastIndexOf(',');
                        if (lastComma > lastDot) {
                            s = s.replace(/\./g, '').replace(',', '.'); 
                        } else {
                            s = s.replace(/,/g, ''); 
                        }
                    } else if (s.includes(',')) {
                        s = s.replace(',', '.'); 
                    }
                    
                    const num = parseFloat(s);
                    return isNaN(num) ? 0 : Number(num.toFixed(2));
                };

                const agrupamentoTuss = {};
                let itensLidos = 0;

                finalData.forEach(linha => {
                    const getCol = (names) => { 
                        const key = Object.keys(linha).find(k => names.includes(k.toUpperCase().trim())); 
                        return key ? linha[key] : null; 
                    };

                    const paciente = getCol(["NOME"]);
                    const descricaoRaw = getCol(["DESCRIÇÃO", "DESCRICAO"]);
                    const tipoRaw = getCol(["TIPO"]);
                    const codigoTussRaw = getCol(["EVENTO CÓDIGO", "CÓDIGO EVENTO", "EVENTO CODIGO", "CÓDIGO DO MEDICAMENTO", "CODIGO"]);
                    
                    // 🪪 CAPTURA A CARTEIRINHA
                    const carteirinhaRaw = getCol(["BENEFICIÁRIO CÓDIGO", "BENEFICIARIO CODIGO", "CARTEIRINHA", "CÓDIGO BENEFICIÁRIO"]);
                    const carteirinhaStr = String(carteirinhaRaw || '').trim();

                    // 🕒 CORTADOR DE HORAS PARA O AGRUPAMENTO
                    const dataAtendCompleta = String(getCol(["DATA ATEND."]) || '').trim();
                    const dataCurta = dataAtendCompleta.split(' ')[0];
                    
                    if (!paciente || !descricaoRaw) return;
                    
                    const tipoStr = String(tipoRaw || '').toUpperCase().trim();
                    const descStr = String(descricaoRaw).toUpperCase().trim();
                    
                    // 🧹 LIXEIRA: Ignora MAT e qualquer palavra do Filtro de Lixo
                    const isLixo = LIXO_MEDICAMENTOS.some(lixo => descStr.includes(lixo));
                    if (tipoStr.startsWith('MAT') || isLixo) {
                        return; // Pula a linha (joga no lixo)
                    }

                    let nomeFinal = descStr;
                    const codigoTussStr = String(codigoTussRaw || '').trim();

                    // 🧠 FUSÃO TUSS: Verifica no dicionário mapeado
                    if (MAPA_TUSS[codigoTussStr]) {
                        nomeFinal = MAPA_TUSS[codigoTussStr];
                    }

                    const valorLimpo = parseNumberStrict(getCol(["VALOR"]));
                    const qtdLimpa = parseNumberStrict(getCol(["QTDE."]));

                    // 🎒 ITEM ORIGINAL (Para a mochila de subitens do Front-End)
                    const itemOriginal = {
                        descricao: descStr,
                        quantidade: qtdLimpa,
                        valor: valorLimpo
                    };

                    // A CHAVE ÚNICA DE AGRUPAMENTO (Data curta + Paciente + Nome do TUSS)
                    const chave = `${paciente}_${dataCurta}_${nomeFinal}`;

                    if (!agrupamentoTuss[chave]) {
                        agrupamentoTuss[chave] = {
                            competencia: competenciaStr, 
                            data_atendimento: dataCurta, 
                            paciente: paciente,
                            carteirinha: carteirinhaStr, // Salva a carteirinha
                            descricao: nomeFinal,
                            tipo: tipoStr || 'MED',
                            quantidade: qtdLimpa,
                            valor_pago: valorLimpo,
                            is_med_item: true,
                            codigo_tuss: codigoTussStr, // 💡 O CÓDIGO TUSS AGORA É SALVO NO PACOTE DO BANCO!
                            itens_originais: [itemOriginal] // Inicia a mochila
                        };
                    } else {
                        agrupamentoTuss[chave].quantidade = parseNumberStrict(agrupamentoTuss[chave].quantidade + qtdLimpa);
                        agrupamentoTuss[chave].valor_pago = parseNumberStrict(agrupamentoTuss[chave].valor_pago + valorLimpo);
                        agrupamentoTuss[chave].itens_originais.push(itemOriginal); // Adiciona o irmão na mochila
                    }
                    
                    itensLidos++;
                });

                // Transforma o dicionário de volta em Array
                const payloadRepasse = Object.values(agrupamentoTuss);
                const httpsAgent = new https.Agent({ rejectUnauthorized: false });

                console.log(`📤 Enviando ${payloadRepasse.length} registros agrupados (reduzidos de ${itensLidos} itens) para o banco local...`);
                
                // 🛡️ O GERADOR DE ID DETERMINÍSTICO (Anti-Duplicação)
                const cleanStr = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

                let inseridos = 0;
                for (const item of payloadRepasse) {
                    try {
                        // ID GARANTIDO: Não importa se rodar 10x, o ID é sempre o mesmo e atualiza no banco
                        item.id_firebase = `uni_${cleanStr(item.competencia)}_${cleanStr(item.paciente).substring(0,10)}_${cleanStr(item.descricao).substring(0,10)}_${cleanStr(item.data_atendimento)}`;
                        
                        await axios.post(API_URL, item, {
                            headers: { 'x-api-key': 'EcoOnco_Smart_Seguranca_2026!@' },
                            httpsAgent: httpsAgent
                        });
                        inseridos++;
                    } catch (errPost) {
                        console.error(`❌ Erro ao inserir ${item.paciente}:`, errPost.message);
                    }
                }
                console.log(`✅ Sucesso Absoluto! ${inseridos} registros agrupados foram salvos sem duplicação!`);

            } else {
                console.log('⚠️ Cabeçalhos não encontrados na aba Guia de Serviços.');
            }
        } else {
            console.log('⚠️ Erro: Planilha não encontrada na pasta.');
        }

        console.log('🎉 TUDO FINALIZADO COM MAESTRIA!');

    } catch (error) {
        console.error('❌ Erro no código:', error.message);
        if (page) {
            try {
                await page.screenshot({ path: path.resolve(__dirname, 'erro_crash_tela.png'), fullPage: true });
                console.log('📸 A foto do erro exato foi salva na VM como "erro_crash_tela.png"');
            } catch(e) {}
        }
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

// ==========================================
// AGENDAMENTO: Roda todo dia 01 do mês à 01:00 AM
// ==========================================
cron.schedule('0 1 1 * *', () => {
    console.log('⏰ Iniciando extração mensal agendada...');
    executarRoboUnimed();
});

// Executa uma vez ao iniciar (Modo Teste/Start)
executarRoboUnimed();