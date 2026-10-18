import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  StreamableFile,
  UploadedFile,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SENSITIVE_ACTION_THROTTLE } from '../../common/constants/throttle';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SuperAdminOnly } from '../../common/decorators/require-permission.decorator';
import type { AuthUser } from '../../common/interfaces/auth-user.interface';
import {
  CreateReportTemplateDto,
  ReportTemplateResponseDto,
} from './dto/report-template.dto';
import { ReportTemplatesService } from './report-templates.service';
import { TemplateFilePipe, TemplateUpload } from './template-upload';

const pdf = (buffer: Buffer) =>
  new StreamableFile(buffer, {
    type: 'application/pdf',
    disposition: 'inline; filename="vista-previa.pdf"',
  });

/**
 * Plantillas HTML (Handlebars) del boletín de una institución. Solo el
 * SUPER_ADMIN: el HTML se procesa en el servidor (con Chromium endurecido).
 */
@ApiTags('report-card-templates')
@ApiCookieAuth('access_token')
@ApiForbiddenResponse({ description: 'Solo SUPER_ADMIN' })
@ApiNotFoundResponse({ description: 'Institución o plantilla no encontrada' })
@ApiTooManyRequestsResponse({
  description: 'Subidas y vistas previas: 10 por minuto (por usuario)',
})
@SuperAdminOnly()
@Controller('institutions/:institutionId/report-card-templates')
export class ReportTemplatesController {
  constructor(private readonly templates: ReportTemplatesService) {}

  @Get()
  @ApiOperation({ summary: 'Listar las plantillas de la institución' })
  @ApiOkResponse({ type: [ReportTemplateResponseDto] })
  list(
    @Param('institutionId', ParseUUIDPipe) institutionId: string,
  ): Promise<ReportTemplateResponseDto[]> {
    return this.templates.list(institutionId);
  }

  @Post()
  @Throttle(SENSITIVE_ACTION_THROTTLE)
  @TemplateUpload()
  @ApiOperation({
    summary: 'Subir una plantilla',
    description:
      'HTML con variables Handlebars (contrato v1). Sin {{{ }}}, {{& }} ni parciales; solo los helpers score, date, eq y levelClass. Queda inactiva hasta activarla.',
  })
  @ApiCreatedResponse({ type: ReportTemplateResponseDto })
  @ApiConflictResponse({ description: 'Ya existe una plantilla igual' })
  create(
    @CurrentUser() user: AuthUser,
    @Param('institutionId', ParseUUIDPipe) institutionId: string,
    @Body() dto: CreateReportTemplateDto,
    @UploadedFile(TemplateFilePipe) source: string,
  ): Promise<ReportTemplateResponseDto> {
    return this.templates.create(user, institutionId, dto, source);
  }

  @Get('system/preview')
  @Throttle(SENSITIVE_ACTION_THROTTLE)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Vista previa de la plantilla del sistema',
    description:
      'Con datos de ejemplo y el nombre, logo, escala y niveles de la institución.',
  })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ description: 'PDF' })
  async previewSystem(
    @Param('institutionId', ParseUUIDPipe) institutionId: string,
  ): Promise<StreamableFile> {
    return pdf(await this.templates.preview(institutionId, null));
  }

  @Get(':id/preview')
  @Throttle(SENSITIVE_ACTION_THROTTLE)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Vista previa de una plantilla',
    description:
      'Con datos de ejemplo (nunca de un estudiante real) y el nombre, logo, escala y niveles de la institución.',
  })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ description: 'PDF' })
  async preview(
    @Param('institutionId', ParseUUIDPipe) institutionId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StreamableFile> {
    return pdf(await this.templates.preview(institutionId, id));
  }

  @Patch(':id/activate')
  @ApiOperation({
    summary: 'Activar la plantilla',
    description: 'Desactiva la que estuviera activa: una por institución.',
  })
  @ApiOkResponse({ type: ReportTemplateResponseDto })
  activate(
    @CurrentUser() user: AuthUser,
    @Param('institutionId', ParseUUIDPipe) institutionId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ReportTemplateResponseDto> {
    return this.templates.activate(user, institutionId, id);
  }

  @Patch(':id/deactivate')
  @ApiOperation({
    summary: 'Desactivar la plantilla',
    description: 'La institución vuelve a la plantilla del sistema.',
  })
  @ApiOkResponse({ type: ReportTemplateResponseDto })
  deactivate(
    @CurrentUser() user: AuthUser,
    @Param('institutionId', ParseUUIDPipe) institutionId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ReportTemplateResponseDto> {
    return this.templates.deactivate(user, institutionId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Borrar una plantilla que ningún boletín usó' })
  @ApiNoContentResponse({ description: 'Plantilla borrada' })
  @ApiConflictResponse({ description: 'Ya se usó en boletines' })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('institutionId', ParseUUIDPipe) institutionId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.templates.remove(user, institutionId, id);
  }
}
