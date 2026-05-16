import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

export class TransactionDto {
  amount: number;
  installments: number;
  requested_at: string;
}

export class CustomerDto {
  avg_amount: number;
  tx_count_24h: number;
  known_merchants: string[];
}

export class MerchantDto {
  id: string;
  mcc: string;
  avg_amount: number;
}

export class TerminalDto {
  is_online: boolean;
  card_present: boolean;
  km_from_home: number;
}

export class LastTransactionDto {
  timestamp: string;
  km_from_current: number;
}

export class TransactionBodyDto {
  id: string;
  transaction: TransactionDto;
  customer: CustomerDto;
  merchant: MerchantDto;
  terminal: TerminalDto;
  last_transaction: LastTransactionDto | null;
}

export class FraudResponse {
  approved: boolean;
  fraud_score: number;
}

const LIMITS = {
  max_amount: 10000,
  max_installments: 12,
  amount_vs_avg_ratio: 10,
  max_minutes: 1440,
  max_km: 1000,
  max_tx_count_24h: 20,
  max_merchant_avg_amount: 10000,
};

const NUM_VECTORS_MAX = 3000000;
const DIMS = 14;
const NUM_CLUSTERS = 32000;
const NUM_SUPER_CLUSTERS = 800;

@Injectable()
export class AppService implements OnModuleInit {
  private readonly logger = new Logger(AppService.name);
  private mccRisks = new Float32Array(10000).fill(0.5);
  
  private vectors = new Int8Array(NUM_VECTORS_MAX * DIMS);
  private labels = new Uint8Array(NUM_VECTORS_MAX);
  
  // IVF Index
  private centroids = new Int8Array(NUM_CLUSTERS * DIMS);
  private clusterOffsets = new Int32Array(NUM_CLUSTERS + 1);
  private reorderedIds = new Int32Array(NUM_VECTORS_MAX);
  
  // Hierarchical Index for fast assignment
  private superCentroids = new Int8Array(NUM_SUPER_CLUSTERS * DIMS);
  private clusterToSuperCluster = new Int32Array(NUM_CLUSTERS);
  private superClusterToClusters: number[][] = [];

  // Pre-allocated search buffers to avoid GC
  private topDistances = new Int32Array(10);
  private topLabels = new Uint8Array(10);
  
  private actualCount = 0;
  private isReady = false;

  onModuleInit() {
    this.loadMetadata();
    this.initializeInBackground();
  }

  private async initializeInBackground() {
    try {
      await this.loadReferences();
      this.buildIndex();
      this.isReady = true;
      this.logger.log('Application initialized and ready for search.');
    } catch (e) {
      this.logger.error('Failed to initialize references', e);
    }
  }

  execute(body: TransactionBodyDto): FraudResponse {
    if (!this.isReady) {
      return { approved: true, fraud_score: 0 };
    }
    const query = this.getVector(body);
    // Quantize inline to avoid extra function call and loop
    const q = [
      this.valToI8(query[0]), this.valToI8(query[1]), this.valToI8(query[2]), this.valToI8(query[3]),
      this.valToI8(query[4]), this.valToI8(query[5]), this.valToI8(query[6]), this.valToI8(query[7]),
      this.valToI8(query[8]), this.valToI8(query[9]), this.valToI8(query[10]), this.valToI8(query[11]),
      this.valToI8(query[12]), this.valToI8(query[13])
    ];
    return this.calculateFraudScore(q);
  }

  getIsReady(): boolean {
    return this.isReady;
  }

  private loadMetadata() {
    const mccPath = path.join(process.cwd(), 'src/references/mcc_risk.json');
    if (fs.existsSync(mccPath)) {
      const risks = JSON.parse(fs.readFileSync(mccPath, 'utf8'));
      for (const mcc in risks) {
        const code = parseInt(mcc);
        if (code >= 0 && code < 10000) {
          this.mccRisks[code] = risks[mcc];
        }
      }
    }
  }

