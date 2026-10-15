import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { bodyParserMiddlewares } from './common/middleware/body-parser.middleware';
import { originCheckMiddleware } from './common/middleware/origin-check.middleware';
import { uploadSizeMiddleware } from './common/middleware/upload-size.middleware';
import { MULTIPART_MAX_BYTES } from './storage/storage.constants';

export const API_PREFIX = 'api';

export function parseOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Configuración HTTP común. La usan main.ts y las pruebas e2e para que se comporten igual.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);
  const origins = parseOrigins(config.getOrThrow<string>('CORS_ORIGINS'));

  // IP real del cliente detrás de un proxy inverso (para el rate limiting).
  // Número de saltos de confianza, nunca "true" (permitiría falsear X-Forwarded-For).
  const trustProxy = Number(config.get('TRUST_PROXY') ?? 0);
  if (trustProxy > 0) {
    (
      app.getHttpAdapter().getInstance() as { set(k: string, v: number): void }
    ).set('trust proxy', trustProxy);
  }

  app.use(helmet());
  // Subidas demasiado grandes: se rechazan sin leer el cuerpo.
  app.use(uploadSizeMiddleware(MULTIPART_MAX_BYTES));
  app.use(...bodyParserMiddlewares());
  app.use(cookieParser());
  // CSRF: rechaza métodos que modifican datos desde orígenes no permitidos.
  app.use(originCheckMiddleware(origins));

  // Las cookies requieren credentials: true y orígenes explícitos (nunca '*').
  app.enableCors({
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  app.setGlobalPrefix(API_PREFIX);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}

/** Swagger en /api/docs (deshabilitado en producción). */
export function setupSwagger(app: INestApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Aula360 API')
      .setDescription('API del backend de Aula360 (multi-institución)')
      .setVersion('1.0')
      .addCookieAuth('access_token')
      .build(),
  );
  SwaggerModule.setup(`${API_PREFIX}/docs`, app, document);
}
