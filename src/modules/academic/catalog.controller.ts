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
import {
  GRADES_PERMISSION,
  GradesService,
  SUBJECTS_PERMISSION,
  SubjectsService,
} from './catalog.service';
import {
  CatalogItemResponseDto,
  CatalogPageDto,
  CreateGradeDto,
  CreateSubjectDto,
  UpdateGradeDto,
  UpdateSubjectDto,
} from './dto/catalog.dto';

const INSTITUTION_WIDE =
  'Requiere alcance en toda la institución (quien está limitado a sedes solo consulta).';

@ApiTags('grades')
@ApiCookieAuth('access_token')
@ApiForbiddenResponse({ description: 'Sin permiso para esta acción' })
@Controller('grades')
export class GradesController {
  constructor(private readonly grades: GradesService) {}

  @Get()
  @RequirePermission(GRADES_PERMISSION, 'view')
  @ApiOperation({ summary: 'Listar grados de la institución activa' })
  @ApiOkResponse({ type: CatalogPageDto })
  findAll(@CurrentUser() user: AuthUser, @Query() query: SearchQueryDto) {
    return this.grades.findAll(user, query);
  }

  @Get(':id')
  @RequirePermission(GRADES_PERMISSION, 'view')
  @ApiOperation({ summary: 'Ver un grado' })
  @ApiOkResponse({ type: CatalogItemResponseDto })
  @ApiNotFoundResponse({ description: 'Grado no encontrado' })
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CatalogItemResponseDto> {
    return this.grades.findOne(user, id);
  }

  @Post()
  @RequirePermission(GRADES_PERMISSION, 'create')
  @ApiOperation({ summary: 'Crear grado', description: INSTITUTION_WIDE })
  @ApiCreatedResponse({ type: CatalogItemResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiConflictResponse({ description: 'Ya existe un grado con ese nombre' })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateGradeDto,
  ): Promise<CatalogItemResponseDto> {
    return this.grades.create(user, dto);
  }

  @Patch(':id')
  @RequirePermission(GRADES_PERMISSION, 'update')
  @ApiOperation({ summary: 'Editar grado', description: INSTITUTION_WIDE })
  @ApiOkResponse({ type: CatalogItemResponseDto })
  @ApiNotFoundResponse({ description: 'Grado no encontrado' })
  @ApiConflictResponse({ description: 'Ya existe un grado con ese nombre' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGradeDto,
  ): Promise<CatalogItemResponseDto> {
    return this.grades.update(user, id, dto);
  }

  @Delete(':id')
  @RequirePermission(GRADES_PERMISSION, 'delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Borrar grado (solo si no tiene cursos)',
    description: INSTITUTION_WIDE,
  })
  @ApiNoContentResponse({ description: 'Grado borrado' })
  @ApiNotFoundResponse({ description: 'Grado no encontrado' })
  @ApiConflictResponse({ description: 'El grado tiene cursos' })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.grades.remove(user, id);
  }
}

@ApiTags('subjects')
@ApiCookieAuth('access_token')
@ApiForbiddenResponse({ description: 'Sin permiso para esta acción' })
@Controller('subjects')
export class SubjectsController {
  constructor(private readonly subjects: SubjectsService) {}

  @Get()
  @RequirePermission(SUBJECTS_PERMISSION, 'view')
  @ApiOperation({ summary: 'Listar materias de la institución activa' })
  @ApiOkResponse({ type: CatalogPageDto })
  findAll(@CurrentUser() user: AuthUser, @Query() query: SearchQueryDto) {
    return this.subjects.findAll(user, query);
  }

  @Get(':id')
  @RequirePermission(SUBJECTS_PERMISSION, 'view')
  @ApiOperation({ summary: 'Ver una materia' })
  @ApiOkResponse({ type: CatalogItemResponseDto })
  @ApiNotFoundResponse({ description: 'Materia no encontrada' })
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CatalogItemResponseDto> {
    return this.subjects.findOne(user, id);
  }

  @Post()
  @RequirePermission(SUBJECTS_PERMISSION, 'create')
  @ApiOperation({ summary: 'Crear materia', description: INSTITUTION_WIDE })
  @ApiCreatedResponse({ type: CatalogItemResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiConflictResponse({ description: 'Ya existe una materia con ese nombre' })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateSubjectDto,
  ): Promise<CatalogItemResponseDto> {
    return this.subjects.create(user, dto);
  }

  @Patch(':id')
  @RequirePermission(SUBJECTS_PERMISSION, 'update')
  @ApiOperation({ summary: 'Editar materia', description: INSTITUTION_WIDE })
  @ApiOkResponse({ type: CatalogItemResponseDto })
  @ApiNotFoundResponse({ description: 'Materia no encontrada' })
  @ApiConflictResponse({ description: 'Ya existe una materia con ese nombre' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSubjectDto,
  ): Promise<CatalogItemResponseDto> {
    return this.subjects.update(user, id, dto);
  }

  @Delete(':id')
  @RequirePermission(SUBJECTS_PERMISSION, 'delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Borrar materia (solo si no tiene carga académica)',
    description: INSTITUTION_WIDE,
  })
  @ApiNoContentResponse({ description: 'Materia borrada' })
  @ApiNotFoundResponse({ description: 'Materia no encontrada' })
  @ApiConflictResponse({ description: 'La materia tiene carga académica' })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.subjects.remove(user, id);
  }
}
