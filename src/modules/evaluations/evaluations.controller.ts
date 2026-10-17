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
import type { AuthUser } from '../../common/interfaces/auth-user.interface';
import {
  CreateEvaluationDto,
  EvaluationPageDto,
  EvaluationQueryDto,
  EvaluationResponseDto,
  UpdateEvaluationDto,
} from './dto/evaluation.dto';
import {
  EVALUATIONS_PERMISSION,
  EvaluationsService,
} from './evaluations.service';

const RULES =
  'El docente actúa sobre su propia carga activa y mientras el periodo no haya terminado; un administrador, en los cursos de sus sedes. La suma de porcentajes por materia, curso y periodo no supera 100.';

@ApiTags('evaluations')
@ApiCookieAuth('access_token')
@ApiForbiddenResponse({
  description: 'Sin permiso, o periodo terminado (solo un administrador)',
})
@Controller('evaluations')
export class EvaluationsController {
  constructor(private readonly evaluations: EvaluationsService) {}

  @Get()
  @RequirePermission(EVALUATIONS_PERMISSION, 'view')
  @ApiOperation({
    summary: 'Listar evaluaciones',
    description:
      'El docente ve las de su carga (también la terminada); un administrador, las de los cursos de sus sedes.',
  })
  @ApiOkResponse({ type: EvaluationPageDto })
  findAll(@CurrentUser() user: AuthUser, @Query() query: EvaluationQueryDto) {
    return this.evaluations.findAll(user, query);
  }

  @Get(':id')
  @RequirePermission(EVALUATIONS_PERMISSION, 'view')
  @ApiOperation({ summary: 'Ver una evaluación (con la suma de porcentajes)' })
  @ApiOkResponse({ type: EvaluationResponseDto })
  @ApiNotFoundResponse({ description: 'Evaluación no encontrada' })
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<EvaluationResponseDto> {
    return this.evaluations.findOne(user, id);
  }

  @Post()
  @RequirePermission(EVALUATIONS_PERMISSION, 'create')
  @ApiOperation({ summary: 'Crear una evaluación', description: RULES })
  @ApiCreatedResponse({ type: EvaluationResponseDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos, fecha fuera del periodo o periodo de otro año',
  })
  @ApiNotFoundResponse({
    description: 'Carga académica o periodo no encontrado',
  })
  @ApiConflictResponse({
    description: 'Carga inactiva o la suma de porcentajes superaría 100',
  })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateEvaluationDto,
  ): Promise<EvaluationResponseDto> {
    return this.evaluations.create(user, dto);
  }

  @Patch(':id')
  @RequirePermission(EVALUATIONS_PERMISSION, 'update')
  @ApiOperation({
    summary: 'Editar título, porcentaje o fecha',
    description: `El periodo y la carga no cambian. ${RULES}`,
  })
  @ApiOkResponse({ type: EvaluationResponseDto })
  @ApiBadRequestResponse({
    description: 'Datos inválidos o fecha fuera del periodo',
  })
  @ApiNotFoundResponse({ description: 'Evaluación no encontrada' })
  @ApiConflictResponse({
    description: 'Carga inactiva o la suma de porcentajes superaría 100',
  })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEvaluationDto,
  ): Promise<EvaluationResponseDto> {
    return this.evaluations.update(user, id, dto);
  }

  @Delete(':id')
  @RequirePermission(EVALUATIONS_PERMISSION, 'delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Borrar una evaluación sin notas',
    description: RULES,
  })
  @ApiNoContentResponse({ description: 'Evaluación borrada' })
  @ApiNotFoundResponse({ description: 'Evaluación no encontrada' })
  @ApiConflictResponse({ description: 'Tiene notas o la carga está inactiva' })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.evaluations.remove(user, id);
  }
}
