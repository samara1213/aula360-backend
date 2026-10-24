import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { fetchOnlyMiddleware } from '../../common/middleware/fetch-only.middleware';
import { EvaluationsModule } from '../evaluations/evaluations.module';
import { SecurityModule } from '../security/security.module';
import { PdfRendererService } from './pdf-renderer.service';
import { PerformanceLevelsController } from './performance-levels.controller';
import { PerformanceLevelsService } from './performance-levels.service';
import { ReportCardsController } from './report-cards.controller';
import { ReportCardsService } from './report-cards.service';
import { ReportTemplatesController } from './report-templates.controller';
import { ReportTemplatesService } from './report-templates.service';

/** Niveles de desempeño, plantillas y boletines en PDF (fase 10). */
@Module({
  imports: [SecurityModule, EvaluationsModule],
  controllers: [
    PerformanceLevelsController,
    ReportTemplatesController,
    ReportCardsController,
  ],
  providers: [
    PdfRendererService,
    PerformanceLevelsService,
    ReportTemplatesService,
    ReportCardsService,
  ],
})
export class ReportsModule implements NestModule {
  // Las vistas previas lanzan Chromium: solo con fetch desde la aplicación, y
  // el rechazo ocurre antes del límite de peticiones (B1 de la 3g-1).
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(fetchOnlyMiddleware()).forRoutes({
      path: 'institutions/:institutionId/report-card-templates/:id/preview',
      method: RequestMethod.GET,
    });
  }
}
