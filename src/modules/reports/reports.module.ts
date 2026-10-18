import { Module } from '@nestjs/common';
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
export class ReportsModule {}
