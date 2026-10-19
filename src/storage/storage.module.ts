import { Global, Module } from '@nestjs/common';
import { StorageDeletionsService } from './storage-deletions.service';
import { StorageService } from './storage.service';

/**
 * Global: cualquier módulo inyecta StorageService y StorageDeletionsService
 * sin importarlo.
 */
@Global()
@Module({
  providers: [StorageService, StorageDeletionsService],
  exports: [StorageService, StorageDeletionsService],
})
export class StorageModule {}
