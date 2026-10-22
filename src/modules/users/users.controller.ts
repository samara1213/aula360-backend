import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  Query,
  UploadedFile,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  CURRENT_PASSWORD_THROTTLE,
  SENSITIVE_ACTION_THROTTLE,
  UPLOAD_THROTTLE,
} from '../../common/constants/throttle';
import { SuperAdminOnly } from '../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/interfaces/auth-user.interface';
import { ImageFilePipe, ValidatedFile } from '../../storage/image-file.pipe';
import { ImageUpload } from '../../storage/image-upload.decorator';
import { ChangeOwnEmailDto } from '../auth/dto/verify-email.dto';
import { EmailVerificationService } from '../auth/email-verification.service';
import { AvatarResponseDto } from './dto/avatar-response.dto';
import {
  UserLookupQueryDto,
  UserLookupResponseDto,
} from './dto/user-lookup.dto';
import { UsersService } from './users.service';

/** Rutas sobre el propio usuario: siempre el del token, nunca un id del cliente. */
@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly emailVerification: EmailVerificationService,
  ) {}

  // Va en este controller (registrado antes que /users/:id) para que
  // "lookup" no se tome como un id.
  @Get('lookup')
  @SuperAdminOnly()
  @Throttle(SENSITIVE_ACTION_THROTTLE)
  @ApiOperation({
    summary: 'Buscar un usuario activo por correo o documento (SUPER_ADMIN)',
    description:
      'Coincidencia exacta: email, o documentType y documentNumber. Para asignarle un rol en otra institución.',
  })
  @ApiOkResponse({ type: UserLookupResponseDto })
  @ApiBadRequestResponse({ description: 'Falta el correo o el documento' })
  @ApiForbiddenResponse({ description: 'Solo SUPER_ADMIN' })
  @ApiNotFoundResponse({
    description: 'No hay un usuario activo con esos datos',
  })
  lookup(@Query() query: UserLookupQueryDto): Promise<UserLookupResponseDto> {
    return this.users.lookup(query);
  }

  // Límite estricto: evita adivinar la contraseña actual con una sesión robada.
  @Put('me/email')
  @Throttle(CURRENT_PASSWORD_THROTTLE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Cambiar el email propio',
    description:
      'Queda pendiente hasta confirmarlo con el enlace enviado al correo nuevo; al anterior se le avisa.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ description: 'Contraseña actual incorrecta' })
  @ApiConflictResponse({ description: 'El email ya lo usa otro usuario' })
  async changeEmail(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangeOwnEmailDto,
  ): Promise<void> {
    await this.emailVerification.requestOwnChange(
      user.userId,
      dto.email,
      dto.currentPassword,
    );
  }

  @Get('me/avatar')
  @ApiOperation({
    summary: 'URL firmada (temporal) del avatar propio',
  })
  @ApiOkResponse({ type: AvatarResponseDto })
  @ApiNotFoundResponse({ description: 'El usuario no tiene avatar' })
  getAvatar(@CurrentUser() user: AuthUser): Promise<AvatarResponseDto> {
    return this.users.getAvatar(user.userId);
  }

  @Put('me/avatar')
  @Throttle(UPLOAD_THROTTLE)
  @ImageUpload()
  @ApiOperation({ summary: 'Subir o cambiar el avatar propio' })
  @ApiOkResponse({ type: AvatarResponseDto })
  replaceAvatar(
    @CurrentUser() user: AuthUser,
    @UploadedFile(ImageFilePipe) file: ValidatedFile,
  ): Promise<AvatarResponseDto> {
    return this.users.replaceAvatar(user.userId, file);
  }

  @Delete('me/avatar')
  @Throttle(UPLOAD_THROTTLE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Quitar el avatar propio' })
  @ApiNoContentResponse({ description: 'Avatar eliminado' })
  async removeAvatar(@CurrentUser() user: AuthUser): Promise<void> {
    await this.users.removeAvatar(user.userId);
  }
}
