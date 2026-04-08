require('dotenv').config(); // 💡 Carrega as variáveis secretas do arquivo .env

const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const nodemailer = require('nodemailer');

// 1. IMPORTANDO O MOTOR DO ORACLE
const oracledb = require('oracledb');
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT; 

// 🛡️ ATIVANDO O "THICK MODE" (MODO LEGADO)
try {
    oracledb.initOracleClient({ libDir: '/opt/instantclient_19_22' });
    console.log("✅ [Oracle] Modo Legacy (Thick Mode) ativado com sucesso no Linux!");
} catch (err) {
    console.error('⚠️ [Oracle] Erro ao iniciar o modo legado:', err.message);
}

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const CHAVE_MESTRA = process.env.CHAVE_MESTRA; // 🔒 Puxando do .env
const rotasAbertas = ['/avaliar', '/webhook-review', '/registrar_ponto', '/webhook-ata']; 

app.use((req, res, next) => {
    const portaAcessada = req.socket.localPort;
    // 🔒 Puxando portas externas do .env
    const portasExternas = [parseInt(process.env.PORT_EXTERNA_QR), parseInt(process.env.PORT_EXTERNA_MAKE)]; 

    if (portasExternas.includes(portaAcessada) && !rotasAbertas.includes(req.path)) {
        return res.status(403).json({ erro: "Forbidden: Rota interna não acessível externamente." });
    }
    if (rotasAbertas.includes(req.path)) {
        return next();
    }
    
    const chaveRecebida = req.headers['x-api-key'] || req.query.api_key;
    if (chaveRecebida !== CHAVE_MESTRA) {
        return res.status(401).json({ erro: "Acesso Negado: Área restrita e criptografada." });
    }
    next();
});

// ============================================================================
// --- CREDENCIAIS DOS BANCOS DE DADOS ---
// ============================================================================

// 🛢️ BANCO MYSQL (Blindado com .env)
const pool = mysql.createPool({
    host: '127.0.0.1',
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: '-03:00' 
});

// 🛢️ BANCO ORACLE 19c (Blindado com .env)
const dbConfigOracle = {
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASS,
    connectString: process.env.ORACLE_CONN 
};

const FIREBASE_DB_URL = "https://gerar-orcamento-bd4d1-default-rtdb.firebaseio.com";

// 🚀 TESTE DE CONEXÃO ORACLE NO STARTUP
(async function testarOracle() {
    try {
        console.log(`[Banco Local] Conectado no banco: ${process.env.DB_NAME}`);
        console.log("[Oracle] Testando conexão com o Tasy...");
        const conn = await oracledb.getConnection(dbConfigOracle);
        console.log("✅ [Oracle] Conectado!");
        await conn.close();
    } catch (err) {
        console.error("❌ [Oracle] Falha ao conectar no Tasy no startup:", err.message);
    }
})();

// --- E-MAIL E FUNÇÕES ---
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 587, secure: false,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } // 🔒 Puxando do .env
});

async function avisarTeams(ticket, isReabertura = false) {
    const powerAutomateUrl = "https://default32e51e8d98f24db69e51f726afa334.45.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/5f515e9168454b3db196b3325e3b6a9e/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=WRwm94Zz2mBpQkYMmFpHsX1-RYR8Z6M36WdmHdFzc50"; 
    let titulo = ticket.assunto || 'Sem assunto';
    let urgencia = ticket.sla || 'Normal';
    if (isReabertura) { titulo = `[REABERTO] ${titulo}`; urgencia = `CRÍTICO - REABERTO`; }

    const payload = {
        assunto: titulo, usuario: ticket.user || 'Desconhecido', setor: ticket.setor || 'N/A',
        categoria: ticket.categoria || 'Geral', prioridade: urgencia, descricao: ticket.desc || 'Sem descrição'
    };

    try { await fetch(powerAutomateUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); } 
    catch(e) { console.error("[Teams] Falha de conexão:", e); }
}

const limparData = (val) => {
    try {
        if (!val) return null;
        const d = new Date(val);
        if (isNaN(d.getTime())) return null;
        const dateBR = new Date(d.toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        const pad = (n) => n < 10 ? '0' + n : n;
        return dateBR.getFullYear() + '-' + pad(dateBR.getMonth() + 1) + '-' + pad(dateBR.getDate()) + ' ' + pad(dateBR.getHours()) + ':' + pad(dateBR.getMinutes()) + ':' + pad(dateBR.getSeconds());
    } catch (e) { return null; }
};

const safeIsoDate = (dateVal) => {
    if (!dateVal) return null;
    const d = new Date(dateVal);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0];
};

// ============================================================================
// 🚀 ORACLE: BUSCANDO APENAS AS COLUNAS SOLICITADAS (Com Limite de 6 Meses)
// ============================================================================
app.get('/custos_oracle', async (req, res) => {
    let connection;
    try {
        const nrAtendimento = req.query.atendimento;
        const mesAno = req.query.mesAno; 
        
        if (!nrAtendimento && !mesAno) {
            console.log("🛑 [Oracle] BLOQUEADO: Tentativa de buscar a view inteira evitada. Mês ou atendimento ausente.");
            return res.json([]); 
        }

        connection = await oracledb.getConnection(dbConfigOracle);
        
        let querySql = `SELECT CD_TUSS, VL_CUSTO_UNITARIO_MANIP, CUSTO_ANTIGO, CD_AUTORIZACAO FROM TASY.CUSTOS_MEDICAMENTOS_ECO`;
        let bindParams = {};

        if (nrAtendimento) {
            querySql += ` WHERE nr_atendimento = :atendimento`;
            bindParams = { atendimento: nrAtendimento };
        } 
        else if (mesAno) {
            querySql += ` WHERE TRUNC(DT_ATENDIMENTO, 'MM') >= ADD_MONTHS(TO_DATE(:mesAno, 'MM/YYYY'), -6) 
                            AND TRUNC(DT_ATENDIMENTO, 'MM') <= TO_DATE(:mesAno, 'MM/YYYY')`;
            bindParams = { mesAno: mesAno };
        }
        
        const result = await connection.execute(querySql, bindParams);
        
        console.log(`✅ [Oracle] Consulta concluída. Foram puxados ${result.rows.length} registros da View.`);
        res.json(result.rows);
        
    } catch (err) {
        console.error("❌ [Oracle] Erro fatal durante a requisição:", err.message);
        res.status(500).json({ error: "Erro ao buscar dados do Oracle: " + err.message });
    } finally {
        if (connection) {
            try { await connection.close(); } catch (e) { console.error(e); }
        }
    }
});

// ============================================================================
// 🧬 MÓDULO DE PROTOCOLOS E TAGS (COM LOGS DETALHADOS PARA DEBUG)
// ============================================================================

