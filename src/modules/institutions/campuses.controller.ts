import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
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
import { ListQueryDto } from '../../common/dto/list-query.dto';
import type { AuthUser } from '../../common/interfaces/auth-user.interface';
import { CAMPUS_PERMISSION, CampusesService } from './campuses.service';
import { CampusPageDto, CampusResponseDto } from './dto/campus-response.dto';
import { CreateCampusDto } from './dto/create-campus.dto';
import { UpdateCampusDto } from './dto/update-campus.dto';

/** Sedes de la institución activa (la del token; nunca se recibe del cliente). */
@ApiTags('campuses')
@ApiForbiddenResponse({ description: 'Sin permiso para esta acción' })
@Controller('campuses')
export class CampusesController {
  constructor(private readonly campuses: CampusesService) {}

  @Get()
  @RequirePermission(CAMPUS_PERMISSION, 'view')
  @ApiOperation({ summary: 'Listar sedes de la institución activa' })
  @ApiOkResponse({ type: CampusPageDto })
  findAll(@CurrentUser() user: AuthUser, @Query() query: ListQueryDto) {
    return this.campuses.findAll(user, query);
  }

  @Get(':id')
  @RequirePermission(CAMPUS_PERMISSION, 'view')
  @ApiOperation({ summary: 'Ver una sede' })
  @ApiOkResponse({ type: CampusResponseDto })
  @ApiNotFoundResponse({ description: 'Sede no encontrada' })
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CampusResponseDto> {
    return this.campuses.findOne(user, id);
  }

  @Post()
  @RequirePermission(CAMPUS_PERMISSION, 'create')
  @ApiOperation({ summary: 'Crear sede en la institución activa' })
  @ApiCreatedResponse({ type: CampusResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiConflictResponse({ description: 'Ya existe una sede con ese nombre' })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateCampusDto,
  ): Promise<CampusResponseDto> {
    return this.campuses.create(user, dto);
  }

  @Patch(':id')
  @RequirePermission(CAMPUS_PERMISSION, 'update')
  @ApiOperation({ summary: 'Editar sede' })
  @ApiOkResponse({ type: CampusResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiNotFoundResponse({ description: 'Sede no encontrada' })
  @ApiConflictResponse({ description: 'Ya existe una sede con ese nombre' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCampusDto,
  ): Promise<CampusResponseDto> {
    return this.campuses.update(user, id, dto);
  }

  @Patch(':id/deactivate')
  @RequirePermission(CAMPUS_PERMISSION, 'delete')
  @ApiOperation({ summary: 'Desactivar sede (lógico)' })
  @ApiOkResponse({ type: CampusResponseDto })
  @ApiNotFoundResponse({ description: 'Sede no encontrada' })
  deactivate(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CampusResponseDto> {
    return this.campuses.setActive(user, id, false);
  }

  // Mismo permiso que desactivar: quien no puede desactivar tampoco puede revertirlo.
  @Patch(':id/activate')
  @RequirePermission(CAMPUS_PERMISSION, 'delete')
  @ApiOperation({ summary: 'Reactivar sede' })
  @ApiOkResponse({ type: CampusResponseDto })
  @ApiNotFoundResponse({ description: 'Sede no encontrada' })
  activate(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CampusResponseDto> {
    return this.campuses.setActive(user, id, true);
  }
}

/** Sedes de cualquier institución (SUPER_ADMIN): mismas reglas, sin alcance por sede. */
@ApiTags('campuses')
@ApiForbiddenResponse({ description: 'Solo SUPER_ADMIN' })
@SuperAdminOnly()
@Controller('institutions/:institutionId/campuses')
export class InstitutionCampusesController {
  constructor(private readonly campuses: CampusesService) {}

  @Get()
  @ApiOperation({ summary: 'Listar sedes de una institución' })
  @ApiOkResponse({ type: CampusPageDto })
  @ApiNotFoundResponse({ description: 'Institución no encontrada' })
  findAll(
    @Param('institutionId', ParseUUIDPipe) institutionId: string,
    @Query() query: ListQueryDto,
  ) {
    return this.campuses.findAllOf(institutionId, query);
  }

  @Post()
  @ApiOperation({ summary: 'Crear una sede en una institución' })
  @ApiCreatedResponse({ type: CampusResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiNotFoundResponse({ description: 'Institución no encontrada' })
  @ApiConflictResponse({ description: 'Ya existe una sede con ese nombre' })
  create(
    @CurrentUser() user: AuthUser,
    @Param('institutionId', ParseUUIDPipe) institutionId: string,
    @Body() dto: CreateCampusDto,
  ): Promise<CampusResponseDto> {
    return this.campuses.createOf(user, institutionId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Editar una sede de una institución' })
  @ApiOkResponse({ type: CampusResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiNotFoundResponse({ description: 'Institución o sede no encontrada' })
  @ApiConflictResponse({ description: 'Ya existe una sede con ese nombre' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('institutionId', ParseUUIDPipe) institutionId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCampusDto,
  ): Promise<CampusResponseDto> {
    return this.campuses.updateOf(user, institutionId, id, dto);
  }

  @Patch(':id/deactivate')
  @ApiOperation({ summary: 'Desactivar una sede de una institución' })
  @ApiOkResponse({ type: CampusResponseDto })
  @ApiNotFoundResponse({ description: 'Institución o sede no encontrada' })
  deactivate(
    @CurrentUser() user: AuthUser,
    @Param('institutionId', ParseUUIDPipe) institutionId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CampusResponseDto> {
    return this.campuses.setActiveOf(user, institutionId, id, false);
  }

  @Patch(':id/activate')
  @ApiOperation({ summary: 'Reactivar una sede de una institución' })
  @ApiOkResponse({ type: CampusResponseDto })
  @ApiNotFoundResponse({ description: 'Institución o sede no encontrada' })
  activate(
    @CurrentUser() user: AuthUser,
    @Param('institutionId', ParseUUIDPipe) institutionId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CampusResponseDto> {
    return this.campuses.setActiveOf(user, institutionId, id, true);
  }
}
