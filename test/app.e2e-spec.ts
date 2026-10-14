import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

describe('App (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health responde 200', () => {
    return request(app.getHttpServer())
      .get('/api/health')
      .expect(200, { status: 'ok' });
  });

  it('una ruta inexistente responde 404 con el formato uniforme', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/no-existe')
      .expect(404);
    expect(res.body).toMatchObject({ statusCode: 404, path: '/api/no-existe' });
  });
});
