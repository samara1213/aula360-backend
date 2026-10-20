import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  PEOPLE_LIST_THROTTLE,
  REPORT_CARD_BATCH_THROTTLE,
  REPORT_CARD_GENERATE_THROTTLE,
} from '../../common/constants/throttle';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { AuthUser } from '../../common/interfaces/auth-user.interface';
import { Paginated } from '../../common/dto/pagination.dto';
import {
  BatchReportCardsDto,
  BatchReportCardsResultDto,
  GenerateReportCardDto,
  OwnReportCardDto,
  ReportCardDownloadDto,
  ReportCardPageDto,
  ReportCardQueryDto,
  ReportCardResponseDto,
} from './dto/report-card.dto';
import {
  REPORT_CARDS_PERMISSION,
  ReportCardsService,
} from './report-cards.service';

/** Boletines en PDF por estudiante y periodo (fase 10b). */
@ApiTags('report-cards')
@ApiForbiddenResponse({ description: 'Sin permiso' })
@Controller('report-cards')
export class ReportCardsController {
  constructor(private readonly reportCards: ReportCardsService) {}

  @Post()
  @RequirePermission(REPORT_CARDS_PERMISSION, 'create')
  @Throttle(REPORT_CARD_GENERATE_THROTTLE)
  @ApiOperation({
    summary: 'Generar o regenerar el boletín de un estudiante en un periodo',
    description:
      'Administrador de la sede del curso. Usa la plantilla activa de la institución (o la del sistema). Exige todas las definitivas salvo force; sin ninguna, 409. Regenerar reemplaza el PDF y lo deja vigente.',
  })
  @ApiCreatedResponse({ type: ReportCardResponseDto })
  @ApiNotFoundResponse({
    description:
      'Periodo o estudiante no encontrado, sin matrícula en el año del periodo o de otra sede',
  })
  @ApiConflictResponse({
    description:
      'Faltan definitivas (sin force), ninguna definitiva, o las notas o la plantilla cambiaron mientras se generaba',
  })
  @ApiServiceUnavailableResponse({ description: 'No se pudo imprimir el PDF' })
  @ApiBadGatewayResponse({ description: 'Fallo de Storage' })
  @ApiTooManyRequestsResponse({ description: 'Más de 10 por minuto' })
  generate(
    @CurrentUser() user: AuthUser,
    @Body() dto: GenerateReportCardDto,
  ): Promise<ReportCardResponseDto> {
    return this.reportCards.generate(user, dto);
  }

  @Post('batch')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(REPORT_CARDS_PERMISSION, 'create')
  @Throttle(REPORT_CARD_BATCH_THROTTLE)
  @ApiOperation({
    summary: 'Generar los boletines de un curso en un periodo',
    description:
      'Administrador de la sede del curso. Matriculados ENROLLED, SUSPENDED y GRADUATED (no los retirados), 60 como máximo, de a 2. Los que tienen definitivas faltantes se omiten (con force, solo los que no tienen ninguna); los errores de un estudiante no detienen a los demás. Una generación masiva a la vez por institución.',
  })
  @ApiOkResponse({ type: BatchReportCardsResultDto })
  @ApiNotFoundResponse({ description: 'Curso o periodo no encontrado' })
  @ApiBadRequestResponse({
    description: 'Periodo de otro año lectivo o más de 60 matriculados',
  })
  @ApiConflictResponse({
    description: 'Ya hay una generación masiva en curso en la institución',
  })
  @ApiBadGatewayResponse({ description: 'No se pudo leer el logo' })
  @ApiTooManyRequestsResponse({ description: 'Más de 3 por minuto' })
  generateBatch(
    @CurrentUser() user: AuthUser,
    @Body() dto: BatchReportCardsDto,
  ): Promise<BatchReportCardsResultDto> {
    return this.reportCards.generateBatch(user, dto);
  }

  @Get()
  @RequirePermission(REPORT_CARDS_PERMISSION, 'view')
  @Throttle(PEOPLE_LIST_THROTTLE)
  @ApiOperation({
    summary: 'Boletines generados',
    description:
      'Los de los cursos de las sedes que administra. El docente no los ve: traen todas las materias.',
  })
  @ApiOkResponse({ type: ReportCardPageDto })
  @ApiTooManyRequestsResponse({ description: 'Más de 60 por minuto' })
  findAll(
    @CurrentUser() user: AuthUser,
    @Query() query: ReportCardQueryDto,
  ): Promise<Paginated<ReportCardResponseDto>> {
    return this.reportCards.findAll(user, query);
  }

  @Get('mine')
  @RequirePermission(REPORT_CARDS_PERMISSION, 'view')
  @Throttle(PEOPLE_LIST_THROTTLE)
  @ApiOperation({ summary: 'Mis boletines (estudiante)' })
  @ApiOkResponse({ type: OwnReportCardDto, isArray: true })
  @ApiNotFoundResponse({ description: 'Sin perfil de estudiante' })
  mine(@CurrentUser() user: AuthUser): Promise<OwnReportCardDto[]> {
    return this.reportCards.mine(user);
  }

  @Get(':id/download')
  @RequirePermission(REPORT_CARDS_PERMISSION, 'view')
  @Throttle(PEOPLE_LIST_THROTTLE)
  @ApiOperation({
    summary: 'URL firmada del PDF',
    description:
      'El propio estudiante o el administrador de la sede del curso. La URL vence en 120 segundos.',
  })
  @ApiOkResponse({ type: ReportCardDownloadDto })
  @ApiNotFoundResponse({ description: 'Boletín no encontrado' })
  @ApiTooManyRequestsResponse({ description: 'Más de 60 por minuto' })
  download(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ReportCardDownloadDto> {
    return this.reportCards.download(user, id);
  }
}
