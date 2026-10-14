import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('responde status ok', async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    expect(module.get(HealthController).check()).toEqual({ status: 'ok' });
  });
});
