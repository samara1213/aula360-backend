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
import type { AuthUser } from '../../common/interfaces/auth-user.interface';
import {
  ACADEMIC_YEARS_PERMISSION,
  AcademicYearsService,
} from './academic-years.service';
import {
  AcademicYearPageDto,
  AcademicYearQueryDto,
  AcademicYearResponseDto,
  CreateAcademicYearDto,
  UpdateAcademicYearDto,
} from './dto/academic-year.dto';
import {
  CreatePeriodDto,
  PeriodResponseDto,
  UpdatePeriodDto,
} from './dto/period.dto';
import { PERIODS_PERMISSION, PeriodsService } from './periods.service';

const INSTITUTION_WIDE =
  'Requiere alcance en toda la institución (quien está limitado a sedes solo consulta).';

@ApiTags('academic-years')
@ApiForbiddenResponse({ description: 'Sin permiso para esta acción' })
@Controller('academic-years')
export class AcademicYearsController {
  constructor(
    private readonly years: AcademicYearsService,
    private readonly periods: PeriodsService,
  ) {}

  @Get()
  @RequirePermission(ACADEMIC_YEARS_PERMISSION, 'view')
  @ApiOperation({ summary: 'Listar años lectivos de la institución activa' })
  @ApiOkResponse({ type: AcademicYearPageDto })
  findAll(@CurrentUser() user: AuthUser, @Query() query: AcademicYearQueryDto) {
    return this.years.findAll(user, query);
  }

  @Get(':id')
  @RequirePermission(ACADEMIC_YEARS_PERMISSION, 'view')
  @ApiOperation({ summary: 'Ver un año lectivo' })
  @ApiOkResponse({ type: AcademicYearResponseDto })
  @ApiNotFoundResponse({ description: 'Año lectivo no encontrado' })
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AcademicYearResponseDto> {
    return this.years.findOne(user, id);
  }

  @Post()
  @RequirePermission(ACADEMIC_YEARS_PERMISSION, 'create')
  @ApiOperation({ summary: 'Crear año lectivo', description: INSTITUTION_WIDE })
  @ApiCreatedResponse({ type: AcademicYearResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiConflictResponse({ description: 'Ese año ya existe en la institución' })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateAcademicYearDto,
  ): Promise<AcademicYearResponseDto> {
    return this.years.create(user, dto);
  }

  @Patch(':id')
  @RequirePermission(ACADEMIC_YEARS_PERMISSION, 'update')
  @ApiOperation({
    summary: 'Editar año lectivo (número o estado)',
    description: `El número solo cambia si el año no tiene periodos ni cursos. ${INSTITUTION_WIDE}`,
  })
  @ApiOkResponse({ type: AcademicYearResponseDto })
  @ApiNotFoundResponse({ description: 'Año lectivo no encontrado' })
  @ApiConflictResponse({
    description: 'Año repetido, o ya tiene periodos o cursos',
  })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAcademicYearDto,
  ): Promise<AcademicYearResponseDto> {
    return this.years.update(user, id, dto);
  }

  @Delete(':id')
  @RequirePermission(ACADEMIC_YEARS_PERMISSION, 'delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Borrar año lectivo (solo si nada lo usa)',
    description: INSTITUTION_WIDE,
  })
  @ApiNoContentResponse({ description: 'Año lectivo borrado' })
  @ApiNotFoundResponse({ description: 'Año lectivo no encontrado' })
  @ApiConflictResponse({ description: 'Tiene periodos, cursos o matrículas' })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.years.remove(user, id);
  }

  @Get(':id/periods')
  @RequirePermission(PERIODS_PERMISSION, 'view')
  @ApiOperation({ summary: 'Periodos del año lectivo (por fecha de inicio)' })
  @ApiOkResponse({ type: [PeriodResponseDto] })
  @ApiNotFoundResponse({ description: 'Año lectivo no encontrado' })
  findPeriods(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PeriodResponseDto[]> {
    return this.periods.findByYear(user, id);
  }

  @Post(':id/periods')
  @RequirePermission(PERIODS_PERMISSION, 'create')
  @ApiOperation({
    summary: 'Crear periodo en el año lectivo',
    description: `Empieza dentro del año lectivo, termina a más tardar el 31 de diciembre del año siguiente y no se cruza con otros periodos. ${INSTITUTION_WIDE}`,
  })
  @ApiCreatedResponse({ type: PeriodResponseDto })
  @ApiBadRequestResponse({ description: 'Fechas inválidas' })
  @ApiNotFoundResponse({ description: 'Año lectivo no encontrado' })
  @ApiConflictResponse({
    description: 'Nombre repetido o fechas cruzadas con otro periodo',
  })
  createPeriod(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePeriodDto,
  ): Promise<PeriodResponseDto> {
    return this.periods.create(user, id, dto);
  }
}

@ApiTags('periods')
@ApiForbiddenResponse({ description: 'Sin permiso para esta acción' })
@Controller('periods')
export class PeriodsController {
  constructor(private readonly periods: PeriodsService) {}

  @Get(':id')
  @RequirePermission(PERIODS_PERMISSION, 'view')
  @ApiOperation({ summary: 'Ver un periodo' })
  @ApiOkResponse({ type: PeriodResponseDto })
  @ApiNotFoundResponse({ description: 'Periodo no encontrado' })
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PeriodResponseDto> {
    return this.periods.findOne(user, id);
  }

  @Patch(':id')
  @RequirePermission(PERIODS_PERMISSION, 'update')
  @ApiOperation({ summary: 'Editar periodo', description: INSTITUTION_WIDE })
  @ApiOkResponse({ type: PeriodResponseDto })
  @ApiBadRequestResponse({ description: 'Fechas inválidas' })
  @ApiNotFoundResponse({ description: 'Periodo no encontrado' })
  @ApiConflictResponse({
    description: 'Nombre repetido o fechas cruzadas con otro periodo',
  })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePeriodDto,
  ): Promise<PeriodResponseDto> {
    return this.periods.update(user, id, dto);
  }

  @Delete(':id')
  @RequirePermission(PERIODS_PERMISSION, 'delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Borrar periodo (solo si nada lo usa)',
    description: INSTITUTION_WIDE,
  })
  @ApiNoContentResponse({ description: 'Periodo borrado' })
  @ApiNotFoundResponse({ description: 'Periodo no encontrado' })
  @ApiConflictResponse({ description: 'Tiene evaluaciones o boletines' })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.periods.remove(user, id);
  }
}
