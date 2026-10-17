import { Module } from '@nestjs/common';
import { AcademicModule } from '../academic/academic.module';
import { SecurityModule } from '../security/security.module';
import { EnrollmentsController } from './enrollments.controller';
import { EnrollmentsService } from './enrollments.service';

/** Matrículas de estudiantes en cursos (fase 8b). */
@Module({
  imports: [SecurityModule, AcademicModule],
  controllers: [EnrollmentsController],
  providers: [EnrollmentsService],
})
export class EnrollmentsModule {}
