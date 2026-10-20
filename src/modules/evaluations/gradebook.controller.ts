import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PEOPLE_LIST_THROTTLE } from '../../common/constants/throttle';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { AuthUser } from '../../common/interfaces/auth-user.interface';
import {
  CourseGradebookDto,
  CourseGradebookQueryDto,
  StudentGradebookDto,
  StudentGradebookQueryDto,
} from './dto/gradebook.dto';
import { GradebookService } from './gradebook.service';
import { SCORES_PERMISSION } from './scores.service';

const RULES =
  'Definitiva de la materia solo si los porcentajes del periodo suman 100 y están todas las notas; aprueba con la nota mínima de la institución. Promedios simples de las definitivas, a 2 decimales.';

/** Cuadro de notas ("gradebook"; /grades son los grados escolares). */
@ApiTags('gradebook')
@ApiForbiddenResponse({ description: 'Sin permiso' })
@ApiTooManyRequestsResponse({
  description: 'Más de 60 consultas por minuto (por usuario)',
})
@Throttle(PEOPLE_LIST_THROTTLE)
@Controller('gradebook')
export class GradebookController {
  constructor(private readonly gradebook: GradebookService) {}

  @Get('mine')
  @RequirePermission(SCORES_PERMISSION, 'view')
  @ApiOperation({
    summary: 'Mis notas (estudiante)',
    description: `Por periodo o por año (sin filtro: el año activo más reciente en que está matriculado). ${RULES}`,
  })
  @ApiOkResponse({ type: StudentGradebookDto })
  @ApiBadRequestResponse({ description: 'periodId y academicYearId a la vez' })
  @ApiNotFoundResponse({
    description:
      'Sin perfil de estudiante, periodo o año no encontrado, o sin matrícula en él',
  })
  mine(
    @CurrentUser() user: AuthUser,
    @Query() query: StudentGradebookQueryDto,
  ): Promise<StudentGradebookDto> {
    return this.gradebook.mine(user, query);
  }

  @Get('courses/:courseId')
  @RequirePermission(SCORES_PERMISSION, 'view')
  @ApiOperation({
    summary: 'Cuadro de notas de un curso en un periodo',
    description: `Al docente, solo sus materias. ${RULES}`,
  })
  @ApiOkResponse({ type: CourseGradebookDto })
  @ApiBadRequestResponse({ description: 'Periodo de otro año lectivo' })
  @ApiNotFoundResponse({ description: 'Curso o periodo no encontrado' })
  course(
    @CurrentUser() user: AuthUser,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Query() query: CourseGradebookQueryDto,
  ): Promise<CourseGradebookDto> {
    return this.gradebook.course(user, courseId, query.periodId);
  }

  @Get('students/:studentId')
  @RequirePermission(SCORES_PERMISSION, 'view')
  @ApiOperation({
    summary: 'Notas de un estudiante',
    description: `Por periodo o por año, con la nota anual (promedio simple de los periodos). Al docente, solo sus materias. ${RULES}`,
  })
  @ApiOkResponse({ type: StudentGradebookDto })
  @ApiBadRequestResponse({ description: 'periodId y academicYearId a la vez' })
  @ApiNotFoundResponse({
    description:
      'Estudiante, periodo o año no encontrado, o sin matrícula en él',
  })
  student(
    @CurrentUser() user: AuthUser,
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Query() query: StudentGradebookQueryDto,
  ): Promise<StudentGradebookDto> {
    return this.gradebook.student(user, studentId, query);
  }
}
