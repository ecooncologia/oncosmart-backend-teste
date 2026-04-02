// Desliga a trava de segurança SSL para requisições na própria máquina local (localhost)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// 1. COLOQUE A URL DO SEU FIREBASE AQUI (sem a barra no final)
const FIREBASE_DB_URL = "https://gerar-orcamento-bd4d1-default-rtdb.firebaseio.com"; 

// 2. URL da sua API Local
const API_LOCAL_URL = "https://127.0.0.1:3000"; 

// Lista de todas as tabelas que mapeamos no seu sistema
const tabelas = [
    { fb: 'usuarios', api: 'usuarios' },
    { fb: 'patientCalls', api: 'patientCalls' },
    { fb: 'painAssessments', api: 'painAssessments' },
    { fb: 'chamados', api: 'chamados' },
    { fb: 'orcamentos', api: 'orcamentos' },
    { fb: 'vendas', api: 'vendas' },
    { fb: 'selos_registros', api: 'selos_registros' },
    { fb: 'selos_estoque', api: 'selos_estoque' },
    { fb: 'selos_secretarias', api: 'selos_secretarias' },
    { fb: 'medicos', api: 'medicos' },
    { fb: 'procedimentos', api: 'procedimentos' },
    { fb: 'escala_mensal', api: 'escala_mensal' }
];

async function migrarTudo() {
    console.log("🚀 Iniciando migração GERAL do Firebase para MySQL...\n");

    let totalSucesso = 0;
    let totalErro = 0;

    for (const tb of tabelas) {
        console.log(`====================================================`);
        console.log(`📥 Lendo tabela do Firebase: [${tb.fb.toUpperCase()}]...`);

        try {
            const response = await fetch(`${FIREBASE_DB_URL}/${tb.fb}.json`);
            const dados = await response.json();

            if (!dados || dados.error) {
                console.log(`⚠️ Tabela vazia ou inexistente. Pulando...\n`);
                continue;
            }

            const keys = Object.keys(dados);
            console.log(`📦 ${keys.length} registros encontrados. Copiando para o MySQL...`);

            let sucessoTb = 0;
            let erroTb = 0;

            // Envia registro por registro para não derrubar a memória
            for (const key of keys) {
                const item = dados[key];
                
                // Garante que a chave do Firebase vai junto no JSON
                if (typeof item === 'object' && item !== null) {
                    item.id_firebase = key;
                }

                try {
                    const res = await fetch(`${API_LOCAL_URL}/${tb.api}/${key}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(item)
                    });

                    if (res.ok) {
                        sucessoTb++;
                        totalSucesso++;
                    } else {
                        erroTb++;
                        totalErro++;
                        console.error(`❌ [ERRO API] ${tb.api}/${key} - HTTP Status: ${res.status}`);
                    }
                } catch (err) {
                    erroTb++;
                    totalErro++;
                    console.error(`⚠️ [FALHA DE REDE] ${tb.api}/${key}: ${err.message}`);
                }
            }
            console.log(`✅ [${tb.fb.toUpperCase()}] concluída! Sucesso: ${sucessoTb} | Erros: ${erroTb}\n`);

        } catch (error) {
            console.error(`🔥 Erro fatal ao acessar ${tb.fb} no Firebase:`, error.message, "\n");
        }
    }

    console.log(`====================================================`);
    console.log(`🎉 MIGRAÇÃO 100% FINALIZADA!`);
    console.log(`✅ Total de registros salvos no MySQL: ${totalSucesso}`);
    console.log(`❌ Total de falhas: ${totalErro}`);
    console.log(`====================================================\n`);
}

migrarTudo();