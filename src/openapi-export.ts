import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'fs';
import { AppModule } from './app.module';
import { API_PREFIX } from './app.setup';
import { createOpenApiDocument } from './common/swagger/openapi';

/**
 * Escribe el documento OpenAPI en un archivo (para generar el cliente del
 * frontend). Modo preview: no instancia providers ni se conecta a la base.
 * Uso: yarn openapi:export openapi.json
 */
async function exportOpenApi(file: string) {
  const app = await NestFactory.create(AppModule, {
    preview: true,
    logger: ['error'],
  });
  app.setGlobalPrefix(API_PREFIX);
  writeFileSync(file, JSON.stringify(createOpenApiDocument(app), null, 2));
  await app.close();
  Logger.log(`OpenAPI escrito en ${file}`, 'OpenApiExport');
}

void exportOpenApi(process.argv[2] ?? 'openapi.json');
