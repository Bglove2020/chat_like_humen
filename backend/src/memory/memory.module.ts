import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatMessage } from '../chat/chat_message.entity';
import { MemoryController } from './memory.controller';
import { MemoryLine } from './memory-line.entity';
import { MemoryPoint } from './memory-point.entity';
import { MemoryService } from './memory.service';
import { PointMessageLink } from './point-message-link.entity';
import { PointRevisionLog } from './point-revision-log.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MemoryLine,
      MemoryPoint,
      PointRevisionLog,
      PointMessageLink,
      ChatMessage,
    ]),
  ],
  providers: [MemoryService],
  controllers: [MemoryController],
  exports: [MemoryService],
})
export class MemoryModule {}
