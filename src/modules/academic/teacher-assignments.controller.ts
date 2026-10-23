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
  CreateTeacherAssignmentDto,
  ReplaceTeacherDto,
  TeacherAssignmentPageDto,
  TeacherAssignmentQueryDto,
  TeacherAssignmentResponseDto,
} from './dto/teacher-assignment.dto';
import { PeriodResponseDto } from './dto/period.dto';
import {
  TEACHER_ASSIGNMENTS_PERMISSION,
  TeacherAssignmentsService,
} from './teacher-assignments.service';

const RULES =
  'El docente debe estar activo y tener el rol TEACHER en la sede del curso o en toda la institución; el año lectivo del curso, activo. Quien está limitado a sedes solo gestiona la carga de los cursos de esas sedes.';

@ApiTags('teacher-assignments')
@ApiForbiddenResponse({ description: 'Sin permiso para esta acción' })
@Controller('teacher-assignments')
export class TeacherAssignmentsController {
  constructor(private readonly assignments: TeacherAssignmentsService) {}

  @Get()
  @RequirePermission(TEACHER_ASSIGNMENTS_PERMISSION, 'view')
  @ApiOperation({ summary: 'Listar la carga académica (activa e historial)' })
  @ApiOkResponse({ type: TeacherAssignmentPageDto })
  findAll(
    @CurrentUser() user: AuthUser,
    @Query() query: TeacherAssignmentQueryDto,
  ) {
    return this.assignments.findAll(user, query);
  }

  // Sin @RequirePermission: basta con el perfil de docente en la institución activa.
  @Get('mine')
  @ApiOperation({
    summary: 'Mi carga académica activa (docente)',
    description:
      'Lista vacía si no tiene perfil de docente en la institución activa.',
  })
  @ApiOkResponse({ type: [TeacherAssignmentResponseDto] })
  findMine(
    @CurrentUser() user: AuthUser,
  ): Promise<TeacherAssignmentResponseDto[]> {
    return this.assignments.findMine(user);
  }

  // Sin @RequirePermission, como /mine: el rol TEACHER no ve /periods.
  @Get('mine/periods')
  @ApiOperation({
    summary: 'Periodos de mi carga activa (docente)',
    description:
      'Periodos de los años activos en que tiene carga activa. Lista vacía si no tiene perfil de docente en la institución activa.',
  })
  @ApiOkResponse({ type: [PeriodResponseDto] })
  findMinePeriods(@CurrentUser() user: AuthUser): Promise<PeriodResponseDto[]> {
    return this.assignments.findMinePeriods(user);
  }

  @Get(':id')
  @RequirePermission(TEACHER_ASSIGNMENTS_PERMISSION, 'view')
  @ApiOperation({ summary: 'Ver una asignación' })
  @ApiOkResponse({ type: TeacherAssignmentResponseDto })
  @ApiNotFoundResponse({ description: 'Asignación no encontrada' })
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TeacherAssignmentResponseDto> {
    return this.assignments.findOne(user, id);
  }

  @Post()
  @RequirePermission(TEACHER_ASSIGNMENTS_PERMISSION, 'create')
  @ApiOperation({
    summary: 'Asignar un docente a una materia en un curso',
    description: RULES,
  })
  @ApiCreatedResponse({ type: TeacherAssignmentResponseDto })
  @ApiBadRequestResponse({
    description:
      'Docente inactivo o sin el rol TEACHER en la sede, o año inactivo',
  })
  @ApiNotFoundResponse({
    description: 'Curso, materia o docente no encontrado',
  })
  @ApiConflictResponse({
    description: 'La materia ya tiene un docente activo en el curso',
  })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateTeacherAssignmentDto,
  ): Promise<TeacherAssignmentResponseDto> {
    return this.assignments.create(user, dto);
  }

  @Post(':id/replace')
  @RequirePermission(TEACHER_ASSIGNMENTS_PERMISSION, 'update')
  @ApiOperation({
    summary: 'Reemplazar al docente',
    description: `La asignación actual queda inactiva (historial) y se crea una nueva, en una transacción. ${RULES}`,
  })
  @ApiCreatedResponse({ type: TeacherAssignmentResponseDto })
  @ApiBadRequestResponse({
    description:
      'Mismo docente, docente inactivo o sin el rol TEACHER en la sede',
  })
  @ApiNotFoundResponse({ description: 'Asignación o docente no encontrado' })
  @ApiConflictResponse({ description: 'La asignación ya no está activa' })
  replace(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceTeacherDto,
  ): Promise<TeacherAssignmentResponseDto> {
    return this.assignments.replace(user, id, dto);
  }

  @Patch(':id/deactivate')
  @RequirePermission(TEACHER_ASSIGNMENTS_PERMISSION, 'update')
  @ApiOperation({ summary: 'Terminar la asignación sin reemplazo' })
  @ApiOkResponse({ type: TeacherAssignmentResponseDto })
  @ApiNotFoundResponse({ description: 'Asignación no encontrada' })
  deactivate(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TeacherAssignmentResponseDto> {
    return this.assignments.deactivate(user, id);
  }

  @Delete(':id')
  @RequirePermission(TEACHER_ASSIGNMENTS_PERMISSION, 'delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Borrar una asignación (solo para corregir errores)',
    description: 'No se puede si ya tiene evaluaciones.',
  })
  @ApiNoContentResponse({ description: 'Asignación borrada' })
  @ApiNotFoundResponse({ description: 'Asignación no encontrada' })
  @ApiConflictResponse({ description: 'La asignación tiene evaluaciones' })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.assignments.remove(user, id);
  }
}
