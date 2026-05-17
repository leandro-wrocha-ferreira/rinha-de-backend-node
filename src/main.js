const http = require('http');
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const PORT = 3000;
const k = 5;
const maxs = {
    "max_amount": 10000,
    "max_installments": 12,
    "amount_vs_avg_ratio": 10,
    "max_minutes": 1440,
    "max_km": 1000,
    "max_tx_count_24h": 20,
    "max_merchant_avg_amount": 10000
};

const mccRisk = {
    "5411": 0.15,
    "5812": 0.30,
    "5912": 0.20,
    "5944": 0.45,
    "7801": 0.80,
    "7802": 0.75,
    "7995": 0.85,
    "4511": 0.35,
    "5311": 0.25,
    "5999": 0.50
}

let vectorData;
let labelData;
let totalRecords = 0;

function formatMemory(bytes) {
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function loadReferences() {
    const gzPath = path.join(__dirname, '../references/references.json.gz');
    const vectorBinPath = path.join(__dirname, '../references/vectors.bin');
    const labelBinPath = path.join(__dirname, '../references/labels.bin');

    const memBefore = process.memoryUsage().heapUsed;
    console.log(`\n[Memory] Before loading: ${formatMemory(memBefore)}`);

    // Tenta carregar binários pré-processados primeiro (muito mais leve na memória)
    if (fs.existsSync(vectorBinPath) && fs.existsSync(labelBinPath)) {
        console.log(`Loading binary references from ${vectorBinPath}...`);
        const start = Date.now();

        const vectorBuffer = fs.readFileSync(vectorBinPath);
        vectorData = new Float32Array(vectorBuffer.buffer, vectorBuffer.byteOffset, vectorBuffer.byteLength / 4);

        const labelBuffer = fs.readFileSync(labelBinPath);
        labelData = new Uint8Array(labelBuffer.buffer, labelBuffer.byteOffset, labelBuffer.byteLength);

        totalRecords = labelData.length;
        const end = Date.now();
        const memAfter = process.memoryUsage().heapUsed;

        console.log(`Loaded ${totalRecords} binary references in ${end - start}ms.`);
        console.log(`[Memory] After loading: ${formatMemory(memAfter)}`);
        console.log(`[Memory] Data impact: ${formatMemory(memAfter - memBefore)}`);
        return;
    }

    // Fallback para JSON (Consome muita memória temporária)
    console.log(`Loading references from ${gzPath} (fallback)...`);
    try {
        const start = Date.now();
        const compressedData = fs.readFileSync(gzPath);
        const decompressedData = zlib.gunzipSync(compressedData);
        const rawReferences = JSON.parse(decompressedData.toString());
        totalRecords = rawReferences.length;

        vectorData = new Float32Array(totalRecords * 14);
        labelData = new Uint8Array(totalRecords);

        for (let i = 0; i < totalRecords; i++) {
            const ref = rawReferences[i];
            labelData[i] = ref.label === 'fraud' ? 1 : 0;
            for (let j = 0; j < 14; j++) {
                vectorData[i * 14 + j] = ref.vector[j];
            }
        }

        const end = Date.now();
        const memAfter = process.memoryUsage().heapUsed;
        console.log(`Loaded ${totalRecords} references in ${end - start}ms.`);
        console.log(`[Memory] After loading: ${formatMemory(memAfter)}`);
        console.log(`[Memory] Data impact: ${formatMemory(memAfter - memBefore)}`);
    } catch (err) {
        console.error('Error loading references:', err);
        process.exit(1);
    }
}

function euclideanDistance(v1, vectorData, offset) {
    let sum = 0;
    for (let i = 0; i < 14; i++) {
        const diff = v1[i] - vectorData[offset + i];
        sum += diff * diff;
    }
    return Math.sqrt(sum);
}

function clamp(value) {
    if (value < 0.0) return 0.0;
    else if (value > 1.0) return 1.0;
    return value;
}

function getVector(data) {
    const request_at = new Date(data.transaction.requested_at);

    let dimensions = [];
    dimensions[0] = clamp(data.transaction.amount / maxs.max_amount);
    dimensions[1] = clamp(data.transaction.installments / maxs.max_installments);
    dimensions[2] = clamp((data.transaction.amount / data.customer.avg_amount) / maxs.amount_vs_avg_ratio);
    dimensions[3] = clamp(request_at.getUTCHours() / 23);
    dimensions[4] = clamp((request_at.getUTCDay() == 0 ? 6 : request_at.getUTCDay() - 1) / 6);

    if (!data.last_transaction) {
        dimensions[5] = -1;
        dimensions[6] = -1;
    } else {
        const timeDiff = request_at - new Date(data.last_transaction.timestamp);
        dimensions[5] = clamp((timeDiff / 1000 / 60) / maxs.max_minutes);
        dimensions[6] = clamp(data.last_transaction.km_from_current / maxs.max_km);
    }

    dimensions[7] = clamp(data.terminal.km_from_home / maxs.max_km);
    dimensions[8] = clamp(data.customer.tx_count_24h / maxs.max_tx_count_24h);
    dimensions[9] = data.terminal.is_online ? 1 : 0;
    dimensions[10] = data.terminal.card_present ? 1 : 0;
    dimensions[11] = data.customer.known_merchants.includes(data.merchant.id) ? 0 : 1;
    dimensions[12] = mccRisk[data.merchant.mcc] ?? 0.5;
    dimensions[13] = clamp(data.merchant.avg_amount / maxs.max_merchant_avg_amount);

    return dimensions;
}

function getResponse(dimensions) {
    // Usamos um array para guardar as top distâncias de forma eficiente
    // Inicialmente preenchemos com valores infinitos
    const topDistances = new Array(k).fill(Infinity);
    const topLabels = new Array(k).fill(0);

    for (let i = 0; i < totalRecords; i++) {
        const dist = euclideanDistance(dimensions, vectorData, i * 14);

        // Se a distância for menor que a maior distância no nosso top K
        if (dist < topDistances[k - 1]) {
            topDistances[k - 1] = dist;
            topLabels[k - 1] = labelData[i];

            // Re-ordena o top K (Insertion Sort simples para k pequeno)
            for (let j = k - 2; j >= 0; j--) {
                if (topDistances[j] > topDistances[j + 1]) {
                    [topDistances[j], topDistances[j + 1]] = [topDistances[j + 1], topDistances[j]];
                    [topLabels[j], topLabels[j + 1]] = [topLabels[j + 1], topLabels[j]];
                } else {
                    break;
                }
            }
        }
    }

    // Conta quantos no top k são fraude (label 1)
    const fraudCount = topLabels.reduce((a, b) => a + b, 0);
    const score = fraudCount / k;

    return JSON.stringify({
        approved: score < 0.6,
        score: score
    });
}

const server = http.createServer((req, res) => {
    const { method, url } = req;

    if (method === 'GET' && url === '/ready') {
        res.statusCode = 204;
        res.end();
        return;
    }

    if (method === 'POST' && url === '/fraud-score') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });

        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const dimensions = getVector(data);
                const responseData = getResponse(dimensions);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(responseData);
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // Rota não encontrada
    res.statusCode = 404;
    res.end('Not Found');
});

loadReferences();

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
});
