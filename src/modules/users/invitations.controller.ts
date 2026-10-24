import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SENSITIVE_ACTION_THROTTLE } from '../../common/constants/throttle';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/interfaces/auth-user.interface';
import { AcceptedInvitationDto, MyInvitationDto } from './dto/person-link.dto';
import { InvitationsService } from './invitations.service';

/**
 * Invitaciones que recibió el usuario de la sesión (siempre el del token):
 * sin permisos de menú, también sin institución activa.
 */
@ApiTags('users')
@Controller('users/me/invitations')
export class MyInvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get()
  @ApiOperation({ summary: 'Mis invitaciones pendientes' })
  @ApiOkResponse({ type: [MyInvitationDto] })
  mine(@CurrentUser() user: AuthUser): Promise<MyInvitationDto[]> {
    return this.invitations.mine(user);
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @Throttle(SENSITIVE_ACTION_THROTTLE)
  @ApiOperation({
    summary: 'Aceptar una invitación',
    description:
      'Crea su rol y su perfil en la institución. Para entrar a ella, cambiar de institución con /auth/switch-institution.',
  })
  @ApiOkResponse({ type: AcceptedInvitationDto })
  @ApiNotFoundResponse({ description: 'Invitación no encontrada' })
  @ApiConflictResponse({
    description:
      'Venció, la institución o la sede ya no está activa, o ya pertenece',
  })
  accept(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AcceptedInvitationDto> {
    return this.invitations.accept(user, id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(SENSITIVE_ACTION_THROTTLE)
  @ApiOperation({ summary: 'Rechazar una invitación' })
  @ApiNoContentResponse({ description: 'Invitación rechazada' })
  @ApiNotFoundResponse({ description: 'Invitación no encontrada' })
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.invitations.reject(user, id);
  }
}
