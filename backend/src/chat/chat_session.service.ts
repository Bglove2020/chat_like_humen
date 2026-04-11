import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChatSession } from './chat_session.entity';

const DEFAULT_SESSION_TITLE = 'New Chat';
const MAX_SESSION_TITLE_LENGTH = 120;

@Injectable()
export class ChatSessionService {
  constructor(
    @InjectRepository(ChatSession)
    private chatSessionRepository: Repository<ChatSession>,
  ) {}

  async createSession(userId: number, title?: string): Promise<ChatSession> {
    const session = this.chatSessionRepository.create({
      userId,
      title: this.normalizeTitle(title),
      difyConversationId: null,
    });
    return this.chatSessionRepository.save(session);
  }

  async listSessions(userId: number): Promise<ChatSession[]> {
    return this.chatSessionRepository.find({
      where: { userId },
      order: { updatedAt: 'DESC', createdAt: 'DESC' },
    });
  }

  async getOrCreateDefaultSession(userId: number, title?: string): Promise<ChatSession> {
    const existing = await this.getLatestSession(userId);
    if (existing) {
      return existing;
    }

    return this.createSession(userId, title);
  }

  async getLatestSession(userId: number): Promise<ChatSession | null> {
    return this.chatSessionRepository.findOne({
      where: { userId },
      order: { updatedAt: 'DESC', createdAt: 'DESC' },
    });
  }

  async getOwnedSession(userId: number, sessionId: string): Promise<ChatSession> {
    const session = await this.chatSessionRepository.findOne({
      where: { id: sessionId, userId },
    });

    if (!session) {
      throw new NotFoundException('Chat session not found');
    }

    return session;
  }

  async maybeAssignTitle(session: ChatSession, seedText: string): Promise<ChatSession> {
    if (session.title && session.title !== DEFAULT_SESSION_TITLE) {
      return session;
    }

    const nextTitle = this.normalizeTitle(seedText);
    if (nextTitle === session.title) {
      return session;
    }

    session.title = nextTitle;
    return this.chatSessionRepository.save(session);
  }

  async updateConversationId(session: ChatSession, difyConversationId: string | null): Promise<ChatSession> {
    if (session.difyConversationId === difyConversationId) {
      return session;
    }

    session.difyConversationId = difyConversationId;
    return this.chatSessionRepository.save(session);
  }

  async touchSession(session: ChatSession): Promise<ChatSession> {
    session.updatedAt = new Date();
    return this.chatSessionRepository.save(session);
  }

  async deleteSession(userId: number, sessionId: string): Promise<void> {
    await this.chatSessionRepository.delete({ id: sessionId, userId });
  }

  private normalizeTitle(raw?: string): string {
    const text = (raw || '').trim();
    if (!text) {
      return DEFAULT_SESSION_TITLE;
    }

    return text.slice(0, MAX_SESSION_TITLE_LENGTH);
  }
}
