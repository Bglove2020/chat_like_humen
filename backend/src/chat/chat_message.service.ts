import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { ChatMessage } from './chat_message.entity';

@Injectable()
export class ChatMessageService {
  constructor(
    @InjectRepository(ChatMessage)
    private chatMessageRepository: Repository<ChatMessage>,
  ) {}

  async saveMessage(
    userId: number,
    chatSessionId: string | null,
    role: 'user' | 'assistant',
    content: string,
  ): Promise<ChatMessage> {
    const message = this.chatMessageRepository.create({
      userId,
      chatSessionId,
      role,
      content,
    });
    return this.chatMessageRepository.save(message);
  }

  async getRecentMessages(
    userId: number,
    limit: number = 15,
    chatSessionId?: string,
  ): Promise<ChatMessage[]> {
    const oneDayAgo = new Date();
    oneDayAgo.setHours(oneDayAgo.getHours() - 24);

    // Use DESC to get the MOST RECENT messages (newest first)
    return this.chatMessageRepository.find({
      where: {
        userId,
        createdAt: MoreThan(oneDayAgo),
        ...(chatSessionId ? { chatSessionId } : {}),
      },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async getLatestMessages(userId: number, limit: number = 20): Promise<ChatMessage[]> {
    return this.chatMessageRepository.find({
      where: { userId },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: limit,
    });
  }

  async getTodayMessages(userId: number, chatSessionId?: string): Promise<ChatMessage[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return this.chatMessageRepository.find({
      where: {
        userId,
        createdAt: MoreThan(today),
        ...(chatSessionId ? { chatSessionId } : {}),
      },
      order: { createdAt: 'ASC' },
    });
  }

  async getSessionMessages(userId: number, chatSessionId: string): Promise<ChatMessage[]> {
    return this.chatMessageRepository.find({
      where: {
        userId,
        chatSessionId,
      },
      order: { createdAt: 'ASC' },
    });
  }

  async deleteSessionMessages(userId: number, chatSessionId: string): Promise<void> {
    await this.chatMessageRepository.delete({
      userId,
      chatSessionId,
    });
  }
}
