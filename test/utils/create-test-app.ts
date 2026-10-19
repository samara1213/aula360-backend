import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { MailService } from '../../src/modules/mail/mail.service';
import { StorageService } from '../../src/storage/storage.service';
import { FakeMailService } from './fake-mail';
import { FakeStorageService } from './fake-storage';
import { TestData } from './test-data';

export interface TestContext {
  app: INestApplication<App>;
  data: TestData;
  dataSource: DataSource;
  storage: FakeStorageService;
  mail: FakeMailService;
}

/**
 * App igual a la de producción (configureApp) y fábrica de datos con limpieza
 * acotada. Storage y correo son en memoria: las e2e no suben archivos a
 * Supabase ni envían correos (ctx.mail guarda los mensajes).
 */
export async function createTestApp(): Promise<TestContext> {
  const storage = new FakeStorageService();
  const mail = new FakeMailService();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(StorageService)
    .useValue(storage)
    .overrideProvider(MailService)
    .useValue(mail)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  const dataSource = app.get(DataSource);
  const data = new TestData(dataSource);
  await data.sweepLeftovers();
  return { app, dataSource, data, storage, mail };
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
