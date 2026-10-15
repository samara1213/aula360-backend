import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/** Global: cualquier módulo inyecta StorageService sin importarlo. */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
