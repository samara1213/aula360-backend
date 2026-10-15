import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  UploadedFile,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UPLOAD_THROTTLE } from '../../common/constants/throttle';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/interfaces/auth-user.interface';
import { ImageFilePipe, ValidatedFile } from '../../storage/image-file.pipe';
import { ImageUpload } from '../../storage/image-upload.decorator';
import { AvatarResponseDto } from './dto/avatar-response.dto';
import { UsersService } from './users.service';

/** Rutas sobre el propio usuario: siempre el del token, nunca un id del cliente. */
@ApiTags('users')
@ApiCookieAuth('access_token')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

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
