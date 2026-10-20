import { Logger as NestLogger } from '@nestjs/common';
import { Logger } from 'typeorm';

/**
 * Logger de TypeORM que nunca escribe parámetros ni el detalle de Postgres
 * (hallazgo M1 de la fase 11e). El de TypeORM, ante cada consulta fallida,
 * escribe el SQL con "-- PARAMETERS: [...]": documentos, correos, hashes y
 * datos de menores. Aquí solo queda el código de Postgres y la tabla.
 */
export class SafeTypeOrmLogger implements Logger {
  private readonly logger = new NestLogger('TypeORM');

  logQuery(): void {}

  logQuerySlow(): void {}

  /** Lo usa el CLI (migration:show, run, revert): sin datos de las tablas. */
  logSchemaBuild(message: string): void {
    this.logger.log(message);
  }

  logMigration(message: string): void {
    this.logger.log(message);
  }

  logQueryError(error: string | Error): void {
    const { code, table } = (typeof error === 'object' ? error : {}) as {
      code?: string;
      table?: string;
    };
    // Las violaciones de restricción esperadas (23xxx) las traduce el filtro
    // global a 400/409: no son errores del servidor.
    const message = `Consulta fallida (${code ?? 'sin código'}${table ? `, tabla ${table}` : ''})`;
    if (code?.startsWith('23')) this.logger.debug(message);
    else this.logger.warn(message);
  }

  log(level: 'log' | 'info' | 'warn', message: unknown): void {
    if (level === 'warn') this.logger.warn(String(message));
  }
}