app.post('/protocolos/init-tables', async (req, res) => {
    const queries = [
        `CREATE TABLE IF NOT EXISTS protocolos (
            id INT AUTO_INCREMENT PRIMARY KEY,
            cd_estabelecimento VARCHAR(50),
            seq_protocolo VARCHAR(50),
            cd_protocolo VARCHAR(255),
            nr_seq_subtipo VARCHAR(50) UNIQUE,
            nm_protocolo VARCHAR(255),
            nm_subtipo VARCHAR(255),
            nr_ciclos VARCHAR(50), 
            nr_dias_intervalo VARCHAR(50),
            nm_usuario VARCHAR(100),
            atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS protocolo_tags (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nome VARCHAR(100) NOT NULL,
            cor VARCHAR(20) DEFAULT '#00855B'
        )`,
        `CREATE TABLE IF NOT EXISTS protocolo_vinculos (
            id_protocolo INT,
            id_tag INT,
            PRIMARY KEY (id_protocolo, id_tag),
            FOREIGN KEY (id_protocolo) REFERENCES protocolos(id) ON DELETE CASCADE,
            FOREIGN KEY (id_tag) REFERENCES protocolo_tags(id) ON DELETE CASCADE
        )`
    ];

    try {
        for (let sql of queries) await pool.query(sql);
        console.log("[PROTOCOLOS] Tabelas checadas/criadas com sucesso no MySQL.");
        res.json({ success: true });
    } catch (err) {
        console.error("❌ [PROTOCOLOS] Erro ao criar tabelas:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/protocolos/sync-tasy', async (req, res) => {
    console.log("=== INICIANDO SINCRONIZAÇÃO DE PROTOCOLOS (TASY) ===");
    let connection;
    try {
        console.log("[1/4] Conectando ao banco Oracle...");
        connection = await oracledb.getConnection(dbConfigOracle);
        console.log("[1/4] Conectado ao Oracle com sucesso.");
        
        // 💡 CORREÇÃO: Buscando DIRETO DA VIEW tasy.protocolos_eco em vez das tabelas base!
        const oracleSql = `
            SELECT 
                CD_ESTABELECIMENTO,
                SEQ_PROTOCOLO, 
                CD_PROTOCOLO,
                NR_SEQ_SUBTIPO,
                NM_PROTOCOLO,
                NM_SUBTIPO,
                NR_CICLOS,
                NR_DIAS_INTERVALO,
                NM_USUARIO
            FROM TASY.PROTOCOLOS_ECO
        `;
        
        console.log("[2/4] Executando Query na View TASY.PROTOCOLOS_ECO...");
        const resultOracle = await connection.execute(oracleSql);
        console.log(`[2/4] Query finalizada. Retornou ${resultOracle.rows ? resultOracle.rows.length : 0} linhas.`);

        let inserted = 0;
        if (resultOracle.rows && resultOracle.rows.length > 0) {
            console.log("[3/4] Inserindo dados no MySQL...");
            for (let i = 0; i < resultOracle.rows.length; i++) {
                let row = resultOracle.rows[i];
                try {
                    await pool.query(
                        `INSERT INTO protocolos 
                        (cd_estabelecimento, seq_protocolo, cd_protocolo, nr_seq_subtipo, nm_protocolo, nm_subtipo, nr_ciclos, nr_dias_intervalo, nm_usuario) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE 
                        cd_estabelecimento=VALUES(cd_estabelecimento), seq_protocolo=VALUES(seq_protocolo), cd_protocolo=VALUES(cd_protocolo), nm_protocolo=VALUES(nm_protocolo), nm_subtipo=VALUES(nm_subtipo), nr_ciclos=VALUES(nr_ciclos), nr_dias_intervalo=VALUES(nr_dias_intervalo), nm_usuario=VALUES(nm_usuario)`,
                        [
                            row.CD_ESTABELECIMENTO, 
                            row.SEQ_PROTOCOLO, 
                            row.CD_PROTOCOLO, 
                            row.NR_SEQ_SUBTIPO, 
                            row.NM_PROTOCOLO, 
                            row.NM_SUBTIPO, 
                            row.NR_CICLOS, 
                            row.NR_DIAS_INTERVALO, 
                            row.NM_USUARIO
                        ]
                    );
                    inserted++;
                } catch(mysqlErr) {
                    console.error(`❌ [MySQL] Falha ao inserir linha. Dados:`, row);
                    console.error(`Detalhe do erro MySQL:`, mysqlErr.message);
                    throw mysqlErr; 
                }
            }
            console.log(`[4/4] Inserção concluída! Processados: ${inserted}.`);
        }
        res.json({ success: true, total: resultOracle.rows ? resultOracle.rows.length : 0, inserted });
    } catch (err) {
        console.error("❌ ERRO FATAL NA SINCRONIZAÇÃO TASY:", err.message);
        res.status(500).json({ error: err.message });
    } finally {
        if (connection) {
            try { await connection.close(); } catch (e) { console.error(e); }
        }
        console.log("=== FIM DA TENTATIVA DE SINCRONIZAÇÃO ===");
    }
});

app.get('/protocolos', async (req, res) => {
    try {
        const sql = `
            SELECT 
                p.*,
                (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', t.id, 'nome', t.nome, 'cor', t.cor))
                 FROM protocolo_vinculos pv
                 JOIN protocolo_tags t ON pv.id_tag = t.id
                 WHERE pv.id_protocolo = p.id) as tags
            FROM protocolos p
            ORDER BY p.nm_protocolo ASC, p.nm_subtipo ASC
        `;
        const [rows] = await pool.query(sql);
        
        const data = rows.map(r => {
            if (typeof r.tags === 'string') {
                try { r.tags = JSON.parse(r.tags); } catch(e) { r.tags = []; }
            }
            if (!r.tags) r.tags = [];
            r.nr_sequencia = r.seq_protocolo; 
            r.cd_protocolo = r.nm_subtipo ? `${r.nm_protocolo} - ${r.nm_subtipo}` : r.nm_protocolo;
            return r;
        });

        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/protocolo-tags', async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT * FROM protocolo_tags ORDER BY nome ASC");
        res.json(Array.isArray(rows) ? rows : []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/protocolo-tags', async (req, res) => {
    const { nome, cor } = req.body;
    try {
        await pool.query("INSERT INTO protocolo_tags (nome, cor) VALUES (?, ?)", [nome, cor]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/protocolo-tags/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM protocolo_tags WHERE id = ?", [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/protocolos/:id/tags', async (req, res) => {
    const { tag_id } = req.body;
    try {
        await pool.query("INSERT IGNORE INTO protocolo_vinculos (id_protocolo, id_tag) VALUES (?, ?)", [req.params.id, tag_id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/protocolos/:protocolId/tags/:tagId', async (req, res) => {
    try {
        await pool.query("DELETE FROM protocolo_vinculos WHERE id_protocolo = ? AND id_tag = ?", [req.params.protocolId, req.params.tagId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================================
// --- ROTA DE LEITURA DO SISTEMA ---
// ============================================================================
app.get('/system_configs', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM system_configs');
        const configs = {};
        rows.forEach(row => {
            try { configs[row.id_firebase] = JSON.parse(row.dados_extras); } catch(e) {}
        });
        res.json(configs);
    } catch (e) { res.json({}); }
});

app.post('/system_configs', async (req, res) => {
    const { id_firebase, ...data } = req.body;
    try {
        await pool.query(
            `INSERT INTO system_configs (id_firebase, dados_extras) VALUES (?, ?) 
             ON DUPLICATE KEY UPDATE dados_extras = VALUES(dados_extras)`,
            [id_firebase, JSON.stringify(data)]
        );
        res.json({ success: true });
    } catch (e) {
        if (e.code === 'ER_NO_SUCH_TABLE') {
            await pool.query(`CREATE TABLE system_configs (id INT AUTO_INCREMENT PRIMARY KEY, id_firebase VARCHAR(100) UNIQUE, dados_extras JSON)`);
            await pool.query(
                `INSERT INTO system_configs (id_firebase, dados_extras) VALUES (?, ?) 
                 ON DUPLICATE KEY UPDATE dados_extras = VALUES(dados_extras)`,
                [id_firebase, JSON.stringify(data)]
            );
            res.json({ success: true });
        } else {
            console.error("Erro Config:", e);
            res.status(500).json({ error: e.message });
        }
    }
});

app.post('/auth/login', async (req, res) => {
    const { email, name, photo } = req.body;
    if (!email || (!email.split('@')[1].includes('ecooncologia.com.br') && !email.split('@')[1].includes('weega.com.br'))) return res.status(403).json({ error: 'Acesso restrito.' });
    const emailKey = email.replace(/\./g, ',');

    try {
        const [rows] = await pool.query('SELECT * FROM usuarios WHERE id_firebase = ?', [emailKey]);
        let userData = { email, nome: name, foto: photo, lastLogin: new Date().toISOString() };

        if (rows.length > 0) {
            let existing = JSON.parse(rows[0].dados_extras || '{}');
            let sqlPerms = null;
            try { sqlPerms = (typeof rows[0].permissoes === 'string') ? JSON.parse(rows[0].permissoes) : rows[0].permissoes; } catch(e){}
            if (sqlPerms) userData.permissoes = sqlPerms;
            else if (existing.permissoes) userData.permissoes = existing.permissoes;
            userData = { ...existing, ...userData };
            await pool.query('UPDATE usuarios SET dados_extras = ?, last_login = NOW() WHERE id_firebase = ?', [JSON.stringify(userData), emailKey]);
        } else {
            userData.permissoes = { dashboard: false, admin: false, helpdesk: true };
            await pool.query('INSERT INTO usuarios (id_firebase, nome, email, foto, permissoes, last_login, dados_extras) VALUES (?, ?, ?, ?, ?, NOW(), ?)', 
                [emailKey, name, email, photo, JSON.stringify(userData.permissoes), JSON.stringify(userData)]);
        }
        res.json({ success: true, user: userData });
    } catch (e) { res.status(500).json({ error: 'Erro interno no login' }); }
});

app.post('/auth/login_teste', async (req, res) => {
    const { email, senha } = req.body;

    if (senha !== 'teste123') {
        return res.status(401).json({ success: false, error: 'Senha de homologação incorreta.' });
    }

    try {
        const [rows] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [email]);
        
        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Usuário não encontrado.' });
        }

        const user = rows[0];
        if (typeof user.permissoes === 'string') {
            try { user.permissoes = JSON.parse(user.permissoes); } catch(e) {}
        }

        res.json({ success: true, user });

    } catch (error) {
        res.status(500).json({ success: false, error: 'Erro interno no servidor.' });
    }
});

const GOOGLE_REVIEW_LINK = "https://g.page/r/CeOCD4ApuBEOEAE/review"; 
const CARIMBO_GLOBAL = "eco_ja_avaliou_clinica";

app.get('/avaliar', (req, res) => {
    const funcId = req.query.func_id;
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

    if (!funcId) return res.redirect(GOOGLE_REVIEW_LINK);

    const cookies = req.headers.cookie || '';
    if (cookies.includes(`${CARIMBO_GLOBAL}=true`)) {
        return res.redirect(GOOGLE_REVIEW_LINK);
    }

    res.cookie(CARIMBO_GLOBAL, 'true', { maxAge: 10 * 365 * 24 * 60 * 60 * 1000, httpOnly: false, path: '/' });

    const html = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <title>Avaliação Eco Oncologia</title>
        <style>
            body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background-color: #f9f9f9; color: #00855B; margin: 0; text-align: center; }
            .spinner { width: 40px; height: 40px; border: 4px solid #ddd; border-top: 4px solid #00855B; border-radius: 50%; animation: spin 1s linear infinite; margin-bottom: 20px; }
            @keyframes spin { 100% { transform: rotate(360deg); } }
        </style>
    </head>
    <body>
        <div class="spinner"></div><h2>Preparando avaliação...</h2>
        <script>
            if (localStorage.getItem("${CARIMBO_GLOBAL}")) { window.location.replace("${GOOGLE_REVIEW_LINK}"); } 
            else {
                localStorage.setItem("${CARIMBO_GLOBAL}", 'true');
                fetch('/registrar_ponto?func_id=${funcId}', { method: 'POST' }).then(() => window.location.replace("${GOOGLE_REVIEW_LINK}")).catch(() => window.location.replace("${GOOGLE_REVIEW_LINK}"));
            }
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

app.post('/registrar_ponto', async (req, res) => {
    const funcId = req.query.func_id;
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

    if (!funcId) return res.status(400).json({ error: "Faltando func_id" });

    try {
        try {
            const fbRes = await fetch(`${FIREBASE_DB_URL}/intranet/ranking.json`);
            const rankingData = await fbRes.json();
            
            if (rankingData) {
                for (const [key, funcData] of Object.entries(rankingData)) {
                    if (funcData.qrId === funcId || key === funcId) {
                        const novosPontosTotais = (funcData.pontos || 0) + 1;
                        const novosPontosMes = (funcData.pontos_mes || 0) + 1; 
                        
                        await fetch(`${FIREBASE_DB_URL}/intranet/ranking/${key}.json`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ pontos: novosPontosTotais, pontos_mes: novosPontosMes })
                        });
                        break;
                    }
                }
            }
        } catch (fbErro) {
            console.error("[Ranking] Erro Firebase:", fbErro);
        }

        await pool.query('INSERT INTO qr_scans (func_qr_id, ip_address) VALUES (?, ?)', [funcId, ip]);
        await pool.query('INSERT INTO avaliacoes_google (review_id, func_qr_id, reviewer_name, rating, created_at) VALUES (?, ?, ?, ?, NOW())', ["QR_" + Date.now(), funcId, `Acesso HTML IP: ${ip}`, 5]);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/webhook-ata', async (req, res) => {
    const chaveRecebida = req.headers['x-api-key'] || req.query.api_key || req.body.api_key;
    if (chaveRecebida !== CHAVE_MESTRA) return res.status(401).json({ erro: "Acesso Negado: Chave de API inválida." });

    try {
        const { title, date, resumo, transcript } = req.body;
        let ataFinal = "🎙️ Registro Automático - Resumo Executivo\n\n" + (resumo || transcript || "Nenhum resumo foi gerado.");
        let dataBusca = date ? (date.includes('T') ? date.split('T')[0] : date) : new Date().toISOString().split('T')[0];
        
        const [rows] = await pool.query('SELECT id_firebase, dados_extras FROM events WHERE date = ? LIMIT 1', [dataBusca]);

        if (rows.length > 0) {
            const id = rows[0].id_firebase;
            const dadosExtras = JSON.parse(rows[0].dados_extras || '{}');
            dadosExtras.ata = ataFinal;
            await pool.query('UPDATE events SET dados_extras = ? WHERE id_firebase = ?', [JSON.stringify(dadosExtras), id]);
            return res.json({ success: true, eventId: id });
        } else {
            const novoId = `ff_${Date.now()}`;
            const dadosExtras = { name: `Reunião: ${title || 'Sincronização'}`, date: dataBusca, ata: ataFinal, type: 'reuniao' };
            await pool.query(`INSERT INTO events (id_firebase, name, date, timestamp, dados_extras) VALUES (?, ?, ?, NOW(), ?)`, [novoId, dadosExtras.name, dataBusca, JSON.stringify(dadosExtras)]);
            return res.json({ success: true, eventId: novoId });
        }
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// --- ROTA DE LEITURA (GET) ---
// ============================================================================
app.get('/:tabela', async (req, res, next) => {
    const { tabela } = req.params;
    if (tabela === 'custos_oracle') return next();

    if (tabela.startsWith('escala_mensal') || tabela.startsWith('plantoes') || tabela.startsWith('plantao')) {
        try {
            let dbTable = 'plantoes';
            let sufixo = '';
            
            if (tabela.includes('vita_quimio')) { dbTable = 'plantoes_vita_quimio'; sufixo = '-vita_quimio'; }
            else if (tabela.includes('vita_sobreaviso')) { dbTable = 'plantoes_vita_sobreaviso'; sufixo = '-vita_sobreaviso'; }
            else if (tabela.includes('cirurgioes')) { dbTable = 'plantoes_cirurgioes'; sufixo = '-cirurgioes'; }

            const [rows] = await pool.query(`SELECT medico_id, DATE_FORMAT(data_plantao, '%Y-%m-%d') as data_str, tipo FROM ${dbTable}`);
            const resultado = {};
            
            rows.forEach(row => {
                if (!row.data_str) return;
                const [ano, mes, dia] = row.data_str.split('-');
                const key = sufixo ? `${ano}-${mes}${sufixo}` : `${ano}-${mes}`;
                
                if (!resultado[key]) resultado[key] = { id_firebase: key };
                if (!resultado[key][row.medico_id]) resultado[key][row.medico_id] = {};
                resultado[key][row.medico_id][parseInt(dia, 10)] = row.tipo;
            });
            return res.json(resultado);
        } catch (e) { return res.json({}); }
    }

    try {
        let tabelaSQL = tabela;
        if (tabela === 'selos_registros') tabelaSQL = 'selos';
        if (tabela === 'chamados') tabelaSQL = 'helpdesk_tickets';

        if (tabela === 'grupos_medicos') {
            try { await pool.query('SELECT 1 FROM grupos_medicos LIMIT 1'); } 
            catch(e) { if (e.code === 'ER_NO_SUCH_TABLE') { await pool.query(`CREATE TABLE grupos_medicos (id INT AUTO_INCREMENT PRIMARY KEY, id_firebase VARCHAR(100) UNIQUE, dados_extras JSON)`); } }
        }

        const [rows] = await pool.query(`SELECT * FROM ${tabelaSQL}`);
        const resultado = {};

        rows.forEach(linha => {
            let dados = {};
            try { dados = JSON.parse(linha.dados_extras || '{}'); } catch(e) {}
            
            // 💡 MESCLAGEM P/ EVITAR DESVÍNCULO: Mantém dados nativos
            dados = { ...linha, ...dados };
            dados.id_firebase = linha.id_firebase;

            if (tabelaSQL === 'helpdesk_tickets') {
                dados.ticket_id = linha.id;
                dados.uid = linha.uid; dados.user = linha.user; dados.setor = linha.setor;
                dados.categoria = linha.categoria; dados.assunto = linha.assunto;
                dados.desc = linha.desc_texto; dados.status = linha.status; 
                dados.rate = linha.rate; dados.solution = linha.solution;
                dados.date = linha.data_abertura ? new Date(linha.data_abertura).getTime() : dados.date;
            }
            else if (tabela === 'orcamentos') {
                dados.paciente = linha.paciente_nome || dados.paciente;
                dados.responsavel = linha.responsavel || dados.responsavel;
                dados.valor_final = linha.valor_final ? parseFloat(Number(linha.valor_final).toFixed(2)) : 0;
                dados.status = linha.status || dados.status;
                const d = safeIsoDate(linha.data_criacao);
                dados.data = d ? d : dados.data;
            }
            else if (tabela === 'vendas') {
                dados.paciente = linha.paciente_nome; 
                dados.medico = linha.medico_nome;
                dados.valor_final = linha.valor_total ? parseFloat(Number(linha.valor_total).toFixed(2)) : 0;
                dados.valor_pago = linha.valor_pago ? parseFloat(Number(linha.valor_pago).toFixed(2)) : 0;
                dados.saldo_devedor = linha.saldo_devedor ? parseFloat(Number(linha.saldo_devedor).toFixed(2)) : 0;
                dados.forma_pagamento = linha.forma_pagamento || dados.forma_pagamento || 'Dinheiro';
                dados.custo_correto = linha.custo_correto !== undefined && linha.custo_correto !== null ? parseFloat(linha.custo_correto) : (dados.custo_correto || 0);
                dados.custo_errado = linha.custo_errado !== undefined && linha.custo_errado !== null ? parseFloat(linha.custo_errado) : (dados.custo_errado || 0);
                dados.data = safeIsoDate(linha.data_venda) || dados.data;
            }
            else if (tabela === 'painAssessments') {
                dados.name = linha.titulo_principal;
                dados.status = linha.status; 
                dados.atendido = (linha.atendido === 1); 
                dados.origin = linha.origin;
                dados.painLevel = linha.pain_level; 
                dados.painEmoji = linha.pain_emoji;
                dados.emotion = linha.emotion;
                dados.careNeed = linha.care_need;
                if(linha.data_registro) dados.timestamp = new Date(linha.data_registro).toISOString();
            }
            else if (tabela === 'medicos') { dados.nome = linha.nome; dados.plantao = linha.plantao; }
            else if (tabela === 'procedimentos') { dados.nome = linha.nome; dados.tipo = linha.tipo; dados.custo_procedimento = linha.custo_procedimento; }
            else if (tabela === 'events') { dados.name = linha.name; dados.date = safeIsoDate(linha.date); dados.time = linha.time; dados.timestamp = linha.timestamp; }
            else if (tabela === 'participants') { dados.eventId = linha.eventId || dados.eventId; dados.name = linha.name || dados.name; dados.phone = linha.phone || dados.phone; dados.present = (linha.present === 1) || (dados.present === true); dados.readAta = (linha.read_ata === 1) || (dados.readAta === true) || false; dados.source = linha.source || dados.source; dados.timestamp = linha.timestamp || dados.timestamp; }
            else if (tabela === 'winners') { dados.eventId = linha.eventId; dados.winnerName = linha.winnerName; dados.winnerPhone = linha.winnerPhone; dados.timestamp = linha.timestamp; }
            else if (tabelaSQL === 'repasse_unimed') {
                dados.competencia = linha.competencia; dados.paciente = linha.paciente; dados.data_atendimento = linha.data_atendimento; dados.descricao = linha.descricao; dados.tipo = linha.tipo; dados.quantidade = linha.quantidade ? parseFloat(linha.quantidade) : 0; dados.valor_pago = linha.valor_pago ? parseFloat(linha.valor_pago) : 0; dados.is_med_item = (linha.is_med_item === 1);
                let custoCorretoAntigo = dados.custo_correto ? parseFloat(dados.custo_correto) : 0;
                let custoErradoAntigo = dados.custo_errado ? parseFloat(dados.custo_errado) : 0;
                let custoCorretoNovo = linha.custo_correto !== undefined && linha.custo_correto !== null ? parseFloat(linha.custo_correto) : 0;
                let custoErradoNovo = linha.custo_errado !== undefined && linha.custo_errado !== null ? parseFloat(linha.custo_errado) : 0;
                dados.custo_correto = custoCorretoNovo > 0 ? custoCorretoNovo : custoCorretoAntigo;
                dados.custo_errado = custoErradoNovo > 0 ? custoErradoNovo : custoErradoAntigo;
            }

            dados.id = linha.id || linha.id_firebase;
            const returnKey = (tabelaSQL === 'repasse_unimed' || tabelaSQL === 'vendas') ? (linha.id || linha.id_firebase) : linha.id_firebase;
            resultado[returnKey] = dados;
        });
        res.json(resultado);
    } catch (e) { res.json({}); }
});

app.post('/notificar-whatsapp', async (req, res) => {
    try {
        const { numero, mensagem } = req.body;
        if (!numero || !mensagem) return res.status(400).json({ error: "Faltam parâmetros." });

        const response = await fetch('http://127.0.0.1:3005/enviar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ numero, mensagem })
        });

        if (!response.ok) throw new Error("O Robô recusou o envio.");
        res.json(await response.json());
    } catch (error) { res.status(500).json({ error: "Falha de comunicação." }); }
});

// ============================================================================
// ✍️ ROTA DE ESCRITA (POST / PUT) - JSON_MERGE_PATCH
// ============================================================================
async function handleSave(req, res, next) {
    const { tabela, id } = req.params;
    if (tabela === 'custos_oracle') return next();

    const dados = req.body;
    const finalId = id || dados.id_firebase || `auto_${Date.now()}`;
    let tabelaSQL = tabela;
    
    if (tabela === 'selos_registros') tabelaSQL = 'selos';
    if (tabela === 'chamados') tabelaSQL = 'helpdesk_tickets';

    try {
        if (tabela.startsWith('escala_mensal') || tabela.startsWith('plantoes') || tabela.startsWith('plantao')) {
            let dbTable = 'plantoes';
            if (tabela.includes('vita_quimio') || finalId.includes('vita_quimio')) dbTable = 'plantoes_vita_quimio';
            else if (tabela.includes('vita_sobreaviso') || finalId.includes('vita_sobreaviso')) dbTable = 'plantoes_vita_sobreaviso';
            else if (tabela.includes('cirurgioes') || finalId.includes('cirurgioes')) dbTable = 'plantoes_cirurgioes';

            const partes = finalId.split('-');
            if(!partes[0] || !partes[1]) return res.status(400).json({error: "ID inválido."});
            const anoMes = `${partes[0]}-${partes[1]}`;

            for (const [medicoId, dias] of Object.entries(dados)) {
                if (medicoId === 'id_firebase' || medicoId === 'id' || medicoId === 'obs') continue;
                if (typeof dias !== 'object' || dias === null) continue;
                for (const [dia, tipo] of Object.entries(dias)) {
                    if (isNaN(dia) || dia === null || dia === '') continue;
                    const dataPlantao = `${anoMes}-${String(dia).padStart(2,'0')}`;
                    try {
                        await pool.query(`DELETE FROM ${dbTable} WHERE medico_id=? AND data_plantao=?`, [medicoId, dataPlantao]);
                        if (tipo && ['M', 'T', 'M/T', 'S'].includes(tipo)) {
                            await pool.query(`INSERT INTO ${dbTable} (medico_id, data_plantao, tipo) VALUES (?, ?, ?)`, [medicoId, dataPlantao, tipo]);
                        }
                    } catch (sqlError) {}
                }
            }
            return res.json({ success: true });
        }
        else if (tabela === 'usuarios') {
            let permsObj = dados.permissoes || {};
            if (typeof permsObj === 'string') { try { permsObj = JSON.parse(permsObj); } catch(e) {} }
            await pool.query(`INSERT INTO usuarios (id_firebase, nome, email, foto, permissoes, last_login, dados_extras) VALUES (?, ?, ?, ?, ?, NOW(), ?) ON DUPLICATE KEY UPDATE permissoes = VALUES(permissoes), nome = VALUES(nome), dados_extras = JSON_MERGE_PATCH(COALESCE(dados_extras, '{}'), ?)`, [finalId, dados.nome, dados.email, dados.foto||'', JSON.stringify(permsObj), JSON.stringify(dados), JSON.stringify(dados)]);
        }
        else if (tabela === 'patientCalls') {
            await pool.query(`INSERT INTO patientCalls (id_firebase, patientId, patientName, origin, status, timestamp, transportStartTime, transportEndTime, dados_extras) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status=VALUES(status), transportStartTime=VALUES(transportStartTime), transportEndTime=VALUES(transportEndTime), dados_extras = JSON_MERGE_PATCH(COALESCE(dados_extras, '{}'), ?)`,
            [finalId, dados.patientId || null, dados.patientName || dados.name, dados.origin || null,
            dados.status || 'waiting',   // ← CORRIGIDO
            limparData(dados.timestamp), limparData(dados.transportStartTime), limparData(dados.transportEndTime), JSON.stringify(dados), JSON.stringify(dados)]);
        }
        else if (tabela === 'painAssessments') {
            const valPain = dados.painLevel || dados.pain_level || dados.nivel_dor || null;
            const valEmoji = dados.painEmoji || dados.pain_emoji || null;
            const valEmotion = dados.emotion || dados.emocao || null;
            const valCare = dados.careNeed || dados.care_need || dados.necessidade || null;
            const valName = dados.name || dados.titulo_principal || 'Sem Nome';

            await pool.query(`INSERT INTO painAssessments (id_firebase, data_registro, titulo_principal, origin, status, atendido, pain_level, pain_emoji, emotion, care_need, dados_extras) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status=VALUES(status), atendido=VALUES(atendido), pain_level=VALUES(pain_level), pain_emoji=VALUES(pain_emoji), emotion=VALUES(emotion), care_need=VALUES(care_need), dados_extras = JSON_MERGE_PATCH(COALESCE(dados_extras, '{}'), ?)`, [finalId, limparData(dados.timestamp), valName, dados.origin || null, dados.status, dados.atendido ? 1 : 0, valPain, valEmoji, valEmotion, valCare, JSON.stringify(dados), JSON.stringify(dados)]);
        }
        else if (tabelaSQL === 'helpdesk_tickets') {
            if (!id && req.method === 'POST') avisarTeams(dados); 
            if (id) {
                const [currentRows] = await pool.query('SELECT status FROM helpdesk_tickets WHERE id_firebase = ?', [id]);
                const statusAntigo = currentRows.length > 0 ? currentRows[0].status : null;
                if (dados.status === 'finalizado' && statusAntigo !== 'finalizado') {
                    try { await transporter.sendMail({ from: '"Suporte TI - ONCO SMART" <suporte.ecooncologia@gmail.com>', to: dados.uid, subject: `✅ Chamado Encerrado: #${dados.ticket_id || '0000'} - ${dados.assunto}`, html: `<p>Resolvido.</p>` }); } catch(emailErr) {}
                }
                if (statusAntigo === 'finalizado' && dados.status === 'pendente') avisarTeams(dados, true); 
            }
            await pool.query(`INSERT INTO helpdesk_tickets (id_firebase, uid, user, setor, categoria, assunto, desc_texto, status, sla, data_abertura, rate, solution, elapsedTime, lastResumeTime, closedAt, dados_extras) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE uid=VALUES(uid), user=VALUES(user), setor=VALUES(setor), categoria=VALUES(categoria), assunto=VALUES(assunto), desc_texto=VALUES(desc_texto), status=VALUES(status), sla=VALUES(sla), data_abertura=VALUES(data_abertura), rate=VALUES(rate), solution=VALUES(solution), elapsedTime=VALUES(elapsedTime), lastResumeTime=VALUES(lastResumeTime), closedAt=VALUES(closedAt), dados_extras = JSON_MERGE_PATCH(COALESCE(dados_extras, '{}'), ?)`, [finalId, dados.uid || null, dados.user || null, dados.setor || null, dados.categoria || null, dados.assunto || null, dados.desc || null, dados.status || 'pendente', dados.sla || null, limparData(dados.date), dados.rate || null, dados.solution || null, dados.elapsedTime || 0, dados.lastResumeTime || null, dados.closedAt || null, JSON.stringify(dados), JSON.stringify(dados)]);
        }
        else if (tabela === 'orcamentos') { 
            const cleanVal = (v) => {
                if (v === null || v === undefined || v === '') return 0;
                if (typeof v === 'number') return parseFloat(v.toFixed(2));
                let s = String(v).replace(/[^\d.,-]/g, '');
                if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
                else if (s.includes(',')) s = s.replace(',', '.');
                const num = parseFloat(s);
                return isNaN(num) ? 0 : parseFloat(num.toFixed(2));
            };
            const valFinal = cleanVal(dados.valor_final);
            await pool.query(`INSERT INTO orcamentos (id_firebase, paciente_nome, responsavel, valor_final, status, data_criacao, dados_extras) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE paciente_nome=VALUES(paciente_nome), responsavel=VALUES(responsavel), valor_final=VALUES(valor_final), status=VALUES(status), dados_extras = JSON_MERGE_PATCH(COALESCE(dados_extras, '{}'), ?)`, [finalId, dados.paciente || dados.paciente_nome, dados.responsavel || dados.usuario, valFinal, dados.status || 'Pendente', limparData(dados.data), JSON.stringify(dados), JSON.stringify(dados)]); 
        }
        else if (tabela === 'vendas') { 
            let dF = new Date(); 
            if (dados.data) { 
                if(dados.data.includes('/')) { const [d, m, y] = dados.data.split('/'); dF = new Date(`${y}-${m}-${d}T${dados.hora_entrada || '00:00:00'}`); } 
                else dF = new Date(`${dados.data}T${dados.hora_entrada || '00:00:00'}`); 
            } 
            
            try { await pool.query("ALTER TABLE vendas ADD COLUMN custo_correto DECIMAL(12,4) DEFAULT 0"); } catch(e){}
            try { await pool.query("ALTER TABLE vendas ADD COLUMN custo_errado DECIMAL(12,4) DEFAULT 0"); } catch(e){}
            
            const cleanVal = (v) => {
                if (v === null || v === undefined || v === '') return 0;
                if (typeof v === 'number') return parseFloat(v.toFixed(2));
                let s = String(v).replace(/[^\d.,-]/g, '');
                if (s.includes(',') && s.includes('.')) { let lastDot = s.lastIndexOf('.'); let lastComma = s.lastIndexOf(','); if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, ''); } 
                else if (s.includes(',')) s = s.replace(',', '.');
                else if (s.includes('.')) { let parts = s.split('.'); if (parts[parts.length - 1].length === 3) s = s.replace(/\./g, ''); }
                const num = parseFloat(s); return isNaN(num) ? 0 : parseFloat(num.toFixed(2));
            };

            const vTot = cleanVal(dados.valor_final || dados.valor_total);
            const vPag = cleanVal(dados.valor_pago);
            const saldo = parseFloat((vTot - vPag).toFixed(2));
            const fp = dados.forma_pagamento || null;

            if (!isNaN(id)) {
                await pool.query(`UPDATE vendas SET data_venda=?, paciente_nome=?, medico_nome=?, valor_total=?, valor_pago=?, saldo_devedor=?, forma_pagamento=?, custo_correto=IF(? IS NOT NULL, ?, custo_correto), custo_errado=IF(? IS NOT NULL, ?, custo_errado), dados_extras = JSON_MERGE_PATCH(COALESCE(dados_extras, '{}'), ?) WHERE id=?`, [limparData(dF), dados.paciente, dados.medico, vTot, vPag, saldo, fp, dados.custo_correto !== undefined ? dados.custo_correto : null, dados.custo_correto !== undefined ? dados.custo_correto : null, dados.custo_errado !== undefined ? dados.custo_errado : null, dados.custo_errado !== undefined ? dados.custo_errado : null, JSON.stringify(dados), id]);
            } else {
                await pool.query(`INSERT INTO vendas (id_firebase, data_venda, paciente_nome, medico_nome, valor_total, valor_pago, saldo_devedor, forma_pagamento, custo_correto, custo_errado, dados_extras) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE data_venda=VALUES(data_venda), paciente_nome=VALUES(paciente_nome), medico_nome=VALUES(medico_nome), valor_total=VALUES(valor_total), valor_pago=VALUES(valor_pago), saldo_devedor=VALUES(saldo_devedor), forma_pagamento=VALUES(forma_pagamento), custo_correto=IF(VALUES(custo_correto) IS NOT NULL, VALUES(custo_correto), custo_correto), custo_errado=IF(VALUES(custo_errado) IS NOT NULL, VALUES(custo_errado), custo_errado), dados_extras = JSON_MERGE_PATCH(COALESCE(dados_extras, '{}'), ?)`, [finalId, limparData(dF), dados.paciente, dados.medico, vTot, vPag, saldo, fp, dados.custo_correto !== undefined ? dados.custo_correto : null, dados.custo_errado !== undefined ? dados.custo_errado : null, JSON.stringify(dados), JSON.stringify(dados)]);
            }
        }
        else if (tabela === 'medicos') { 
            await pool.query(`INSERT INTO medicos (id_firebase, nome, plantao, dados_extras) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE nome=VALUES(nome), plantao=VALUES(plantao), dados_extras = JSON_MERGE_PATCH(COALESCE(dados_extras, '{}'), ?)`, [finalId, dados.nome, dados.plantao || 'nao', JSON.stringify(dados), JSON.stringify(dados)]); 
        }
        else if (tabela === 'procedimentos') { 
            await pool.query(`INSERT INTO procedimentos (id_firebase, nome, tipo, custo_material, custo_medicamento, custo_procedimento, desconto, dados_extras) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE nome=VALUES(nome), tipo=VALUES(tipo), custo_material=VALUES(custo_material), custo_medicamento=VALUES(custo_medicamento), custo_procedimento=VALUES(custo_procedimento), desconto=VALUES(desconto), dados_extras = JSON_MERGE_PATCH(COALESCE(dados_extras, '{}'), ?)`, [finalId, dados.nome, dados.tipo, dados.custo_material||0, dados.custo_medicamento||0, dados.custo_procedimento||0, dados.desconto||0, JSON.stringify(dados), JSON.stringify(dados)]); 
        }
        else if (tabelaSQL === 'selos') { 
            let dtStr = limparData(new Date()); if(dados.data) dtStr = dados.data;
            await pool.query(`INSERT INTO selos (id_firebase, data_registro, titulo_principal, paciente, secretaria, tipo, data, hora_entrada, hora_saida, horas_total, dados_extras) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE paciente=VALUES(paciente), secretaria=VALUES(secretaria), tipo=VALUES(tipo), data=VALUES(data), hora_entrada=VALUES(hora_entrada), hora_saida=VALUES(hora_saida), horas_total=VALUES(horas_total), dados_extras = JSON_MERGE_PATCH(COALESCE(dados_extras, '{}'), ?)`, [finalId, limparData(new Date()), dados.titulo_principal || dados.paciente, dados.paciente, dados.secretaria, dados.tipo, dtStr, dados.horaEntrada || dados.hora_entrada, dados.horaSaida || dados.hora_saida, dados.horasTotal || dados.horas_total, JSON.stringify(dados), JSON.stringify(dados)]);
        }
        else if (tabela === 'selos_estoque') { 
            const label = dados.tipo === 'horas' ? `${dados.duracao}h` : `${dados.duracao}min`; 
            await pool.query(`INSERT INTO selos_estoque (id_firebase, nome, quantidade, dados_extras) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE nome=VALUES(nome), quantidade=VALUES(quantidade), dados_extras = JSON_MERGE_PATCH(COALESCE(dados_extras, '{}'), ?)`, [finalId, dados.nome || label, dados.quantidade || 0, JSON.stringify(dados), JSON.stringify(dados)]); 
        }
        else if (tabela === 'selos_secretarias') { 
            await pool.query(`INSERT INTO selos_secretarias (id_firebase, nome, dados_extras) VALUES (?,?,?) ON DUPLICATE KEY UPDATE nome=VALUES(nome), dados_extras = JSON_MERGE_PATCH(COALESCE(dados_extras, '{}'), ?)`, [finalId, dados.nome, JSON.stringify(dados), JSON.stringify(dados)]); 
        }
        else if (tabela === 'events') {
            let dataCorreta = dados.date;
            if (dataCorreta && dataCorreta.includes('T')) { dataCorreta = dataCorreta.split('T')[0]; }
            await pool.query(`INSERT INTO events (id_firebase, name, date, time, timestamp, dados_extras) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name), date=VALUES(date), time=VALUES(time), dados_extras = JSON_MERGE_PATCH(COALESCE(dados_extras, '{}'), ?)`, [finalId, dados.name, dataCorreta, dados.time || null, limparData(dados.timestamp), JSON.stringify(dados), JSON.stringify(dados)]);
        }
        else if (tabela === 'participants') {
            await pool.query(`INSERT INTO participants (id_firebase, eventId, name, phone, present, read_ata, source, timestamp, dados_extras) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name), phone=VALUES(phone), present=VALUES(present), read_ata=VALUES(read_ata), source=VALUES(source), dados_extras = JSON_MERGE_PATCH(COALESCE(dados_extras, '{}'), ?)`, [finalId, dados.eventId, dados.name, dados.phone, dados.present ? 1 : 0, dados.readAta ? 1 : 0, dados.source || 'manual', limparData(dados.timestamp), JSON.stringify(dados), JSON.stringify(dados)]);
        }
        else if (tabela === 'winners') {
            await pool.query(`INSERT INTO winners (id_firebase, eventId, winnerName, winnerPhone, timestamp, dados_extras) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE dados_extras = JSON_MERGE_PATCH(COALESCE(dados_extras, '{}'), ?)`, [finalId, dados.eventId, dados.winnerName, dados.winnerPhone, limparData(dados.timestamp), JSON.stringify(dados), JSON.stringify(dados)]);
        }
        else if (tabelaSQL === 'repasse_unimed') {
            await pool.query(`CREATE TABLE IF NOT EXISTS repasse_unimed (id INT AUTO_INCREMENT PRIMARY KEY, id_firebase VARCHAR(100) UNIQUE, competencia VARCHAR(20), paciente VARCHAR(255), data_atendimento VARCHAR(50), descricao TEXT, tipo VARCHAR(50), quantidade DECIMAL(10,2), valor_pago DECIMAL(10,2), is_med_item BOOLEAN, dados_extras JSON)`);
            try { await pool.query("ALTER TABLE repasse_unimed ADD COLUMN custo_correto DECIMAL(12,4) DEFAULT 0"); } catch(e){}
            try { await pool.query("ALTER TABLE repasse_unimed ADD COLUMN custo_errado DECIMAL(12,4) DEFAULT 0"); } catch(e){}

            let dbId = isNaN(id) ? finalId : id; 
            let idField = isNaN(id) ? "id_firebase" : "id";
            
            if (!isNaN(id)) {
                await pool.query(`UPDATE repasse_unimed SET custo_correto = IF(? IS NOT NULL, ?, custo_correto), custo_errado = IF(? IS NOT NULL, ?, custo_errado), dados_extras = JSON_MERGE_PATCH(COALESCE(dados_extras, '{}'), ?) WHERE id = ?`, [dados.custo_correto !== undefined ? dados.custo_correto : null, dados.custo_correto !== undefined ? dados.custo_correto : null, dados.custo_errado !== undefined ? dados.custo_errado : null, dados.custo_errado !== undefined ? dados.custo_errado : null, JSON.stringify(dados), id]);
            } else {
                await pool.query(`INSERT INTO repasse_unimed (${idField}, competencia, paciente, data_atendimento, descricao, tipo, quantidade, valor_pago, custo_correto, custo_errado, is_med_item, dados_extras) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE competencia=VALUES(competencia), paciente=VALUES(paciente), data_atendimento=VALUES(data_atendimento), descricao=VALUES(descricao), tipo=VALUES(tipo), quantidade=VALUES(quantidade), valor_pago=VALUES(valor_pago), custo_correto=IF(VALUES(custo_correto) IS NOT NULL, VALUES(custo_correto), custo_correto), custo_errado=IF(VALUES(custo_errado) IS NOT NULL, VALUES(custo_errado), custo_errado), is_med_item=VALUES(is_med_item), dados_extras = JSON_MERGE_PATCH(COALESCE(dados_extras, '{}'), ?)`, [dbId, dados.competencia || '', dados.paciente || '', dados.data_atendimento || '', dados.descricao || '', dados.tipo || 'MED', dados.quantidade || 1, dados.valor_pago || 0, dados.custo_correto !== undefined ? dados.custo_correto : null, dados.custo_errado !== undefined ? dados.custo_errado : null, dados.is_med_item ? 1 : 0, JSON.stringify(dados), JSON.stringify(dados)]);
            }
        }
        else {
            try { 
                await pool.query(`INSERT INTO ${tabelaSQL} (id_firebase, dados_extras) VALUES (?, ?) ON DUPLICATE KEY UPDATE dados_extras = JSON_MERGE_PATCH(COALESCE(dados_extras, '{}'), ?)`, [finalId, JSON.stringify(dados), JSON.stringify(dados)]); 
            } catch (err) {
                if (err.code === 'ER_NO_SUCH_TABLE') { 
                    await pool.query(`CREATE TABLE ${tabelaSQL} (id INT AUTO_INCREMENT PRIMARY KEY, id_firebase VARCHAR(100) UNIQUE, dados_extras JSON)`); 
                    await pool.query(`INSERT INTO ${tabelaSQL} (id_firebase, dados_extras) VALUES (?, ?)`, [finalId, JSON.stringify(dados)]); 
                } else throw err;
            }
        }
        res.json({ success: true, id: finalId });
    } catch (e) {
        console.error(`Erro SAVE ${tabela}:`, e);
        res.status(500).json({ error: e.message });
    }
}

app.post('/:tabela', handleSave);
app.put('/:tabela/:id', handleSave);

app.delete('/:tabela/:id', async (req, res) => {
    let tabelaSQL = req.params.tabela;
    if(tabelaSQL === 'selos_registros') tabelaSQL = 'selos';
    if(tabelaSQL === 'chamados') tabelaSQL = 'helpdesk_tickets';
    
    try { 
        if (!isNaN(req.params.id)) {
            await pool.query(`DELETE FROM ${tabelaSQL} WHERE id = ? OR id_firebase = ?`, [req.params.id, String(req.params.id)]); 
        } else {
            await pool.query(`DELETE FROM ${tabelaSQL} WHERE id_firebase = ?`, [req.params.id]); 
        }
        res.json({ ok: true }); 
    } 
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================================
// 🔄 ROTINA AUTOMÁTICA DE VIRADA DE MÊS (RANKING)
// ============================================================================
setInterval(async () => {
    try {
        const mesAtual = new Date().getMonth(); 
        
        const [rows] = await pool.query("SELECT dados_extras FROM system_configs WHERE id_firebase = 'ranking_mes_info'");
        let mesSalvo = -1;
        
        if (rows.length > 0) {
            const dataConfig = JSON.parse(rows[0].dados_extras);
            mesSalvo = dataConfig.mes;
        }

        if (mesSalvo !== -1 && mesSalvo !== mesAtual) {
            console.log("=========================================");
            console.log("[Auto-Reset] VIRADA DE MÊS DETECTADA! Gerando Pódio...");
            
            const fbRes = await fetch(`${FIREBASE_DB_URL}/intranet/ranking.json`);
            const rankingData = await fbRes.json();
            
            if (rankingData) {
                const list = Object.entries(rankingData).map(([k, v]) => ({ id: k, ...v }));
                list.sort((a, b) => (b.pontos_mes || 0) - (a.pontos_mes || 0));
                
                const top3 = list.slice(0, 3);
                
                await fetch(`${FIREBASE_DB_URL}/intranet/vencedores_mes.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(top3) });
                
                for (const func of list) {
                    await fetch(`${FIREBASE_DB_URL}/intranet/ranking/${func.id}.json`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pontos_mes: 0 }) });
                }
            }
            await pool.query("UPDATE system_configs SET dados_extras = ? WHERE id_firebase = 'ranking_mes_info'", [JSON.stringify({ mes: mesAtual })]);
            console.log("[Auto-Reset] Pódio gerado e Ranking MENSAL zerado com sucesso!");
        } else if (mesSalvo === -1) {
            await pool.query("INSERT INTO system_configs (id_firebase, dados_extras) VALUES ('ranking_mes_info', ?) ON DUPLICATE KEY UPDATE dados_extras=VALUES(dados_extras)", [JSON.stringify({ mes: mesAtual })]);
        }
    } catch (e) { console.error("[Auto-Reset Ranking] Erro na verificação mensal:", e); }
}, 1000 * 60 * 60);

// ============================================================================
// 🚀 INICIALIZAÇÃO E ARQUIVO .ENV 
// ============================================================================
const PORT_INTERNA = process.env.PORT_INTERNA || 3000;
const PORT_EXTERNA_QR = process.env.PORT_EXTERNA_QR || 3001;
const PORT_EXTERNA_MAKE = process.env.PORT_EXTERNA_MAKE || 3002;

try {
    const httpsOptions = { key: fs.readFileSync('privkey.pem'), cert: fs.readFileSync('fullchain.pem') };
    https.createServer(httpsOptions, app).listen(PORT_INTERNA, () => { console.log(`✅ ONCO SMART (HTTPS) rodando na porta ${PORT_INTERNA}`); });
    https.createServer(httpsOptions, app).listen(PORT_EXTERNA_MAKE, () => { console.log(`🌍 API AUTOMAÇÕES (HTTPS) rodando na porta ${PORT_EXTERNA_MAKE}`); });
} catch (e) {
    app.listen(PORT_INTERNA, '0.0.0.0', () => { console.log(`⚠️ API HTTP (Local/Fallback) rodando na porta ${PORT_INTERNA}`); });
}

const http = require('http');
http.createServer(app).listen(PORT_EXTERNA_QR, () => { console.log(`📱 API QR CODE (HTTP Aberto) rodando na porta ${PORT_EXTERNA_QR}`); });