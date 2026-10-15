import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  RequirePermission,
  SuperAdminOnly,
} from '../../common/decorators/require-permission.decorator';
import type { AuthUser } from '../../common/interfaces/auth-user.interface';
import { activeInstitutionId } from '../../common/utils/active-institution';
import { CreateRoleAssignmentDto } from './dto/create-role-assignment.dto';
import { RoleAssignmentQueryDto } from './dto/role-assignment-query.dto';
import {
  RoleAssignmentPageDto,
  RoleAssignmentResponseDto,
} from './dto/role-assignment-response.dto';
import {
  ASSIGNMENT_PERMISSION,
  AssignmentScope,
  RoleAssignmentsService,
} from './role-assignments.service';

const scopeOf = (user: AuthUser): AssignmentScope => ({
  kind: 'institution',
  user,
  institutionId: activeInstitutionId(user),
});

/** Vínculos usuario-rol-sede en la institución activa. */
@ApiTags('role-assignments')
@ApiCookieAuth('access_token')
@ApiForbiddenResponse({ description: 'Sin permiso para esta acción' })
@Controller('role-assignments')
export class RoleAssignmentsController {
  constructor(private readonly assignments: RoleAssignmentsService) {}

  @Get()
  @RequirePermission(ASSIGNMENT_PERMISSION, 'view')
  @ApiOperation({ summary: 'Listar asignaciones de la institución activa' })
  @ApiOkResponse({ type: RoleAssignmentPageDto })
  findAll(
    @CurrentUser() user: AuthUser,
    @Query() query: RoleAssignmentQueryDto,
  ) {
    return this.assignments.findAll(scopeOf(user), query);
  }

  @Post()
  @RequirePermission(ASSIGNMENT_PERMISSION, 'create')
  @ApiOperation({
    summary: 'Asignar un rol a un usuario de la institución',
    description:
      'El usuario debe pertenecer ya a la institución; solo puede asignar roles con permisos que usted tiene.',
  })
  @ApiCreatedResponse({ type: RoleAssignmentResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos o sede inactiva' })
  @ApiNotFoundResponse({ description: 'Usuario, rol o sede no encontrado' })
  @ApiConflictResponse({ description: 'La asignación ya existe' })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateRoleAssignmentDto,
  ): Promise<RoleAssignmentResponseDto> {
    return this.assignments.create(scopeOf(user), dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(ASSIGNMENT_PERMISSION, 'delete')
  @ApiOperation({ summary: 'Quitar una asignación (no las propias)' })
  @ApiNoContentResponse({ description: 'Asignación quitada' })
  @ApiNotFoundResponse({ description: 'Asignación no encontrada' })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.assignments.remove(scopeOf(user), id);
  }
}

/** El SUPER_ADMIN vincula usuarios en cualquier institución (p. ej. su primer administrador). */
@ApiTags('role-assignments')
@ApiCookieAuth('access_token')
@ApiForbiddenResponse({ description: 'Solo SUPER_ADMIN' })
@SuperAdminOnly()
@Controller('institutions/:institutionId/role-assignments')
export class InstitutionRoleAssignmentsController {
  constructor(private readonly assignments: RoleAssignmentsService) {}

  private scope(user: AuthUser, institutionId: string): AssignmentScope {
    return { kind: 'system', user, institutionId };
  }

  @Get()
  @ApiOperation({ summary: 'Listar asignaciones de una institución' })
  @ApiOkResponse({ type: RoleAssignmentPageDto })
  @ApiNotFoundResponse({ description: 'Institución no encontrada' })
  findAll(
    @CurrentUser() user: AuthUser,
    @Param('institutionId', ParseUUIDPipe) institutionId: string,
    @Query() query: RoleAssignmentQueryDto,
  ) {
    return this.assignments.findAll(this.scope(user, institutionId), query);
  }

  @Post()
  @ApiOperation({ summary: 'Asignar un rol a cualquier usuario activo' })
  @ApiCreatedResponse({ type: RoleAssignmentResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos o sede inactiva' })
  @ApiNotFoundResponse({
    description: 'Institución, usuario, rol o sede no encontrado',
  })
  @ApiConflictResponse({ description: 'La asignación ya existe' })
  create(
    @CurrentUser() user: AuthUser,
    @Param('institutionId', ParseUUIDPipe) institutionId: string,
    @Body() dto: CreateRoleAssignmentDto,
  ): Promise<RoleAssignmentResponseDto> {
    return this.assignments.create(this.scope(user, institutionId), dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Quitar una asignación (no las propias)' })
  @ApiNoContentResponse({ description: 'Asignación quitada' })
  @ApiNotFoundResponse({
    description: 'Institución o asignación no encontrada',
  })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('institutionId', ParseUUIDPipe) institutionId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.assignments.remove(this.scope(user, institutionId), id);
  }
}
