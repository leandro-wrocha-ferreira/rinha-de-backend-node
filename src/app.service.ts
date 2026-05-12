import { Injectable } from '@nestjs/common';

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

export interface FraudResponse {
  approved: boolean;
  fraud_score: number;
}

const LIMITS = {
  max_amount: 10000,
  max_hour: 23,
  max_avg: 5000,
};

@Injectable()
export class AppService {
  execute(body: TransactionBodyDto): FraudResponse {
    const dim1 = this.limitar(body.transaction.amount, LIMITS.max_amount);
    const dim2 = this.limitar(body.customer.avg_amount, LIMITS.max_avg);
    const dim3 = this.limitar(body.customer.tx_count_24h, LIMITS.max_hour);

    const dimensions = [dim1, dim2, dim3];

    return this.calculateFraudScore(dimensions);
  }

  private limitar(valueOne: number, valueTwo: number): number {
    const ratio = valueOne / valueTwo;
    if (ratio > 1.0) return 1.0;
    if (ratio < 0.0) return 0.0;
    return ratio;
  }

  private calculateFraudScore(dimensions: number[]): FraudResponse {
    const datasetReferences = [
      { vector: [0.01, 0.0833, 0.05], label: 'legit' },
      { vector: [0.5796, 0.9167, 1.0], label: 'fraud' },
      { vector: [0.0035, 0.1667, 0.05], label: 'legit' },
      { vector: [0.9708, 1.0, 1.0], label: 'fraud' },
      { vector: [0.4082, 1.0, 1.0], label: 'fraud' },
      { vector: [0.0092, 0.0833, 0.05], label: 'legit' },
    ];

    const k = 3;
    const similarities = datasetReferences.map((item) => {
      const dx = item.vector[0] - dimensions[0];
      const dy = item.vector[1] - dimensions[1];
      const dz = item.vector[2] - dimensions[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      return {
        score: dist,
        label: item.label,
      };
    });

    similarities.sort((a, b) => a.score - b.score);

    const knn = similarities.slice(0, k);
    const fraudCount = knn.filter((k) => k.label === 'fraud').length;
    const fraudScore = fraudCount / knn.length;

    return {
      approved: fraudScore <= 0.6,
      fraud_score: fraudScore,
    };
  }
}
