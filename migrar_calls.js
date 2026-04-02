const firebase = require('firebase/compat/app');
require('firebase/compat/database');
const mysql = require('mysql2/promise');

// --- 1. COLE AQUI A CONFIGURAÇÃO DO SEU GLOBAL.JS ---
const firebaseConfig = { 
    apiKey: "AIzaSyCkZQweHWGsfEu8OjHBACCxv_dbYcFAyv4", 
    authDomain: "gerar-orcamento-bd4d1.firebaseapp.com", 
    projectId: "gerar-orcamento-bd4d1", 
    appId: "1:779065759341:web:451d068c476580c542d164" 
};
// ----------------------------------------------------

// Inicializa Firebase sem arquivo
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const dbRef = firebase.database().ref('patientCalls');

const pool = mysql.createPool({
    host: '127.0.0.1',
    user: 'admin_eco',
    password: 'Hzmffv10@',
    database: 'eco_sistema'
});

function tratarData(val) {
    if (!val) return null;
    try { return new Date(val).toISOString().slice(0, 19).replace('T', ' '); } catch (e) { return null; }
}

async function migrarAgora() {
    console.log("🚀 Iniciando migração SEM ARQUIVO (Modo Web)...");

    try {
        console.log("📡 Baixando dados...");
        const snapshot = await dbRef.once('value');
        const dados = snapshot.val();

        if (!dados) {
            console.log("❌ Nenhum dado no Firebase.");
            process.exit(0);
        }

        // Garante a tabela
        await pool.query(`
            CREATE TABLE IF NOT EXISTS patientCalls (
                id INT AUTO_INCREMENT PRIMARY KEY,
                id_firebase VARCHAR(100) UNIQUE,
                patientId VARCHAR(100),
                patientName VARCHAR(255),
                status VARCHAR(50),
                timestamp DATETIME,
                transportStartTime DATETIME,
                transportEndTime DATETIME,
                dados_extras JSON
            )
        `);

        let count = 0;
        for (const [key, item] of Object.entries(dados)) {
            // Mapeia colunas
            const pid = item.patientId || null;
            const nome = item.patientName || item.name || 'Sem Nome';
            const st = item.status || 'completed';
            
            await pool.query(`
                INSERT IGNORE INTO patientCalls 
                (id_firebase, patientId, patientName, status, timestamp, transportStartTime, transportEndTime, dados_extras) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                key, pid, nome, st, 
                tratarData(item.timestamp), 
                tratarData(item.transportStartTime), 
                tratarData(item.transportEndTime), 
                JSON.stringify(item)
            ]);
            count++;
            process.stdout.write(".");
        }

        console.log(`\n\n✅ SUCESSO! ${count} registros migrados.`);

    } catch (e) {
        console.error("\n❌ Erro:", e);
    } finally {
        pool.end();
        process.exit();
    }
}

migrarAgora();