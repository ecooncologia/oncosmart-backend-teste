// Desliga a trava de segurança SSL para requisições na própria máquina local (localhost)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// 1. Coloque a URL do seu Realtime Database do Firebase (sem a barra no final)
const FIREBASE_DB_URL = "https://gerar-orcamento-bd4d1-default-rtdb.firebaseio.com"; 

// 2. URL da API alterada para HTTPS
const API_LOCAL_URL = "https://127.0.0.1:3000"; 

async function migrarChamados() {
    console.log("🔄 Conectando ao Firebase...");
    
    try {
        const response = await fetch(`${FIREBASE_DB_URL}/chamados.json`);
        const chamados = await response.json();

        if (!chamados || chamados.error) {
            console.log("❌ Nenhum chamado encontrado ou acesso negado no Firebase.");
            return;
        }

        const keys = Object.keys(chamados);
        console.log(`📦 Encontrados ${keys.length} chamados. Iniciando cópia...\n`);

        let sucesso = 0;
        let erro = 0;

        for (const key of keys) {
            const chamado = chamados[key];
            chamado.id_firebase = key;

            try {
                const res = await fetch(`${API_LOCAL_URL}/chamados/${key}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(chamado)
                });

                if (res.ok) {
                    sucesso++;
                    console.log(`✅ [OK] Copiado: ${key}`);
                } else {
                    erro++;
                    console.error(`❌ [ERRO] Falha ao copiar: ${key} (Status: ${res.status})`);
                }
            } catch (err) {
                erro++;
                console.error(`⚠️ [ERRO API] ${key}: ${err.message}`);
            }
        }

        console.log("\n==================================");
        console.log("🎉 MIGRAÇÃO CONCLUÍDA!");
        console.log(`✅ Sucesso: ${sucesso} | ❌ Erros: ${erro}`);
        console.log("==================================\n");

    } catch (error) {
        console.error("🔥 Erro fatal ao acessar o Firebase:", error.message);
    }
}

migrarChamados();