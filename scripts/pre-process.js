const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const gzPath = path.join(__dirname, '../references/references.json.gz');
const vectorBinPath = path.join(__dirname, '../references/vectors.bin');
const labelBinPath = path.join(__dirname, '../references/labels.bin');

console.log('Starting pre-processing...');

const compressedData = fs.readFileSync(gzPath);
const decompressedData = zlib.gunzipSync(compressedData);
const rawReferences = JSON.parse(decompressedData.toString());
const totalRecords = rawReferences.length;

const vectorData = new Float32Array(totalRecords * 14);
const labelData = new Uint8Array(totalRecords);

for (let i = 0; i < totalRecords; i++) {
    const ref = rawReferences[i];
    labelData[i] = ref.label === 'fraud' ? 1 : 0;
    for (let j = 0; j < 14; j++) {
        vectorData[i * 14 + j] = ref.vector[j];
    }
}

fs.writeFileSync(vectorBinPath, Buffer.from(vectorData.buffer));
fs.writeFileSync(labelBinPath, Buffer.from(labelData.buffer));

console.log(`Pre-processing finished. Generated binary files for ${totalRecords} records.`);
