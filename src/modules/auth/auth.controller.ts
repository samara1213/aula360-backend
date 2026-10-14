import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
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
import { STRICT_AUTH_THROTTLE } from '../../common/constants/throttle';
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
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import {
  MessageResponseDto,
  SessionResponseDto,
} from './dto/session-response.dto';
import { SwitchInstitutionDto } from './dto/switch-institution.dto';
import { TokenService } from './token.service';

const FORGOT_PASSWORD_MESSAGE =
  'Si el correo está registrado, recibirás un enlace para restablecer la contraseña';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
  ) {}

  private get cookieSettings() {
    return {
      secure: this.tokens.secureCookies,
      maxAgeMs: this.tokens.refreshTtlMs,
    };
  }

  @Public()
  @Throttle(STRICT_AUTH_THROTTLE)
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
  @ApiTooManyRequestsResponse({ description: 'Demasiados intentos' })
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
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Usuario autenticado, institución activa y roles' })
  @ApiOkResponse({ type: SessionResponseDto })
  @ApiUnauthorizedResponse()
  me(@CurrentUser() user: AuthUser): Promise<SessionResponseDto> {
    return this.auth.getSession(user);
  }

  @Post('switch-institution')
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Cambiar la institución activa' })
  @ApiOkResponse({ type: SessionResponseDto })
  @ApiNotFoundResponse({
    description: 'El usuario no pertenece a esa institución',
  })
  @ApiForbiddenResponse({ description: 'Debe cambiar la contraseña primero' })
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
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Post('refresh-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Renovar la sesión (rota el refresh token)',
    description: 'Usa la cookie refresh_token; el token usado queda revocado.',
  })
  @ApiNoContentResponse()
  @ApiUnauthorizedResponse({
    description: 'Refresh token inválido, vencido o reutilizado',
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
      clearAuthCookies(res, this.tokens.secureCookies);
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

  // Límite estricto: evita adivinar la contraseña actual con una sesión robada.
  @Throttle(STRICT_AUTH_THROTTLE)
  @Post('change-password')
  @AllowPendingPasswordChange()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth()
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
}
