const mysql = require('mysql2/promise');

async function consertarTabela() {
    console.log("🔄 Conectando no banco por dentro da VM...");
    const pool = mysql.createPool({
        host: '127.0.0.1', // Aqui a gente entra pela porta da frente (Localhost)
        user: 'admin_eco',
        password: 'Hzmffv10@',
        database: 'eco_sistema'
    });

    try {
        console.log("🗑️ Destruindo a tabela velha e com defeito...");
        await pool.query("DROP TABLE IF EXISTS protocolos");
        
        console.log("✨ Recriando a tabela nova com a trava combinada...");
        await pool.query(`
            CREATE TABLE protocolos (
                cd_estabelecimento INT,
                seq_protocolo INT,
                cd_protocolo VARCHAR(50),
                nr_seq_subtipo INT,
                nm_protocolo VARCHAR(255),
                nm_subtipo VARCHAR(255),
                nr_ciclos INT,
                nr_dias_intervalo INT,
                nm_usuario VARCHAR(100),
                
                -- ESTA É A MÁGICA: A trava agora exige a combinação dos 3 para ser duplicado
                PRIMARY KEY (cd_estabelecimento, seq_protocolo, nr_seq_subtipo)
            )
        `);
        console.log("✅ SUCESSO! A gaveta está pronta para receber os 1523 protocolos!");
    } catch (error) {
        console.error("❌ ERRO:", error.message);
    } finally {
        await pool.end();
        process.exit();
    }
}

consertarTabela();