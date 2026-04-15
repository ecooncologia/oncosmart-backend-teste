const mysql = require('mysql2/promise');

async function consertarDefinitivo() {
    console.log("🔄 Conectando no banco da VM...");
    const pool = mysql.createPool({
        host: '127.0.0.1',
        user: 'admin_eco',
        password: 'Hzmffv10@',
        database: 'eco_sistema'
    });

    try {
        console.log("🤫 Desligando o alarme de chaves estrangeiras...");
        await pool.query("SET FOREIGN_KEY_CHECKS = 0;");

        console.log("🗑️ Destruindo a tabela defeituosa...");
        await pool.query("DROP TABLE IF EXISTS protocolos;");
        
        console.log("✨ Recriando a tabela com a trava tripla perfeita...");
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
                
                -- A TRAVA TRIPLA QUE IMPEDE O ESMAGAMENTO:
                UNIQUE KEY idx_unico_protocolo (cd_estabelecimento, seq_protocolo, nr_seq_subtipo)
            )
        `);

        console.log("🔒 Ligando a segurança do banco novamente...");
        await pool.query("SET FOREIGN_KEY_CHECKS = 1;");

        console.log("✅ SUCESSO ABSOLUTO! Tabela blindada. Pode rodar a sincronização!");
    } catch (error) {
        console.error("❌ ERRO:", error.message);
    } finally {
        await pool.end();
        process.exit();
    }
}

consertarDefinitivo();