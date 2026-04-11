import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { QueueModule } from '../queue/queue.module';
import { ChatMessage } from './chat_message.entity';
import { ChatMessageService } from './chat_message.service';
import { ChatSession } from './chat_session.entity';
import { ChatSessionService } from './chat_session.service';
import { ChatContextService } from './chat-context.service';
import { ImpressionsModule } from '../impressions/impressions.module';

@Module({
  imports: [QueueModule, ImpressionsModule, TypeOrmModule.forFeature([ChatMessage, ChatSession])],
  providers: [ChatService, ChatMessageService, ChatSessionService, ChatContextService],
  controllers: [ChatController],
  exports: [ChatMessageService, ChatSessionService],
})
export class ChatModule {}
