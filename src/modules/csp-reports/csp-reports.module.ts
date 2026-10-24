import { Module } from '@nestjs/common';
import { CspReportsController } from './csp-reports.controller';
import { CspReportsService } from './csp-reports.service';

@Module({
  controllers: [CspReportsController],
  providers: [CspReportsService],
})
export class CspReportsModule {}
