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
import { COURSES_PERMISSION, CoursesService } from './courses.service';
import {
  CoursePageDto,
  CourseQueryDto,
  CourseResponseDto,
  CreateCourseDto,
  UpdateCourseDto,
} from './dto/course.dto';

const CAMPUS_SCOPE =
  'Quien está limitado a sedes solo ve y gestiona los cursos de esas sedes.';

@ApiTags('courses')
@ApiForbiddenResponse({ description: 'Sin permiso para esta acción' })
@Controller('courses')
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Get()
  @RequirePermission(COURSES_PERMISSION, 'view')
  @ApiOperation({
    summary: 'Listar cursos de la institución activa',
    description: CAMPUS_SCOPE,
  })
  @ApiOkResponse({ type: CoursePageDto })
  findAll(@CurrentUser() user: AuthUser, @Query() query: CourseQueryDto) {
    return this.courses.findAll(user, query);
  }

  @Get(':id')
  @RequirePermission(COURSES_PERMISSION, 'view')
  @ApiOperation({ summary: 'Ver un curso' })
  @ApiOkResponse({ type: CourseResponseDto })
  @ApiNotFoundResponse({ description: 'Curso no encontrado' })
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CourseResponseDto> {
    return this.courses.findOne(user, id);
  }

  @Post()
  @RequirePermission(COURSES_PERMISSION, 'create')
  @ApiOperation({
    summary: 'Crear curso (grado + sede + año lectivo)',
    description: `La sede y el año lectivo deben estar activos. ${CAMPUS_SCOPE}`,
  })
  @ApiCreatedResponse({ type: CourseResponseDto })
  @ApiBadRequestResponse({
    description: 'Datos inválidos, sede o año inactivo',
  })
  @ApiNotFoundResponse({ description: 'Grado, sede o año no encontrado' })
  @ApiConflictResponse({
    description: 'Ya existe ese curso para el grado, la sede y el año',
  })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateCourseDto,
  ): Promise<CourseResponseDto> {
    return this.courses.create(user, dto);
  }

  @Patch(':id')
  @RequirePermission(COURSES_PERMISSION, 'update')
  @ApiOperation({
    summary: 'Editar curso',
    description: `Grado, sede y año solo cambian si no tiene carga académica ni matrículas. ${CAMPUS_SCOPE}`,
  })
  @ApiOkResponse({ type: CourseResponseDto })
  @ApiBadRequestResponse({
    description: 'Datos inválidos, sede o año inactivo',
  })
  @ApiNotFoundResponse({
    description: 'Curso, grado, sede o año no encontrado',
  })
  @ApiConflictResponse({
    description: 'Curso repetido, o ya tiene carga académica o matrículas',
  })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCourseDto,
  ): Promise<CourseResponseDto> {
    return this.courses.update(user, id, dto);
  }

  @Delete(':id')
  @RequirePermission(COURSES_PERMISSION, 'delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Borrar curso (solo si nada lo usa)' })
  @ApiNoContentResponse({ description: 'Curso borrado' })
  @ApiNotFoundResponse({ description: 'Curso no encontrado' })
  @ApiConflictResponse({
    description: 'Tiene carga académica, matrículas o boletines',
  })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.courses.remove(user, id);
  }
}
