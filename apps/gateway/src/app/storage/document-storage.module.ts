import { Module } from '@nestjs/common';
import { DocumentStorageService } from './document-storage.service';

@Module({
  providers: [DocumentStorageService],
  exports: [DocumentStorageService],
})
export class DocumentStorageModule {}
