const mysql = require('mysql2/promise');
async function consertar() {
    try {
        const pool = mysql.createPool({
            host: '127.0.0.1',
            user: 'admin_eco',
            password: 'Hzmffv10@',
            database: 'eco_sistema'
        });
        console.log('🔄 Conectando e apagando tabela antiga...');
        await pool.query('DROP TABLE IF EXISTS protocolos;');
        
        console.log('✨ Criando tabela blindada...');
        await pool.query(`CREATE TABLE protocolos (id INT AUTO_INCREMENT PRIMARY KEY, cd_estabelecimento INT, seq_protocolo INT, cd_protocolo VARCHAR(50), nr_seq_subtipo INT, nm_protocolo VARCHAR(255), nm_subtipo VARCHAR(255), nr_ciclos INT, nr_dias_intervalo INT, nm_usuario VARCHAR(100), UNIQUE KEY idx_unico_protocolo (cd_estabelecimento, seq_protocolo, nr_seq_subtipo));`);
        
        console.log('✅ SUCESSO ABSOLUTO! A tabela foi recriada. Pode rodar a sincronização!');
        process.exit(0);
    } catch (e) {
        console.error('❌ ERRO:', e.message);
        process.exit(1);
    }
}
consertar();
