import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { TestData } from './test-data';

export interface TestContext {
  app: INestApplication<App>;
  data: TestData;
  dataSource: DataSource;
}

/** App igual a la de producción (configureApp) y fábrica de datos con limpieza acotada. */
export async function createTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  const dataSource = app.get(DataSource);
  const data = new TestData(dataSource);
  await data.sweepLeftovers();
  return { app, dataSource, data };
}

/** Extrae las cookies Set-Cookie de una respuesta. */
export function setCookies(headers: Record<string, unknown>): string[] {
  const value = headers['set-cookie'];
  return Array.isArray(value) ? (value as string[]) : [];
}

export function findCookie(
  headers: Record<string, unknown>,
  name: string,
): string | undefined {
  return setCookies(headers).find((c) => c.startsWith(`${name}=`));
}
