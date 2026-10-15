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
import { SuperAdminOnly } from '../../common/decorators/require-permission.decorator';
import { SearchQueryDto } from '../../common/dto/list-query.dto';
import { CreateRoleDto } from './dto/create-role.dto';
import { ReplaceRolePermissionsDto } from './dto/replace-role-permissions.dto';
import { RoleDetailDto, RolePageDto } from './dto/role-response.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { RoleScope, RolesService } from './roles.service';

const GLOBAL: RoleScope = { kind: 'global' };

/** Roles globales del sistema (se asignan en cualquier institución). Solo SUPER_ADMIN. */
@ApiTags('global-roles')
@ApiCookieAuth('access_token')
@ApiForbiddenResponse({ description: 'Solo SUPER_ADMIN' })
@SuperAdminOnly()
@Controller('global-roles')
export class GlobalRolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @ApiOperation({ summary: 'Listar roles globales' })
  @ApiOkResponse({ type: RolePageDto })
  findAll(@Query() query: SearchQueryDto) {
    return this.roles.findAll(GLOBAL, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Ver un rol global con sus permisos' })
  @ApiOkResponse({ type: RoleDetailDto })
  @ApiNotFoundResponse({ description: 'Rol no encontrado' })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<RoleDetailDto> {
    return this.roles.findOne(GLOBAL, id);
  }

  @Post()
  @ApiOperation({ summary: 'Crear rol global' })
  @ApiCreatedResponse({ type: RoleDetailDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiConflictResponse({ description: 'Ya existe un rol con ese nombre' })
  create(@Body() dto: CreateRoleDto): Promise<RoleDetailDto> {
    return this.roles.create(GLOBAL, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Editar rol global' })
  @ApiOkResponse({ type: RoleDetailDto })
  @ApiNotFoundResponse({ description: 'Rol no encontrado' })
  @ApiConflictResponse({ description: 'Ya existe un rol con ese nombre' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
  ): Promise<RoleDetailDto> {
    return this.roles.update(GLOBAL, id, dto);
  }

  @Put(':id/permissions')
  @ApiOperation({
    summary: 'Reemplazar los permisos de un rol global',
    description: 'Afecta a todas las instituciones donde esté asignado.',
  })
  @ApiOkResponse({ type: RoleDetailDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos u opción repetida' })
  @ApiNotFoundResponse({ description: 'Rol u opción de menú no encontrada' })
  replacePermissions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceRolePermissionsDto,
  ): Promise<RoleDetailDto> {
    return this.roles.replacePermissions(GLOBAL, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Borrar un rol global sin asignaciones' })
  @ApiNoContentResponse({ description: 'Rol borrado' })
  @ApiNotFoundResponse({ description: 'Rol no encontrado' })
  @ApiConflictResponse({ description: 'El rol está asignado a usuarios' })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.roles.remove(GLOBAL, id);
  }
}
