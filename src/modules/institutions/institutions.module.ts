import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SecurityModule } from '../security/security.module';
import {
  CampusesController,
  InstitutionCampusesController,
} from './campuses.controller';
import { CampusesService } from './campuses.service';
import { CampusEntity } from './entities/campus.entity';
import { InstitutionEntity } from './entities/institution.entity';
import { InstitutionsController } from './institutions.controller';
import { InstitutionsService } from './institutions.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([InstitutionEntity, CampusEntity]),
    SecurityModule,
  ],
  controllers: [
    InstitutionsController,
    CampusesController,
    InstitutionCampusesController,
  ],
  providers: [InstitutionsService, CampusesService],
  exports: [InstitutionsService, CampusesService],
})
export class InstitutionsModule {}
