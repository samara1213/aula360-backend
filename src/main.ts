import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp, setupSwagger } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);

  const config = app.get(ConfigService);
  setupSwagger(app);

  const port = config.get<number>('PORT') ?? 3000;
  await app.listen(port);
  Logger.log(`Aula360 API escuchando en el puerto ${port}`, 'Bootstrap');
}
void bootstrap();
