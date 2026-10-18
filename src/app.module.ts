import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HealthController } from './health.controller';
import { DEFAULT_THROTTLE } from './common/constants/throttle';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { validateEnv } from './config/env.validation';
import { buildDataSourceOptions } from './database/typeorm.config';
import { AcademicModule } from './modules/academic/academic.module';
import { AuthModule } from './modules/auth/auth.module';
import { EnrollmentsModule } from './modules/enrollments/enrollments.module';
import { EvaluationsModule } from './modules/evaluations/evaluations.module';
import { InstitutionsModule } from './modules/institutions/institutions.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SecurityModule } from './modules/security/security.module';
import { UsersModule } from './modules/users/users.module';
import { StorageModule } from './storage/storage.module';

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
    StorageModule,
    AuthModule,
    InstitutionsModule,
    SecurityModule,
    UsersModule,
    AcademicModule,
    EnrollmentsModule,
    EvaluationsModule,
    ReportsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
