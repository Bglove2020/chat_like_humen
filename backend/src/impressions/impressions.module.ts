import { Module } from '@nestjs/common';
import { ImpressionsService } from './impressions.service';
import { ImpressionsController } from './impressions.controller';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [MemoryModule],
  providers: [ImpressionsService],
  controllers: [ImpressionsController],
  exports: [ImpressionsService],
})
export class ImpressionsModule {}
