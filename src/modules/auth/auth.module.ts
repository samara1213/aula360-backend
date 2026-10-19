import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { MailModule } from '../mail/mail.module';
import { RoleMenuPermissionEntity } from '../security/entities/role-menu-permission.entity';
import { UserInstitutionRoleEntity } from '../security/entities/user-institution-role.entity';
import { UserEntity } from '../users/entities/user.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailVerificationService } from './email-verification.service';
import { EmailVerificationTokenEntity } from './entities/email-verification-token.entity';
import { PasswordResetTokenEntity } from './entities/password-reset-token.entity';
import { RefreshTokenEntity } from './entities/refresh-token.entity';
import { TokenService } from './token.service';

@Module({
  imports: [
    // El secreto y la expiración se pasan en cada firma/verificación (TokenService).
    JwtModule.register({}),
    TypeOrmModule.forFeature([
      UserEntity,
      UserInstitutionRoleEntity,
      RoleMenuPermissionEntity,
      RefreshTokenEntity,
      PasswordResetTokenEntity,
      EmailVerificationTokenEntity,
    ]),
    MailModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    EmailVerificationService,
    // Guards globales, en este orden: sesión, límite de peticiones (ya con
    // req.user, para contar por usuario donde se pida) y permisos. Las rutas
    // @Public (login) pasan la sesión sin coste y siguen limitadas.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [TokenService, EmailVerificationService],
})
export class AuthModule {}
