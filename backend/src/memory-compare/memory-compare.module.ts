import { Module } from '@nestjs/common';
import { ImpressionsModule } from '../impressions/impressions.module';
import { Mem0RestService } from './mem0-rest.service';
import { MemoryCompareController } from './memory-compare.controller';
import { MemoryCompareService } from './memory-compare.service';

@Module({
  imports: [ImpressionsModule],
  providers: [Mem0RestService, MemoryCompareService],
  controllers: [MemoryCompareController],
})
export class MemoryCompareModule {}
