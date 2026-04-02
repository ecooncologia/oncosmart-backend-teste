const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: '127.0.0.1', user: 'admin_eco', password: 'Hzmffv10@', database: 'eco_sistema'
});

async function migrar() {
    console.log("🚀 Iniciando migração de ESCALAS...");
    const conn = await pool.getConnection();

    try {
        // 1. Pega os JSONs antigos
        const [rows] = await conn.query("SELECT * FROM escala_mensal");
        
        let totalInseridos = 0;

        for (const row of rows) {
            // O id_firebase é tipo "2026-02"
            const [ano, mes] = row.id_firebase.split('-');
            if (!ano || !mes) continue;

            let escala = {};
            try { escala = JSON.parse(row.dados_extras); } catch(e) { continue; }

            // Estrutura do JSON: { "medico_id": { "1": "M", "2": "T" } }
            for (const [medicoId, dias] of Object.entries(escala)) {
                if(medicoId === 'id_firebase') continue;

                for (const [dia, tipo] of Object.entries(dias)) {
                    if (!tipo) continue;

                    // Cria a data correta: 2026-02-05
                    const dataPlantao = `${ano}-${mes}-${String(dia).padStart(2, '0')}`;

                    await conn.query(`
                        INSERT IGNORE INTO plantoes (medico_id, data_plantao, tipo)
                        VALUES (?, ?, ?)
                    `, [medicoId, dataPlantao, tipo]);
                    
                    process.stdout.write(".");
                    totalInseridos++;
                }
            }
        }

        console.log(`\n\n✅ Sucesso! ${totalInseridos} plantões foram transformados em linhas no banco.`);

    } catch (e) {
        console.error("Erro:", e);
    } finally {
        conn.release();
        process.exit();
    }
}

migrar();