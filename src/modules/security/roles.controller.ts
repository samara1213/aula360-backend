import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
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
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { SearchQueryDto } from '../../common/dto/list-query.dto';
import type { AuthUser } from '../../common/interfaces/auth-user.interface';
import { activeInstitutionId } from '../../common/utils/active-institution';
import { CreateRoleDto } from './dto/create-role.dto';
import { ReplaceRolePermissionsDto } from './dto/replace-role-permissions.dto';
import { RoleDetailDto, RolePageDto } from './dto/role-response.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { ROLE_PERMISSION, RoleScope, RolesService } from './roles.service';

const scopeOf = (user: AuthUser): RoleScope => ({
  kind: 'institution',
  user,
  institutionId: activeInstitutionId(user),
});

/** Roles de la institución activa; los globales se ven pero no se modifican aquí. */
@ApiTags('roles')
@ApiCookieAuth('access_token')
@ApiForbiddenResponse({ description: 'Sin permiso para esta acción' })
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermission(ROLE_PERMISSION, 'view')
  @ApiOperation({ summary: 'Listar roles globales y de la institución' })
  @ApiOkResponse({ type: RolePageDto })
  findAll(@CurrentUser() user: AuthUser, @Query() query: SearchQueryDto) {
    return this.roles.findAll(scopeOf(user), query);
  }

  @Get(':id')
  @RequirePermission(ROLE_PERMISSION, 'view')
  @ApiOperation({ summary: 'Ver un rol con sus permisos' })
  @ApiOkResponse({ type: RoleDetailDto })
  @ApiNotFoundResponse({ description: 'Rol no encontrado' })
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RoleDetailDto> {
    return this.roles.findOne(scopeOf(user), id);
  }

  @Post()
  @RequirePermission(ROLE_PERMISSION, 'create')
  @ApiOperation({ summary: 'Crear rol en la institución activa' })
  @ApiCreatedResponse({ type: RoleDetailDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiConflictResponse({ description: 'Ya existe un rol con ese nombre' })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateRoleDto,
  ): Promise<RoleDetailDto> {
    return this.roles.create(scopeOf(user), dto);
  }

  @Patch(':id')
  @RequirePermission(ROLE_PERMISSION, 'update')
  @ApiOperation({ summary: 'Editar nombre o descripción de un rol' })
  @ApiOkResponse({ type: RoleDetailDto })
  @ApiNotFoundResponse({ description: 'Rol no encontrado' })
  @ApiConflictResponse({ description: 'Ya existe un rol con ese nombre' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
  ): Promise<RoleDetailDto> {
    return this.roles.update(scopeOf(user), id, dto);
  }

  @Put(':id/permissions')
  @RequirePermission(ROLE_PERMISSION, 'update')
  @ApiOperation({
    summary: 'Reemplazar los permisos de un rol',
    description: 'Solo puede otorgar permisos que usted mismo tiene.',
  })
  @ApiOkResponse({ type: RoleDetailDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos u opción repetida' })
  @ApiNotFoundResponse({ description: 'Rol u opción de menú no encontrada' })
  replacePermissions(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceRolePermissionsDto,
  ): Promise<RoleDetailDto> {
    return this.roles.replacePermissions(scopeOf(user), id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(ROLE_PERMISSION, 'delete')
  @ApiOperation({ summary: 'Borrar un rol sin asignaciones' })
  @ApiNoContentResponse({ description: 'Rol borrado' })
  @ApiNotFoundResponse({ description: 'Rol no encontrado' })
  @ApiConflictResponse({ description: 'El rol está asignado a usuarios' })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.roles.remove(scopeOf(user), id);
  }
}
