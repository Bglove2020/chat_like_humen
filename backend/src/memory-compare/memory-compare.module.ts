import { Module } from '@nestjs/common';
import { ImpressionsModule } from '../impressions/impressions.module';
import { UsersModule } from '../users/users.module';
import { Mem0RestService } from './mem0-rest.service';
import { MemoryCompareController } from './memory-compare.controller';
import { MemoryCompareService } from './memory-compare.service';

@Module({
  imports: [ImpressionsModule, UsersModule],
  providers: [Mem0RestService, MemoryCompareService],
  controllers: [MemoryCompareController],
})
export class MemoryCompareModule {}
