import { ForbiddenException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import http from 'http';
import https from 'https';
import { FactJobData, QueueService } from '../queue/queue.service';
import { ChatMessageService } from './chat_message.service';
import { ChatSessionService } from './chat_session.service';
import { ChatSession } from './chat_session.entity';

interface ChatMessage {
  messageId: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface SummaryQueueMessage {
  messageId?: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  isNew: boolean;
}

interface RuntimeSession {
  userId: number;
  sessionId: string;
  messages: ChatMessage[];
}

interface PendingBuffer {
  userId: number;
  sessionId: string;
  messages: ChatMessage[];
  timer: ReturnType<typeof setTimeout> | null;
}

const FLUSH_THRESHOLD = 10; // Flush when buffer reaches 10 messages
const FLUSH_TIMEOUT_MS = 2 * 60 * 1000; // Flush after 2 minutes of inactivity

@Injectable()
export class ChatService implements OnModuleDestroy {
  private sessions = new Map<string, RuntimeSession>();
  private pendingBuffers = new Map<string, PendingBuffer>();

  constructor(
    private configService: ConfigService,
    private queueService: QueueService,
    private chatMessageService: ChatMessageService,
    private chatSessionService: ChatSessionService,
  ) {}

  onModuleDestroy() {
    // Flush all pending buffers on shutdown
    for (const [sessionId, buffer] of this.pendingBuffers) {
      if (buffer.timer) {
        clearTimeout(buffer.timer);
      }
      if (buffer.messages.length > 0) {
        this.doFlush(sessionId);
      }
    }
  }

  async listSessions(userId: number) {
    const defaultSession = await this.chatSessionService.getLatestSession(userId);
    return defaultSession ? [defaultSession] : [];
  }

  async createSession(userId: number, title?: string) {
    return this.chatSessionService.getOrCreateDefaultSession(userId, title);
  }

  async getSessionMessages(userId: number, sessionId: string) {
    const chatSession = await this.chatSessionService.getOrCreateDefaultSession(userId);
    if (sessionId !== chatSession.id) {
      throw new ForbiddenException('Only the default chat session is available');
    }

    const messages = await this.chatMessageService.getSessionMessages(userId, chatSession.id);
    return {
      sessionId: chatSession.id,
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        timestamp: message.createdAt.toISOString(),
      })),
    };
  }

  async deleteSession(userId: number, sessionId: string): Promise<void> {
    await this.chatSessionService.getOwnedSession(userId, sessionId);
    throw new ForbiddenException('Deleting the default chat session is disabled');
  }

  private getOrCreateRuntimeSession(userId: number, sessionId: string): RuntimeSession {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        userId,
        sessionId,
        messages: [],
      });
    }

    return this.sessions.get(sessionId)!;
  }

  async sendMessage(
    userId: number,
    message: string,
    sessionId?: string,
  ): Promise<{ reply: string; sessionId: string; title: string }> {
    let chatSession = await this.chatSessionService.getOrCreateDefaultSession(userId);
    if (sessionId && sessionId !== chatSession.id) {
      throw new ForbiddenException('Only the default chat session is available');
    }

    chatSession = await this.chatSessionService.maybeAssignTitle(chatSession, message);
    const session = this.getOrCreateRuntimeSession(userId, chatSession.id);

    // Store user message in DB
    const savedUserMessage = await this.chatMessageService.saveMessage(userId, chatSession.id, 'user', message);

    // Also keep in memory for batch
    session.messages.push({
      messageId: savedUserMessage.id,
      role: 'user',
      content: message,
      timestamp: savedUserMessage.createdAt,
    });

    // Call Dify API (blocking mode)
    const difyResponse = await this.callDify(userId, message, chatSession.difyConversationId);

    if (difyResponse.conversationId) {
      chatSession = await this.chatSessionService.updateConversationId(
        chatSession,
        difyResponse.conversationId,
      );
    }

    // Store assistant response in DB
    const savedAssistantMessage = await this.chatMessageService.saveMessage(
      userId,
      chatSession.id,
      'assistant',
      difyResponse.answer,
    );

    // Also keep in memory for batch
    session.messages.push({
      messageId: savedAssistantMessage.id,
      role: 'assistant',
      content: difyResponse.answer,
      timestamp: savedAssistantMessage.createdAt,
    });

    chatSession = await this.chatSessionService.touchSession(chatSession);

    // Add session messages to pending buffer instead of immediate enqueue
    this.bufferMessages(chatSession.id);

    return {
      reply: difyResponse.answer,
      sessionId: chatSession.id,
      title: chatSession.title,
    };
  }

  private bufferMessages(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.messages.length === 0) return;

    // Get or create pending buffer
    if (!this.pendingBuffers.has(sessionId)) {
      this.pendingBuffers.set(sessionId, {
        userId: session.userId,
        sessionId: session.sessionId,
        messages: [],
        timer: null,
      });
    }
    const buffer = this.pendingBuffers.get(sessionId)!;

    // Only append NEW session messages (those not yet in buffer)
    // Use a Set of timestamps to track what's already buffered
    const existingMessageIds = new Set(buffer.messages.map((message) => message.messageId));

    const newMsgs = session.messages.filter((message) => !existingMessageIds.has(message.messageId));

    buffer.messages.push(...newMsgs);
    session.messages = [];

    // Reset inactivity timer
    if (buffer.timer) {
      clearTimeout(buffer.timer);
    }

    // Check if threshold reached
    if (buffer.messages.length >= FLUSH_THRESHOLD) {
      this.doFlush(sessionId);
    } else {
      // Set/reset timer for 2 minutes
      buffer.timer = setTimeout(() => {
        this.doFlush(sessionId);
      }, FLUSH_TIMEOUT_MS);
    }
  }

  private async doFlush(sessionId: string) {
    const buffer = this.pendingBuffers.get(sessionId);
    if (!buffer) return;

    // Clear timer and take messages
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }
    const messages = [...buffer.messages];
    buffer.messages = [];

    if (messages.length === 0) return;

    const allMessages = await this.buildSummaryPayload(
      buffer.userId,
      buffer.sessionId,
      messages.map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
        messageId: m.messageId,
        isNew: true,
      })),
    );

    try {
      await this.enqueueFlushJobs(buffer.userId, buffer.sessionId, allMessages);
      console.log(`[Buffer] Flushed ${messages.length} messages for user ${buffer.userId}, session ${buffer.sessionId} (total with history: ${allMessages.length})`);
    } catch (error: any) {
      console.error('[Buffer] Failed to flush:', error?.message);
    }
  }

  private async callDify(
    userId: number,
    message: string,
    conversationId: string | null,
  ): Promise<{ answer: string; conversationId: string | null }> {
    return new Promise((resolve) => {
      const apiUrl = this.configService.get<string>('dify.apiUrl')!;
      const apiKey = this.configService.get<string>('dify.apiKey')!;
      const timeoutMs = this.configService.get<number>('dify.timeoutMs') || 60000;

      const urlObj = new URL(apiUrl);
      const isHttps = urlObj.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const payload: Record<string, any> = {
        inputs: {},
        query: message,
        user: `user_${userId}`,
        response_mode: 'streaming',
      };

      if (conversationId) {
        payload.conversation_id = conversationId;
      }

      const postData = JSON.stringify(payload);

      const options: http.RequestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: timeoutMs,
      };

      const fullResponse: string[] = [];
      let nextConversationId = conversationId;

      const req = httpModule.request(options, (res) => {
        res.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          const lines = text.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') continue;
              try {
                const parsed = JSON.parse(data);
                if (parsed.conversation_id) {
                  nextConversationId = parsed.conversation_id;
                }
                if (parsed.event === 'message' && parsed.answer) {
                  fullResponse.push(parsed.answer);
                }
              } catch (e) {
                // Ignore parse errors
              }
            }
          }
        });

        res.on('end', () => {
          resolve({
            answer: fullResponse.join('') || '抱歉，AI 服务暂时无响应。',
            conversationId: nextConversationId,
          });
        });

        res.on('error', (error: any) => {
          console.error('[Dify] Response error:', error?.message);
          resolve({ answer: '抱歉，AI 服务暂时不可用。', conversationId });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        console.error('[Dify] Request timeout');
        resolve({ answer: '抱歉，AI 服务响应超时。', conversationId });
      });

      req.on('error', (error: any) => {
        console.error('[Dify] Request error:', error?.message);
        resolve({ answer: '抱歉，AI 服务暂时不可用。', conversationId });
      });

      req.write(postData);
      req.end();
    });
  }

  // Flush any pending messages for a session (called on logout/disconnect if needed)
  async flushSession(sessionId: string): Promise<void> {
    // Flush the pending buffer
    await this.doFlush(sessionId);
    this.pendingBuffers.delete(sessionId);

    // Also flush any remaining session messages
    const session = this.sessions.get(sessionId);
    if (!session || session.messages.length === 0) return;

    const sessionMsgs: SummaryQueueMessage[] = session.messages.map(m => ({
      messageId: m.messageId,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
      isNew: true,
    }));
    session.messages = [];

    const messages = await this.buildSummaryPayload(session.userId, session.sessionId, sessionMsgs);
    await this.enqueueFlushJobs(session.userId, session.sessionId, messages);
  }

  private extractFactMessages(messages: SummaryQueueMessage[]): FactJobData['messages'] {
    return messages
      .filter((message) => message.isNew !== false)
      .filter((message) => message.role === 'user')
      .map((message) => ({
        messageId: message.messageId,
        role: 'user' as const,
        content: message.content,
        timestamp: message.timestamp,
      }))
      .filter((message) => String(message.content || '').trim());
  }

  private async enqueueFlushJobs(
    userId: number,
    sessionId: string | undefined,
    messages: SummaryQueueMessage[],
  ): Promise<void> {
    const summaryBatch = await this.queueService.enqueueSummaryBatch(userId, sessionId, messages);
    const factMessages = this.extractFactMessages(messages);

    if (!factMessages.length) {
      return;
    }

    try {
      await this.queueService.enqueueFactBatch(userId, summaryBatch.batchId, factMessages);
    } catch (error: any) {
      console.error('[Buffer] Failed to enqueue fact job:', error?.message);
    }
  }

  private async buildSummaryPayload(
    userId: number,
    chatSessionId: string,
    newMessages: SummaryQueueMessage[],
  ): Promise<SummaryQueueMessage[]> {
    if (newMessages.length >= 15) {
      return newMessages.slice(-15);
    }

    const dbMessages = await this.chatMessageService.getRecentMessages(userId, 15, chatSessionId);
    const historicalMessages: SummaryQueueMessage[] = dbMessages.map((m) => ({
      messageId: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.createdAt.toISOString(),
      isNew: false,
    })).reverse();

    // Always keep the current flush as the authoritative "new" segment.
    // DB timestamps can be normalized differently from in-memory timestamps,
    // so we prepend only the non-duplicate historical context we still need.
    const newMessageKeys = new Set(
      newMessages.map((message) => message.messageId ? `id:${message.messageId}` : `${message.role}:${message.content}`),
    );
    const historicalContext = historicalMessages.filter(
      (message) => !newMessageKeys.has(
        message.messageId ? `id:${message.messageId}` : `${message.role}:${message.content}`,
      ),
    );

    const historyLimit = Math.max(0, 15 - newMessages.length);
    return [
      ...historicalContext.slice(-historyLimit),
      ...newMessages,
    ].slice(-15);
  }
}
