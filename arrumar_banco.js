require('dotenv').config();
const mysql = require('mysql2/promise');

async function recriarTabela() {
    console.log("=====================================");
    console.log("🛠️  INICIANDO MANUTENÇÃO DO BANCO MYSQL");
    console.log("=====================================");

    // Usa a mesma conexão do seu server.js
    const pool = mysql.createPool({
        host: process.env.DB_HOST || '127.0.0.1',
        user: process.env.DB_USER || 'admin_eco',
        password: process.env.DB_PASS || 'Hzmffv10@',
        database: process.env.DB_NAME || 'eco_sistema'
    });

    try {
        console.log("🔄 Conectando ao banco MySQL...");
        
        console.log("🗑️  Passo 1: Apagando a tabela 'protocolos' antiga...");
        await pool.query(`DROP TABLE IF EXISTS protocolos;`);
        
        console.log("✨ Passo 2: Recriando a tabela com a trava combinada...");
        await pool.query(`
            CREATE TABLE protocolos (
                id INT AUTO_INCREMENT PRIMARY KEY,
                cd_estabelecimento INT,
                seq_protocolo INT,
                cd_protocolo VARCHAR(50),
                nr_seq_subtipo INT,
                nm_protocolo VARCHAR(255),
                nm_subtipo VARCHAR(255),
                nr_ciclos INT,
                nr_dias_intervalo INT,
                nm_usuario VARCHAR(100),
                
                -- A MÁGICA ESTÁ AQUI (Evita duplicatas sem esmagar os subtipos diferentes)
                UNIQUE KEY idx_unico_protocolo (cd_estabelecimento, seq_protocolo, nr_seq_subtipo)
            );
        `);
        
        console.log("✅ SUCESSO! A tabela foi recriada e está pronta para receber os 1523 registros.");
    } catch (error) {
        console.error("❌ ERRO:", error.message);
    } finally {
        await pool.end();
        console.log("🔒 Conexão encerrada.");
    }
}

recriarTabela();