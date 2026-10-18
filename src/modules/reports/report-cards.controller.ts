import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiConflictResponse,
  ApiCookieAuth,
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
  REPORT_CARD_GENERATE_THROTTLE,
} from '../../common/constants/throttle';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { AuthUser } from '../../common/interfaces/auth-user.interface';
import { Paginated } from '../../common/dto/pagination.dto';
import {
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
@ApiCookieAuth('access_token')
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
