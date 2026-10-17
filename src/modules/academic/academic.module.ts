import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module';
import {
  AcademicYearsController,
  PeriodsController,
} from './academic-years.controller';
import { AcademicYearsService } from './academic-years.service';
import { GradesController, SubjectsController } from './catalog.controller';
import { GradesService, SubjectsService } from './catalog.service';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';
import { PeriodsService } from './periods.service';

/** Años lectivos, periodos, grados, materias y cursos (fase 8a). */
@Module({
  imports: [SecurityModule],
  controllers: [
    AcademicYearsController,
    PeriodsController,
    GradesController,
    SubjectsController,
    CoursesController,
  ],
  providers: [
    AcademicYearsService,
    PeriodsService,
    GradesService,
    SubjectsService,
    CoursesService,
  ],
  exports: [CoursesService],
})
export class AcademicModule {}
