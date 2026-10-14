import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HealthController } from './health.controller';
import { DEFAULT_THROTTLE } from './common/constants/throttle';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { validateEnv } from './config/env.validation';
import { buildDataSourceOptions } from './database/typeorm.config';
import { AuthModule } from './modules/auth/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildDataSourceOptions({
          url: config.getOrThrow<string>('DATABASE_URL'),
          ssl: String(config.get('DB_SSL')) !== 'false',
          ca: config.get<string>('DB_SSL_CA'),
        }),
    }),
    ThrottlerModule.forRoot({
      throttlers: [DEFAULT_THROTTLE],
      // Solo para pruebas e2e (nunca en producción: lo bloquea la validación de entorno).
      skipIf: () => process.env.THROTTLE_DISABLED === 'true',
    }),
    AuthModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
