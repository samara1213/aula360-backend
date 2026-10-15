import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserInstitutionRoleEntity } from '../security/entities/user-institution-role.entity';
import { CampusesController } from './campuses.controller';
import { CampusesService } from './campuses.service';
import { CampusEntity } from './entities/campus.entity';
import { InstitutionEntity } from './entities/institution.entity';
import { InstitutionsController } from './institutions.controller';
import { InstitutionsService } from './institutions.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      InstitutionEntity,
      CampusEntity,
      UserInstitutionRoleEntity,
    ]),
  ],
  controllers: [InstitutionsController, CampusesController],
  providers: [InstitutionsService, CampusesService],
  exports: [InstitutionsService, CampusesService],
})
export class InstitutionsModule {}
