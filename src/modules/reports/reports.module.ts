import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module';
import { PdfRendererService } from './pdf-renderer.service';
import { PerformanceLevelsController } from './performance-levels.controller';
import { PerformanceLevelsService } from './performance-levels.service';
import { ReportTemplatesController } from './report-templates.controller';
import { ReportTemplatesService } from './report-templates.service';

/** Niveles de desempeño, plantillas y boletines en PDF (fase 10). */
@Module({
  imports: [SecurityModule],
  controllers: [PerformanceLevelsController, ReportTemplatesController],
  providers: [
    PdfRendererService,
    PerformanceLevelsService,
    ReportTemplatesService,
  ],
})
export class ReportsModule {}
