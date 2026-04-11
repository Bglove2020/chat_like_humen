import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ImpressionsService } from './impressions.service';
import { ImpressionsController } from './impressions.controller';
import { ImpressionEdge } from './impression-edge.entity';
import { ImpressionMessageLink } from './impression-message-link.entity';
import { ChatMessage } from '../chat/chat_message.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ImpressionEdge, ImpressionMessageLink, ChatMessage])],
  providers: [ImpressionsService],
  controllers: [ImpressionsController],
  exports: [ImpressionsService],
})
export class ImpressionsModule {}
