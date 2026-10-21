import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import {
  CURRENT_PASSWORD_THROTTLE,
  SENSITIVE_ACTION_THROTTLE,
  AccountThrottle,
  REFRESH_IP_THROTTLE,
  RefreshTokenThrottle,
  STRICT_AUTH_THROTTLE,
} from '../../common/constants/throttle';
import { RefreshTokenRotatedException } from '../../common/constants/error-codes';
import { AllowPendingPasswordChange } from '../../common/decorators/allow-pending-password-change.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { AuthUser } from '../../common/interfaces/auth-user.interface';
import {
  accessCookieName,
  clearAuthCookies,
  readCookie,
  refreshCookieName,
  setAccessCookie,
  setAuthCookies,
} from './auth-cookies';
import { AuthService } from './auth.service';
import { EmailVerificationService } from './email-verification.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import {
  MessageResponseDto,
  SessionResponseDto,
} from './dto/session-response.dto';
import { SwitchInstitutionDto } from './dto/switch-institution.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { TokenService } from './token.service';

const FORGOT_PASSWORD_MESSAGE =
  'Si el correo está registrado, recibirás un enlace para restablecer la contraseña';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly emailVerification: EmailVerificationService,
  ) {}

  private get cookieSettings() {
    return {
      secure: this.tokens.secureCookies,
      maxAgeMs: this.tokens.refreshTtlMs,
    };
  }

  @Public()
  @Throttle(STRICT_AUTH_THROTTLE)
  @AccountThrottle()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Iniciar sesión con email o número de documento',
    description:
      'Fija las cookies httpOnly access_token y refresh_token. Si el usuario tiene varias instituciones, activeInstitutionId es null y debe elegir con /auth/switch-institution.',
  })
  @ApiOkResponse({ type: SessionResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Credenciales inválidas (mensaje genérico)',
  })
  @ApiTooManyRequestsResponse({
    description:
      'Demasiados intentos: 5 por minuto por IP y 10 cada 15 minutos por cuenta',
  })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponseDto> {
    const { session, tokens } = await this.auth.login(dto);
    setAuthCookies(res, tokens, this.cookieSettings);
    return session;
  }

  @Get('me')
  @AllowPendingPasswordChange()
  @ApiOperation({ summary: 'Usuario autenticado, institución activa y roles' })
  @ApiOkResponse({ type: SessionResponseDto })
  @ApiUnauthorizedResponse()
  me(@CurrentUser() user: AuthUser): Promise<SessionResponseDto> {
    return this.auth.getSession(user);
  }

  @Post('switch-institution')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cambiar la institución activa' })
  @ApiOkResponse({ type: SessionResponseDto })
  @ApiNotFoundResponse({
    description: 'El usuario no pertenece a esa institución',
  })
  async switchInstitution(
    @CurrentUser() user: AuthUser,
    @Body() dto: SwitchInstitutionDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponseDto> {
    const { session, accessToken } = await this.auth.switchInstitution(
      user,
      dto.institutionId,
    );
    setAccessCookie(res, accessToken, this.cookieSettings);
    return session;
  }

  @Public()
  @Throttle(REFRESH_IP_THROTTLE)
  @RefreshTokenThrottle()
  @Post('refresh-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Renovar la sesión (rota el refresh token)',
    description: 'Usa la cookie refresh_token; el token usado queda revocado.',
  })
  @ApiNoContentResponse()
  @ApiUnauthorizedResponse({
    description:
      'Refresh token inválido, vencido o reutilizado. Reutilizar uno ya usado cierra todas las sesiones del usuario: hacer una sola renovación a la vez. Si se reutiliza en los 10 s siguientes a su rotación (carrera entre pestañas) responde con code REFRESH_TOKEN_ROTATED, sin cerrar sesiones ni borrar cookies: repetir la petición original.',
  })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    try {
      const tokens = await this.auth.refresh(
        readCookie(req, refreshCookieName(this.tokens.secureCookies)),
        readCookie(req, accessCookieName(this.tokens.secureCookies)),
      );
      setAuthCookies(res, tokens, this.cookieSettings);
    } catch (error) {
      // Solo una sesión inválida borra las cookies; un fallo del servidor
      // (p. ej. sin conexiones libres) no cierra la sesión (M2 de la fase 11e).
      // Tampoco una carrera entre pestañas: la otra ya dejó las cookies nuevas.
      if (
        error instanceof UnauthorizedException &&
        !(error instanceof RefreshTokenRotatedException)
      ) {
        clearAuthCookies(res, this.tokens.secureCookies);
      }
      throw error;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Cerrar sesión (revoca el refresh token y limpia cookies)',
  })
  @ApiNoContentResponse()
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(
      readCookie(req, refreshCookieName(this.tokens.secureCookies)),
    );
    clearAuthCookies(res, this.tokens.secureCookies);
  }

  // Por usuario: evita adivinar la contraseña actual con una sesión robada.
  @Throttle(CURRENT_PASSWORD_THROTTLE)
  @Post('change-password')
  @AllowPendingPasswordChange()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Cambiar la contraseña',
    description:
      'Cierra las demás sesiones y renueva las cookies de la actual.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({
    description: 'Contraseña actual incorrecta o nueva inválida',
  })
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const tokens = await this.auth.changePassword(user, dto);
    setAuthCookies(res, tokens, this.cookieSettings);
  }

  @Public()
  @Throttle(STRICT_AUTH_THROTTLE)
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Solicitar enlace de recuperación (respuesta siempre igual)',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  forgotPassword(@Body() dto: ForgotPasswordDto): MessageResponseDto {
    // No se espera: la respuesta no depende de si el correo existe.
    this.auth.forgotPassword(dto.email);
    return { message: FORGOT_PASSWORD_MESSAGE };
  }

  @Public()
  @Throttle(STRICT_AUTH_THROTTLE)
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Restablecer la contraseña con el token recibido por correo',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ description: 'Token inválido, vencido o ya usado' })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.auth.resetPassword(dto);
  }

  // Sin sesión: el enlace puede abrirse en otro dispositivo.
  @Public()
  @Throttle(STRICT_AUTH_THROTTLE)
  @Post('verify-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Confirmar el email con el token recibido por correo',
    description:
      'Si el token es de un cambio pendiente, el email nuevo pasa a ser el de la cuenta.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ description: 'Enlace inválido, vencido o ya usado' })
  @ApiConflictResponse({ description: 'El email ya lo usa otro usuario' })
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<void> {
    await this.emailVerification.confirm(dto.token);
  }

  @Throttle(SENSITIVE_ACTION_THROTTLE)
  @Post('verify-email/resend')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Reenviar el enlace de verificación (respuesta siempre igual)',
    description:
      'Del cambio pendiente o, si no hay, del email actual sin verificar. Uno cada 2 minutos.',
  })
  @ApiNoContentResponse()
  async resendVerification(@CurrentUser() user: AuthUser): Promise<void> {
    await this.emailVerification.resend(user.userId);
  }
}
