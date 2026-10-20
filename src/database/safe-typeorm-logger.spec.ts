import { Logger } from '@nestjs/common';
import type { Logger as TypeOrmLogger } from 'typeorm';
import { SafeTypeOrmLogger } from './safe-typeorm-logger';
import { buildDataSourceOptions } from './typeorm.config';

describe('SafeTypeOrmLogger', () => {
  // Por la interfaz de TypeORM, que es como lo llama (con SQL y parámetros).
  const logger: TypeOrmLogger = new SafeTypeOrmLogger();
  let written: string[];

  beforeEach(() => {
    written = [];
    for (const level of ['log', 'warn', 'debug', 'error'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((message: unknown) => {
          written.push(String(message));
        });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it('una consulta fallida deja solo el código y la tabla, nunca parámetros ni detalle', () => {
    const error = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      table: 'students',
      detail: 'Key (document_number)=(1020304050) already exists.',
    });
    logger.logQueryError(
      error,
      'INSERT INTO "students" ("guardian_phone") VALUES ($1)',
      ['+57 300 765 4321', 'O+'],
    );
    expect(written).toEqual(['Consulta fallida (23505, tabla students)']);
  });

  it('las consultas normales no se escriben', () => {
    logger.logQuery('SELECT $1', ['secreto']);
    logger.logQuerySlow(5000, 'SELECT $1', ['secreto']);
    expect(written).toEqual([]);
  });

  it('la app y el CLI lo usan', () => {
    const options = buildDataSourceOptions({
      url: 'postgresql://x',
      ssl: false,
    });
    expect(options.logger).toBeInstanceOf(SafeTypeOrmLogger);
  });
});
