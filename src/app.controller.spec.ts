import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService, TransactionBodyDto } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('ready', () => {
    it('should return "The application is ready!"', () => {
      expect(appController.isReady()).toBe('The application is ready!');
    });
  });

  describe('fraudScore', () => {
    it('should return a fraud score', () => {
      const body: TransactionBodyDto = {
        id: '1',
        transaction: {
          amount: 1,
          installments: 1,
          requested_at: '1',
        },
        customer: {
          avg_amount: 1,
          tx_count_24h: 1,
          known_merchants: ['1'],
        },
        merchant: {
          id: '1',
          mcc: '1',
          avg_amount: 1,
        },
        terminal: {
          is_online: true,
          card_present: true,
          km_from_home: 1,
        },
        last_transaction: {
          timestamp: '1',
          km_from_current: 1,
        },
      };
      expect(appController.fraudScore(body)).toEqual({
        approved: true,
        fraud_score: 0,
      });
    });

    it('should return approved: false for high risk transactions', () => {
      const body: TransactionBodyDto = {
        id: 'fraud-1',
        transaction: { amount: 10000, installments: 1, requested_at: 'now' },
        customer: { avg_amount: 5000, tx_count_24h: 23, known_merchants: [] },
        merchant: { id: 'm1', mcc: '1', avg_amount: 100 },
        terminal: { is_online: true, card_present: true, km_from_home: 0 },
        last_transaction: null,
      };

      const result = appController.fraudScore(body);
      expect(result.approved).toBe(false);
      expect(result.fraud_score).toBeGreaterThan(0.6);
    });

    it('should return fraud_score: 0.0 for low risk transactions', () => {
      const body: TransactionBodyDto = {
        id: 'legit-1',
        transaction: { amount: 1, installments: 1, requested_at: 'now' },
        customer: { avg_amount: 1, tx_count_24h: 1, known_merchants: [] },
        merchant: { id: 'm1', mcc: '1', avg_amount: 100 },
        terminal: { is_online: true, card_present: true, km_from_home: 0 },
        last_transaction: null,
      };

      const result = appController.fraudScore(body);
      expect(result.fraud_score).toBe(0);
      expect(result.approved).toBe(true);
    });
  });
});
