import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SENSITIVE_ACTION_THROTTLE } from '../../common/constants/throttle';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  RequirePermission,
  SuperAdminOnly,
} from '../../common/decorators/require-permission.decorator';
import type { AuthUser } from '../../common/interfaces/auth-user.interface';
import { activeInstitutionId } from '../../common/utils/active-institution';
import { AvatarResponseDto } from './dto/avatar-response.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { UserQueryDto } from './dto/user-query.dto';
import {
  CreatedUserResponseDto,
  TemporaryPasswordResponseDto,
  UserPageDto,
  UserResponseDto,
} from './dto/user-response.dto';
import {
  ManagedUsersService,
  USERS_PERMISSION,
  UsersScope,
} from './managed-users.service';

const scopeOf = (user: AuthUser): UsersScope => ({
  kind: 'institution',
  user,
  institutionId: activeInstitutionId(user),
});

const EXCLUSIVE_NOTE =
  'Solo si el usuario pertenece únicamente a esta institución (y a sus sedes, si su permiso está limitado a sedes); si no, solo un SUPER_ADMIN.';

/**
 * Usuarios de la institución activa, gestionados por administradores.
 * Se registra DESPUÉS de UsersController: así /users/me/avatar no cae en /users/:id/avatar.
 */
@ApiTags('users')
@ApiCookieAuth('access_token')
@ApiForbiddenResponse({ description: 'Sin permiso para esta acción' })
@Controller('users')
export class ManagedUsersController {
  constructor(private readonly users: ManagedUsersService) {}

  @Get()
  @RequirePermission(USERS_PERMISSION, 'view')
  @ApiOperation({ summary: 'Listar usuarios de la institución activa' })
  @ApiOkResponse({ type: UserPageDto })
  findAll(@CurrentUser() user: AuthUser, @Query() query: UserQueryDto) {
    return this.users.findAll(scopeOf(user), query);
  }

  @Get(':id')
  @RequirePermission(USERS_PERMISSION, 'view')
  @ApiOperation({ summary: 'Detalle de un usuario de la institución activa' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiNotFoundResponse({ description: 'Usuario no encontrado' })
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UserResponseDto> {
    return this.users.findOne(scopeOf(user), id);
  }

  @Get(':id/avatar')
  @RequirePermission(USERS_PERMISSION, 'view')
  @ApiOperation({ summary: 'URL firmada (temporal) del avatar de un usuario' })
  @ApiOkResponse({ type: AvatarResponseDto })
  @ApiNotFoundResponse({ description: 'Usuario no encontrado o sin avatar' })
  getAvatar(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AvatarResponseDto> {
    return this.users.getAvatar(scopeOf(user), id);
  }

  @Post()
  @Throttle(SENSITIVE_ACTION_THROTTLE)
  @RequirePermission(USERS_PERMISSION, 'create')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Crear un usuario con contraseña temporal y su primer rol',
    description:
      'La contraseña temporal se devuelve una sola vez (y se envía por correo si hay email). Solo puede asignar roles con permisos que usted tiene.',
  })
  @ApiCreatedResponse({ type: CreatedUserResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos o sede inactiva' })
  @ApiNotFoundResponse({ description: 'Rol o sede no encontrado' })
  @ApiConflictResponse({
    description: 'Ya existe un usuario con ese documento o email',
  })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateUserDto,
  ): Promise<CreatedUserResponseDto> {
    return this.users.create(scopeOf(user), dto);
  }

  @Patch(':id')
  @Throttle(SENSITIVE_ACTION_THROTTLE)
  @RequirePermission(USERS_PERMISSION, 'update')
  @ApiOperation({
    summary: 'Editar los datos personales de un usuario',
    description: `Nombres y teléfono: cualquier usuario que pueda gestionar. Documento: ${EXCLUSIVE_NOTE} Email: solo un SUPER_ADMIN (hasta que exista la verificación de email).`,
  })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiNotFoundResponse({ description: 'Usuario no encontrado' })
  @ApiConflictResponse({
    description: 'Ya existe un usuario con ese documento o email',
  })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<UserResponseDto> {
    return this.users.update(scopeOf(user), id, dto);
  }

  @Patch(':id/status')
  @RequirePermission(USERS_PERMISSION, 'update')
  @Throttle(SENSITIVE_ACTION_THROTTLE)
  @ApiOperation({
    summary: 'Activar o desactivar un usuario (cierra sus sesiones)',
    description: EXCLUSIVE_NOTE,
  })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiNotFoundResponse({ description: 'Usuario no encontrado' })
  setStatus(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserStatusDto,
  ): Promise<UserResponseDto> {
    return this.users.setStatus(scopeOf(user), id, dto);
  }

  @Post(':id/temporary-password')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(USERS_PERMISSION, 'update')
  @Throttle(SENSITIVE_ACTION_THROTTLE)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Generar una contraseña temporal nueva (cierra sus sesiones)',
    description: EXCLUSIVE_NOTE,
  })
  @ApiOkResponse({ type: TemporaryPasswordResponseDto })
  @ApiBadRequestResponse({ description: 'El usuario está inactivo' })
  @ApiNotFoundResponse({ description: 'Usuario no encontrado' })
  resetTemporaryPassword(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TemporaryPasswordResponseDto> {
    return this.users.resetTemporaryPassword(scopeOf(user), id);
  }
}

/**
 * El SUPER_ADMIN gestiona usuarios de cualquier institución: crea su primer
 * administrador y resuelve los casos de usuarios en varias instituciones.
 */
@ApiTags('users')
@ApiCookieAuth('access_token')
@ApiForbiddenResponse({ description: 'Solo SUPER_ADMIN' })
@SuperAdminOnly()
@Controller('institutions/:institutionId/users')
export class InstitutionUsersController {
  constructor(private readonly users: ManagedUsersService) {}

