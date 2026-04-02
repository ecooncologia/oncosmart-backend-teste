const mysql = require('mysql2/promise');

// Configuração do Banco
const pool = mysql.createPool({
    host: '127.0.0.1',
    user: 'admin_eco',
    password: 'Hzmffv10@',
    database: 'eco_sistema'
});

// Função para converter qualquer data maluca para YYYY-MM-DD HH:MM:SS
function formatarData(valor) {
    if (!valor) return null;

    // Caso 1: Timestamp numérico (ex: 1678888888888)
    if (typeof valor === 'number') {
        return new Date(valor).toISOString().slice(0, 19).replace('T', ' ');
    }

    // Caso 2: String Brasileira (DD/MM/AAAA)
    if (typeof valor === 'string' && valor.includes('/')) {
        const partes = valor.split('/');
        if (partes.length === 3) {
            // Se for DD/MM/AAAA
            if (partes[2].length === 4) return `${partes[2]}-${partes[1]}-${partes[0]} 00:00:00`;
            // Se for AAAA/MM/DD (raro mas acontece)
            if (partes[0].length === 4) return `${partes[0]}-${partes[1]}-${partes[2]} 00:00:00`;
        }
    }

    // Caso 3: String ISO (AAAA-MM-DD)
    if (typeof valor === 'string' && valor.includes('-')) {
        // Tenta criar data direto
        try {
            const d = new Date(valor);
            if (!isNaN(d.getTime())) {
                return d.toISOString().slice(0, 19).replace('T', ' ');
            }
        } catch (e) {}
    }

    return null;
}

async function migrar() {
    console.log("🚀 Iniciando correção de datas e valores em VENDAS...");
    const conn = await pool.getConnection();

    try {
        // Pega tudo que tem JSON
        const [rows] = await conn.query("SELECT id, dados_extras FROM vendas");
        
        let corrigidos = 0;
        let erros = 0;

        for (const row of rows) {
            let json = {};
            try {
                json = JSON.parse(row.dados_extras);
            } catch (e) {
                console.log(`⚠️ JSON inválido no ID ${row.id}`);
                continue;
            }

            // 1. Tenta achar a data em vários campos possíveis
            let dataOriginal = json.data || json.data_venda || json.timestamp || json.created_at || json.date;
            let dataFinal = formatarData(dataOriginal);

            // Se não achou data nenhuma, usa a data de criação do registro no SQL ou HOJE como fallback
            if (!dataFinal) {
                // console.log(`❓ Sem data no ID ${row.id} (Original: ${dataOriginal})`);
                continue; // Pula se não tiver data para não estragar
            }

            // 2. Garante os valores financeiros
            const vTotal = parseFloat(json.valor_total || json.valor_final || json.total_procedimento || json.valor || 0);
            const vPago = parseFloat(json.valor_pago || 0);
            const vSaldo = vTotal - vPago;

            // 3. Atualiza no Banco
            await conn.query(`
                UPDATE vendas SET 
                    data_venda = ?,
                    valor_total = ?,
                    valor_pago = ?,
                    saldo_devedor = ?
                WHERE id = ?
            `, [dataFinal, vTotal, vPago, vSaldo, row.id]);

            corrigidos++;
            if (corrigidos % 50 === 0) process.stdout.write(".");
        }

        console.log(`\n\n✅ Concluído! ${corrigidos} registros corrigidos.`);

    } catch (e) {
        console.error("Erro fatal:", e);
    } finally {
        conn.release();
        process.exit();
    }
}

migrar();