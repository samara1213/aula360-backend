import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module';
import { EvaluationAccessService } from './evaluation-access.service';
import { EvaluationsController } from './evaluations.controller';
import { EvaluationsService } from './evaluations.service';

/** Evaluaciones (fase 9a); notas y promedios (fase 9b). */
@Module({
  imports: [SecurityModule],
  controllers: [EvaluationsController],
  providers: [EvaluationAccessService, EvaluationsService],
})
export class EvaluationsModule {}