  private scope(user: AuthUser, institutionId: string): UsersScope {
    return { kind: 'system', user, institutionId };
  }

  @Get()
  @ApiOperation({ summary: 'Listar usuarios de una institución' })
  @ApiOkResponse({ type: UserPageDto })
  @ApiNotFoundResponse({ description: 'Institución no encontrada' })
  findAll(
    @CurrentUser() user: AuthUser,
    @Param('institutionId', ParseUUIDPipe) institutionId: string,
    @Query() query: UserQueryDto,
  ) {
    return this.users.findAll(this.scope(user, institutionId), query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de un usuario de una institución' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiNotFoundResponse({ description: 'Institución o usuario no encontrado' })
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('institutionId', ParseUUIDPipe) institutionId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UserResponseDto> {
    return this.users.findOne(this.scope(user, institutionId), id);
  }

  @Post()
  @Throttle(SENSITIVE_ACTION_THROTTLE)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Crear un usuario en una institución (p. ej. su primer administrador)',
  })
  @ApiCreatedResponse({ type: CreatedUserResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos o sede inactiva' })
  @ApiNotFoundResponse({ description: 'Institución, rol o sede no encontrado' })
  @ApiConflictResponse({
    description: 'Ya existe un usuario con ese documento o email',
  })
  create(
    @CurrentUser() user: AuthUser,
    @Param('institutionId', ParseUUIDPipe) institutionId: string,
    @Body() dto: CreateUserDto,
  ): Promise<CreatedUserResponseDto> {
    return this.users.create(this.scope(user, institutionId), dto);
  }

  @Patch(':id')
  @Throttle(SENSITIVE_ACTION_THROTTLE)
  @ApiOperation({ summary: 'Editar los datos personales de un usuario' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiNotFoundResponse({ description: 'Institución o usuario no encontrado' })
  @ApiConflictResponse({
    description: 'Ya existe un usuario con ese documento o email',
  })
  update(
    @CurrentUser() user: AuthUser,
    @Param('institutionId', ParseUUIDPipe) institutionId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<UserResponseDto> {
    return this.users.update(this.scope(user, institutionId), id, dto);
  }

  @Patch(':id/status')
  @Throttle(SENSITIVE_ACTION_THROTTLE)
  @ApiOperation({ summary: 'Activar o desactivar un usuario' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiNotFoundResponse({ description: 'Institución o usuario no encontrado' })
  setStatus(
    @CurrentUser() user: AuthUser,
    @Param('institutionId', ParseUUIDPipe) institutionId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserStatusDto,
  ): Promise<UserResponseDto> {
    return this.users.setStatus(this.scope(user, institutionId), id, dto);
  }

  @Post(':id/temporary-password')
  @HttpCode(HttpStatus.OK)
  @Throttle(SENSITIVE_ACTION_THROTTLE)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Generar una contraseña temporal nueva' })
  @ApiOkResponse({ type: TemporaryPasswordResponseDto })
  @ApiBadRequestResponse({ description: 'El usuario está inactivo' })
  @ApiNotFoundResponse({ description: 'Institución o usuario no encontrado' })
  resetTemporaryPassword(
    @CurrentUser() user: AuthUser,
    @Param('institutionId', ParseUUIDPipe) institutionId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TemporaryPasswordResponseDto> {
    return this.users.resetTemporaryPassword(
      this.scope(user, institutionId),
      id,
    );
  }
}
