import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StorageService } from './storage.service';

/**
 * Global so any feature module can inject StorageService without an
 * explicit import. Bootstrap-only today (S17/C4): boot guarantees the
 * MinIO bucket exists. When UploadsService is migrated from local FS to
 * S3-compatible storage, it will consume StorageService.getClient().
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
