import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  RequirePermission,
  SuperAdminOnly,
} from '../../common/decorators/require-permission.decorator';
import type { AuthUser } from '../../common/interfaces/auth-user.interface';
import { CreateMenuOptionDto } from './dto/create-menu-option.dto';
import {
  MenuOptionResponseDto,
  MenuOptionTreeNodeDto,
  MyMenuNodeDto,
} from './dto/menu-option-response.dto';
import { UpdateMenuOptionDto } from './dto/update-menu-option.dto';
import { MENU_PERMISSION, MenuOptionsService } from './menu-options.service';

/** Menú global: lo consulta quien gestiona roles; solo el SUPER_ADMIN lo modifica. */
@ApiTags('menu-options')
@ApiCookieAuth('access_token')
@ApiForbiddenResponse({ description: 'Sin permiso para esta acción' })
@Controller('menu-options')
export class MenuOptionsController {
  constructor(private readonly menus: MenuOptionsService) {}

  @Get('my-menu')
  @ApiOperation({
    summary: 'Menú del usuario en la institución activa',
    description:
      'Opciones permitidas por sus roles y sus ancestros, con las acciones permitidas en cada una. Sin institución activa devuelve [].',
  })
  @ApiOkResponse({ type: [MyMenuNodeDto] })
  myMenu(@CurrentUser() user: AuthUser): Promise<MyMenuNodeDto[]> {
    return this.menus.myMenu(user);
  }

  @Get()
  @RequirePermission(MENU_PERMISSION, 'view', { allowSuperAdmin: true })
  @ApiOperation({ summary: 'Árbol completo de menús (incluye inactivos)' })
  @ApiOkResponse({ type: [MenuOptionTreeNodeDto] })
  tree(): Promise<MenuOptionTreeNodeDto[]> {
    return this.menus.tree();
  }

  @Get(':id')
  @RequirePermission(MENU_PERMISSION, 'view', { allowSuperAdmin: true })
  @ApiOperation({ summary: 'Ver una opción de menú' })
  @ApiOkResponse({ type: MenuOptionResponseDto })
  @ApiNotFoundResponse({ description: 'Opción de menú no encontrada' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MenuOptionResponseDto> {
    return this.menus.findOne(id);
  }

  @Post()
  @SuperAdminOnly()
  @ApiOperation({ summary: 'Crear opción de menú (SUPER_ADMIN)' })
  @ApiCreatedResponse({ type: MenuOptionResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos o más de 3 niveles' })
  @ApiNotFoundResponse({ description: 'Opción padre no encontrada' })
  @ApiConflictResponse({ description: 'Ya existe una opción con ese slug' })
  create(@Body() dto: CreateMenuOptionDto): Promise<MenuOptionResponseDto> {
    return this.menus.create(dto);
  }

  @Patch(':id')
  @SuperAdminOnly()
  @ApiOperation({
    summary: 'Editar o mover opción de menú (SUPER_ADMIN; el slug no cambia)',
  })
  @ApiOkResponse({ type: MenuOptionResponseDto })
  @ApiBadRequestResponse({
    description: 'Datos inválidos, ciclo o más de 3 niveles',
  })
  @ApiNotFoundResponse({ description: 'Opción o padre no encontrado' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMenuOptionDto,
  ): Promise<MenuOptionResponseDto> {
    return this.menus.update(id, dto);
  }

  @Patch(':id/deactivate')
  @SuperAdminOnly()
  @ApiOperation({
    summary: 'Desactivar opción (oculta su rama y anula sus permisos)',
  })
  @ApiOkResponse({ type: MenuOptionResponseDto })
  @ApiNotFoundResponse({ description: 'Opción de menú no encontrada' })
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MenuOptionResponseDto> {
    return this.menus.setActive(id, false);
  }

  @Patch(':id/activate')
  @SuperAdminOnly()
  @ApiOperation({ summary: 'Reactivar opción de menú' })
  @ApiOkResponse({ type: MenuOptionResponseDto })
  @ApiNotFoundResponse({ description: 'Opción de menú no encontrada' })
  activate(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MenuOptionResponseDto> {
    return this.menus.setActive(id, true);
  }
}