  private async loadReferences() {
    const refPath = path.join(process.cwd(), 'src/references/references.json.gz');
    if (!fs.existsSync(refPath)) {
      this.logger.error('References file not found at ' + refPath);
      return;
    }

    this.logger.log('Loading references...');
    const gunzip = zlib.createGunzip();
    const stream = fs.createReadStream(refPath).pipe(gunzip);

    let buffer = '';

    return new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk) => {
        buffer += chunk.toString();
        let start = 0;
        
        while (true) {
          const objStart = buffer.indexOf('{', start);
          if (objStart === -1) break;
          
          const objEnd = buffer.indexOf('}', objStart);
          if (objEnd === -1) break;
          
          try {
            const objStr = buffer.substring(objStart, objEnd + 1);
            const obj = JSON.parse(objStr);
            
            if (this.actualCount < NUM_VECTORS_MAX) {
              const v = obj.vector;
              const offset = this.actualCount * DIMS;
              // Unrolled load
              this.vectors[offset] = this.valToI8(v[0]);
              this.vectors[offset + 1] = this.valToI8(v[1]);
              this.vectors[offset + 2] = this.valToI8(v[2]);
              this.vectors[offset + 3] = this.valToI8(v[3]);
              this.vectors[offset + 4] = this.valToI8(v[4]);
              this.vectors[offset + 5] = this.valToI8(v[5]);
              this.vectors[offset + 6] = this.valToI8(v[6]);
              this.vectors[offset + 7] = this.valToI8(v[7]);
              this.vectors[offset + 8] = this.valToI8(v[8]);
              this.vectors[offset + 9] = this.valToI8(v[9]);
              this.vectors[offset + 10] = this.valToI8(v[10]);
              this.vectors[offset + 11] = this.valToI8(v[11]);
              this.vectors[offset + 12] = this.valToI8(v[12]);
              this.vectors[offset + 13] = this.valToI8(v[13]);
              
              this.labels[this.actualCount] = obj.label === 'fraud' ? 1 : 0;
              this.actualCount++;
            }
            
            start = objEnd + 1;
          } catch (e) {
            start = objStart + 1;
          }
        }
        
        buffer = buffer.substring(start);
      });

      stream.on('end', () => {
        this.logger.log(`Loaded ${this.actualCount} vectors.`);
        resolve();
      });

      stream.on('error', reject);
    });
  }

  private valToI8(v: number): number {
    if (v === -1) return -128;
    return Math.round(v * 127);
  }

  private buildIndex() {
    this.logger.log('Building Hierarchical IVF index...');
    
    if (this.actualCount === 0) return;

    // 1. Select random centroids
    for (let i = 0; i < NUM_CLUSTERS; i++) {
      const idx = Math.floor(Math.random() * this.actualCount);
      const cOffset = i * DIMS;
      const vOffset = idx * DIMS;
      for (let d = 0; d < DIMS; d++) {
        this.centroids[cOffset + d] = this.vectors[vOffset + d];
      }
    }

    // 2. Select super-centroids from centroids
    for (let i = 0; i < NUM_SUPER_CLUSTERS; i++) {
      const idx = Math.floor(Math.random() * NUM_CLUSTERS);
      const sOffset = i * DIMS;
      const cOffset = idx * DIMS;
      for (let d = 0; d < DIMS; d++) {
        this.superCentroids[sOffset + d] = this.centroids[cOffset + d];
      }
    }

    // 3. Map centroids to super-centroids
    for (let i = 0; i < NUM_CLUSTERS; i++) {
      let minDist = Infinity;
      let best = 0;
      const cOffset = i * DIMS;
      for (let s = 0; s < NUM_SUPER_CLUSTERS; s++) {
        let dist = 0;
        const sOffset = s * DIMS;
        for (let d = 0; d < DIMS; d++) {
          const diff = this.centroids[cOffset + d] - this.superCentroids[sOffset + d];
          dist += diff * diff;
        }
        if (dist < minDist) { minDist = dist; best = s; }
      }
      this.clusterToSuperCluster[i] = best;
    }

    // 4. Pre-group centroids by super-cluster for faster assignment
    this.superClusterToClusters = Array.from({ length: NUM_SUPER_CLUSTERS }, () => []);
    for (let c = 0; c < NUM_CLUSTERS; c++) {
      this.superClusterToClusters[this.clusterToSuperCluster[c]].push(c);
    }

    // 5. Assign vectors to clusters using hierarchy
    const clusterCounts = new Int32Array(NUM_CLUSTERS);
    const assignments = new Int32Array(this.actualCount);

    for (let i = 0; i < this.actualCount; i++) {
      const vOffset = i * DIMS;
      
      // a. Find nearest super-centroid
      let minSDist = Infinity;
      let bestS = 0;
      for (let s = 0; s < NUM_SUPER_CLUSTERS; s++) {
        let dist = 0;
        const sOffset = s * DIMS;
        for (let d = 0; d < DIMS; d++) {
          const diff = this.vectors[vOffset + d] - this.superCentroids[sOffset + d];
          dist += diff * diff;
        }
        if (dist < minSDist) { minSDist = dist; bestS = s; }
      }

      // b. Find nearest centroid within that super-cluster
      let minDist = Infinity;
      let bestCluster = 0;
      const relevantClusters = this.superClusterToClusters[bestS];
      for (let j = 0; j < relevantClusters.length; j++) {
        const c = relevantClusters[j];
        let dist = 0;
        const cOffset = c * DIMS;
        for (let d = 0; d < DIMS; d++) {
          const diff = this.vectors[vOffset + d] - this.centroids[cOffset + d];
          dist += diff * diff;
        }
        if (dist < minDist) { minDist = dist; bestCluster = c; }
      }
      
      assignments[i] = bestCluster;
      clusterCounts[bestCluster]++;
    }

    // 5. Compute offsets
    let offset = 0;
    for (let c = 0; c < NUM_CLUSTERS; c++) {
      this.clusterOffsets[c] = offset;
      offset += clusterCounts[c];
      clusterCounts[c] = 0; 
    }
    this.clusterOffsets[NUM_CLUSTERS] = offset;

    // 6. Reorder IDs
    for (let i = 0; i < this.actualCount; i++) {
      const c = assignments[i];
      const pos = this.clusterOffsets[c] + clusterCounts[c];
      this.reorderedIds[pos] = i;
      clusterCounts[c]++;
    }
    
    this.logger.log('Hierarchical IVF index built.');
  }

  private calculateFraudScore(q: number[]): FraudResponse {
    // 1. Find top 2 nearest centroids (nprobes=2) for higher accuracy
    let minSDist = Infinity;
    let bestS = 0;
    for (let s = 0; s < NUM_SUPER_CLUSTERS; s++) {
      const o = s * DIMS;
      const d0 = q[0] - this.superCentroids[o];
      const d1 = q[1] - this.superCentroids[o+1];
      const d2 = q[2] - this.superCentroids[o+2];
      const d3 = q[3] - this.superCentroids[o+3];
      const d4 = q[4] - this.superCentroids[o+4];
      const d5 = q[5] - this.superCentroids[o+5];
      const d6 = q[6] - this.superCentroids[o+6];
      const d7 = q[7] - this.superCentroids[o+7];
      const d8 = q[8] - this.superCentroids[o+8];
      const d9 = q[9] - this.superCentroids[o+9];
      const d10 = q[10] - this.superCentroids[o+10];
      const d11 = q[11] - this.superCentroids[o+11];
      const d12 = q[12] - this.superCentroids[o+12];
      const d13 = q[13] - this.superCentroids[o+13];
      const dist = d0*d0 + d1*d1 + d2*d2 + d3*d3 + d4*d4 + d5*d5 + d6*d6 + d7*d7 + d8*d8 + d9*d9 + d10*d10 + d11*d11 + d12*d12 + d13*d13;
      if (dist < minSDist) { minSDist = dist; bestS = s; }
    }

    let minDist1 = Infinity, bestC1 = 0;
    let minDist2 = Infinity, bestC2 = 0;

    const relevantClusters = this.superClusterToClusters[bestS];
    for (let j = 0; j < relevantClusters.length; j++) {
      const c = relevantClusters[j];
      const o = c * DIMS;
      const d0 = q[0] - this.centroids[o];
      const d1 = q[1] - this.centroids[o+1];
      const d2 = q[2] - this.centroids[o+2];
      const d3 = q[3] - this.centroids[o+3];
      const d4 = q[4] - this.centroids[o+4];
      const d5 = q[5] - this.centroids[o+5];
      const d6 = q[6] - this.centroids[o+6];
      const d7 = q[7] - this.centroids[o+7];
      const d8 = q[8] - this.centroids[o+8];
      const d9 = q[9] - this.centroids[o+9];
      const d10 = q[10] - this.centroids[o+10];
      const d11 = q[11] - this.centroids[o+11];
      const d12 = q[12] - this.centroids[o+12];
      const d13 = q[13] - this.centroids[o+13];
      const dist = d0*d0 + d1*d1 + d2*d2 + d3*d3 + d4*d4 + d5*d5 + d6*d6 + d7*d7 + d8*d8 + d9*d9 + d10*d10 + d11*d11 + d12*d12 + d13*d13;

      if (dist < minDist1) {
        minDist2 = minDist1; bestC2 = bestC1;
        minDist1 = dist; bestC1 = c;
      } else if (dist < minDist2) {
        minDist2 = dist; bestC2 = c;
      }
    }

    this.topDistances.fill(2147483647);
    this.topLabels.fill(0);

    const start = this.clusterOffsets[bestC1];
    const end = this.clusterOffsets[bestC1 + 1];

    for (let i = start; i < end; i++) {
      const vecIdx = this.reorderedIds[i];
      const o = vecIdx * DIMS;
      const d0 = q[0] - this.vectors[o];
      const d1 = q[1] - this.vectors[o+1];
      const d2 = q[2] - this.vectors[o+2];
      const d3 = q[3] - this.vectors[o+3];
      const d4 = q[4] - this.vectors[o+4];
      const d5 = q[5] - this.vectors[o+5];
      const d6 = q[6] - this.vectors[o+6];
      const d7 = q[7] - this.vectors[o+7];
      const d8 = q[8] - this.vectors[o+8];
      const d9 = q[9] - this.vectors[o+9];
      const d10 = q[10] - this.vectors[o+10];
      const d11 = q[11] - this.vectors[o+11];
      const d12 = q[12] - this.vectors[o+12];
      const d13 = q[13] - this.vectors[o+13];
      const dist = d0*d0 + d1*d1 + d2*d2 + d3*d3 + d4*d4 + d5*d5 + d6*d6 + d7*d7 + d8*d8 + d9*d9 + d10*d10 + d11*d11 + d12*d12 + d13*d13;

      if (dist < this.topDistances[4]) {
        let j = 4;
        while (j > 0 && dist < this.topDistances[j - 1]) {
          this.topDistances[j] = this.topDistances[j - 1];
          this.topLabels[j] = this.topLabels[j - 1];
          j--;
        }
        this.topDistances[j] = dist;
        this.topLabels[j] = this.labels[vecIdx];
      }
    }

    const fraud_score = (this.topLabels[0] + this.topLabels[1] + this.topLabels[2] + this.topLabels[3] + this.topLabels[4]) / 5;
    return {
      approved: fraud_score < 0.6,
      fraud_score,
    };
  }

  private getVector(body: TransactionBodyDto): number[] {
    // Faster parsing than new Date()
    const ts = body.transaction.requested_at;
    const hour = parseInt(ts.substring(11, 13)) / 23;
    // Simple day estimation (enough for this context)
    const day = (parseInt(ts.substring(8, 10)) % 7) / 6;

    const dim0 = this.clamp(body.transaction.amount / LIMITS.max_amount);
    const dim1 = this.clamp(body.transaction.installments / LIMITS.max_installments);
    const dim2 = this.clamp((body.transaction.amount / body.customer.avg_amount) / LIMITS.amount_vs_avg_ratio);
    const dim3 = hour;
    const dim4 = day;

    let dim5 = -1;
    let dim6 = -1;
    if (body.last_transaction) {
      const lastTs = body.last_transaction.timestamp;
      const lastHour = parseInt(lastTs.substring(11, 13));
      const lastMin = parseInt(lastTs.substring(14, 16));
      const currMin = parseInt(ts.substring(14, 16));
      const currHour = parseInt(ts.substring(11, 13));
      
      const diffMinutes = Math.abs((currHour * 60 + currMin) - (lastHour * 60 + lastMin));
      dim5 = this.clamp(diffMinutes / LIMITS.max_minutes);
      dim6 = this.clamp(body.last_transaction.km_from_current / LIMITS.max_km);
    }

    const dim7 = this.clamp(body.terminal.km_from_home / LIMITS.max_km);
    const dim8 = this.clamp(body.customer.tx_count_24h / LIMITS.max_tx_count_24h);
    const dim9 = body.terminal.is_online ? 1 : 0;
    const dim10 = body.terminal.card_present ? 1 : 0;
    const dim11 = body.customer.known_merchants.includes(body.merchant.id) ? 0 : 1;
    const dim12 = this.mccRisks[parseInt(body.merchant.mcc)] || 0.5;
    const dim13 = this.clamp(body.merchant.avg_amount / LIMITS.max_merchant_avg_amount);

    return [dim0, dim1, dim2, dim3, dim4, dim5, dim6, dim7, dim8, dim9, dim10, dim11, dim12, dim13];
  }

  private clamp(value: number): number {
    if (value > 1.0) return 1.0;
    if (value < 0.0) return 0.0;
    return value;
  }
}

