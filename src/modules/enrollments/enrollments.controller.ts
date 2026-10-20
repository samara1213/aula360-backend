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
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { AuthUser } from '../../common/interfaces/auth-user.interface';
import {
  CreateEnrollmentDto,
  EnrollmentPageDto,
  EnrollmentQueryDto,
  EnrollmentResponseDto,
  UpdateEnrollmentDto,
} from './dto/enrollment.dto';
import {
  ENROLLMENTS_PERMISSION,
  EnrollmentsService,
} from './enrollments.service';

const RULES =
  'El año lectivo del curso debe estar activo, el estudiante activo y su sede debe ser la del curso. Quien está limitado a sedes solo gestiona las matrículas de los cursos de esas sedes.';

@ApiTags('enrollments')
@ApiForbiddenResponse({ description: 'Sin permiso para esta acción' })
@Controller('enrollments')
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  @Get()
  @RequirePermission(ENROLLMENTS_PERMISSION, 'view')
  @ApiOperation({
    summary: 'Listar matrículas de la institución activa',
    description: 'Del estudiante solo se devuelven nombres y código.',
  })
  @ApiOkResponse({ type: EnrollmentPageDto })
  findAll(@CurrentUser() user: AuthUser, @Query() query: EnrollmentQueryDto) {
    return this.enrollments.findAll(user, query);
  }

  @Get(':id')
  @RequirePermission(ENROLLMENTS_PERMISSION, 'view')
  @ApiOperation({ summary: 'Ver una matrícula' })
  @ApiOkResponse({ type: EnrollmentResponseDto })
  @ApiNotFoundResponse({ description: 'Matrícula no encontrada' })
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<EnrollmentResponseDto> {
    return this.enrollments.findOne(user, id);
  }

  @Post()
  @RequirePermission(ENROLLMENTS_PERMISSION, 'create')
  @ApiOperation({
    summary: 'Matricular un estudiante en un curso',
    description: `El año de la matrícula es el del curso. ${RULES}`,
  })
  @ApiCreatedResponse({ type: EnrollmentResponseDto })
  @ApiBadRequestResponse({
    description: 'Año inactivo, estudiante inactivo, sin sede o de otra sede',
  })
  @ApiNotFoundResponse({ description: 'Curso o estudiante no encontrado' })
  @ApiConflictResponse({
    description: 'El estudiante ya tiene matrícula en ese año lectivo',
  })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateEnrollmentDto,
  ): Promise<EnrollmentResponseDto> {
    return this.enrollments.create(user, dto);
  }

  @Patch(':id')
  @RequirePermission(ENROLLMENTS_PERMISSION, 'update')
  @ApiOperation({
    summary: 'Cambiar estado, observaciones o curso de una matrícula',
    description: `No se borran: se retiran (DROPPED). Cambiar de curso (mismo año) o reintegrar exige lo mismo que matricular. ${RULES}`,
  })
  @ApiOkResponse({ type: EnrollmentResponseDto })
  @ApiBadRequestResponse({
    description: 'Curso de otro año u otra sede, año o estudiante inactivo',
  })
  @ApiNotFoundResponse({ description: 'Matrícula o curso no encontrado' })
  @ApiConflictResponse({ description: 'Cambio de estado no permitido' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEnrollmentDto,
  ): Promise<EnrollmentResponseDto> {
    return this.enrollments.update(user, id, dto);
  }
}
