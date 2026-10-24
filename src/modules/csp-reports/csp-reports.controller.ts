import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiNoContentResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CSP_REPORT_THROTTLE } from '../../common/constants/throttle';
import { Public } from '../../common/decorators/public.decorator';
import {
  CSP_REPORT_MAX_BYTES,
  CspReportsService,
  LEGACY_REPORT_TYPE,
  MAX_LOG_LINES_PER_MINUTE,
  MAX_REPORTS_PER_REQUEST,
  REPORTING_TYPE,
} from './csp-reports.service';

/** Informes de la CSP del frontend (cabeceras Reporting-Endpoints y report-uri). */
@ApiTags('csp-reports')
@Controller('csp-reports')
export class CspReportsController {
  constructor(private readonly reports: CspReportsService) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(CSP_REPORT_THROTTLE)
  @ApiOperation({
    summary: 'Recibir violaciones de la CSP que informa el navegador',
    description: `Sin sesión (lo llama el navegador). Acepta ${REPORTING_TYPE} (Reporting API) y ${LEGACY_REPORT_TYPE} (report-uri), hasta ${String(CSP_REPORT_MAX_BYTES / 1024)} KB y ${String(MAX_REPORTS_PER_REQUEST)} informes por petición. Solo se registra en el log la directiva, el origen de lo bloqueado y del script que la causó, la ruta de la página y, en Trusted Types, el punto bloqueado; nunca la consulta, el contenido ni el cuerpo completo (máximo ${String(MAX_LOG_LINES_PER_MINUTE)} líneas por minuto en el proceso). 204 si se acepta.`,
  })
  @ApiConsumes(REPORTING_TYPE, LEGACY_REPORT_TYPE)
  @ApiBody({
    description:
      'Informes del navegador (formato de la Reporting API o de report-uri)',
    schema: { type: 'object' },
  })
  @ApiNoContentResponse({ description: 'Recibido' })
  @ApiUnsupportedMediaTypeResponse({ description: 'Otro tipo de contenido' })
  @ApiPayloadTooLargeResponse({ description: 'Cuerpo de más de 64 KB' })
  receive(@Req() req: Request): void {
    const type = req.is([REPORTING_TYPE, LEGACY_REPORT_TYPE]);
    if (type !== REPORTING_TYPE && type !== LEGACY_REPORT_TYPE) {
      throw new UnsupportedMediaTypeException('Tipo de contenido no admitido');
    }
    this.reports.record(type, req.body);
  }
}
