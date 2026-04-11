import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface Mem0JobMessage {
  messageId?: number;
  role: string;
  content: string;
  timestamp: string;
  isNew?: boolean;
}

export interface Mem0JobData {
  userId: number;
  sessionId?: string;
  date: string;
  batchId: string;
  messages: Mem0JobMessage[];
}

export interface Mem0Memory {
  id?: string;
  memory: string;
  score?: number | null;
  metadata: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

@Injectable()
export class Mem0Service {
  private configurePromise: Promise<void> | null = null;

  constructor(private configService: ConfigService) {}

  isEnabled(): boolean {
    return this.configService.get<boolean>('mem0.enabled') === true;
  }

  private getApiUrl(): string {
    return String(this.configService.get<string>('mem0.apiUrl') || 'http://127.0.0.1:8000').replace(/\/+$/, '');
  }

  private getHeaders(): Record<string, string> {
    const apiKey = this.configService.get<string>('mem0.apiKey');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (apiKey) {
      headers['X-API-Key'] = apiKey;
    }

    return headers;
  }

  private parseQdrantConnection(): { host: string; port: number } {
    const rawUrl = String(this.configService.get<string>('mem0.qdrantUrl') || 'http://localhost:6333');
    const url = new URL(rawUrl);
    return {
      host: url.hostname,
      port: Number.parseInt(url.port || (url.protocol === 'https:' ? '443' : '6333'), 10),
    };
  }

  private buildProviderConfig(prefix: 'llm' | 'embedder'): Record<string, unknown> {
    const apiKey = this.configService.get<string>(`mem0.${prefix}ApiKey`);
    const model = this.configService.get<string>(`mem0.${prefix}Model`);
    const baseUrl = this.configService.get<string>(`mem0.${prefix}BaseUrl`);
    const config: Record<string, unknown> = {};

    if (apiKey) {
      config.api_key = apiKey;
    }

    if (model) {
      config.model = model;
    }

    if (baseUrl) {
      config.base_url = baseUrl;
    }

    if (prefix === 'llm') {
      config.temperature = 0.2;
    }

    return config;
  }

  private async configureIfNeeded(): Promise<void> {
    if (!this.configService.get<boolean>('mem0.autoConfigure')) {
      return;
    }

    if (!this.configurePromise) {
      this.configurePromise = this.configureMemoryServer().catch((error) => {
        this.configurePromise = null;
        throw error;
      });
    }

    await this.configurePromise;
  }

  private async configureMemoryServer(): Promise<void> {
    const qdrant = this.parseQdrantConnection();
    const config = {
      version: 'v1.1',
      vector_store: {
        provider: 'qdrant',
        config: {
          host: qdrant.host,
          port: qdrant.port,
          collection_name: this.configService.get<string>('mem0.qdrantCollection') || 'mem0_user_memories',
        },
      },
      llm: {
        provider: this.configService.get<string>('mem0.llmProvider') || 'openai',
        config: this.buildProviderConfig('llm'),
      },
      embedder: {
        provider: this.configService.get<string>('mem0.embedderProvider') || 'openai',
        config: this.buildProviderConfig('embedder'),
      },
      history_db_path: this.configService.get<string>('mem0.historyDbPath') || '/app/history/history.db',
    };

    await axios.post(`${this.getApiUrl()}/configure`, config, {
      headers: this.getHeaders(),
      timeout: 30000,
    });

    console.log(
      `[Mem0] Configured REST server: qdrant=${qdrant.host}:${qdrant.port}, ` +
      `collection=${config.vector_store.config.collection_name}, graph=false`,
    );
  }

  private normalizeRole(role: string): 'user' | 'assistant' {
    return role === 'assistant' ? 'assistant' : 'user';
  }

  private normalizeMemories(payload: unknown): Mem0Memory[] {
    const raw = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as any)?.results)
        ? (payload as any).results
        : Array.isArray((payload as any)?.memories)
          ? (payload as any).memories
          : [];

    return raw.map((item: any) => ({
      id: item.id ? String(item.id) : undefined,
      memory: String(item.memory || item.text || item.content || ''),
      score: Number.isFinite(Number(item.score)) ? Number(item.score) : null,
      metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : {},
      createdAt: item.created_at || item.createdAt || undefined,
      updatedAt: item.updated_at || item.updatedAt || undefined,
    })).filter((item) => item.memory);
  }

  async addMessages(data: Mem0JobData): Promise<void> {
    if (!this.isEnabled()) {
      console.log(`[Mem0] Skip batch ${data.batchId}: MEM0_ENABLED is false`);
      return;
    }

    const newMessages = data.messages.filter((message) => message.isNew !== false);
    if (!newMessages.length) {
      console.log(`[Mem0] Skip batch ${data.batchId}: no new messages`);
      return;
    }

    await this.configureIfNeeded();

    const messageIds = newMessages
      .map((message) => message.messageId)
      .filter((messageId): messageId is number => Number.isInteger(messageId));

    await axios.post(
      `${this.getApiUrl()}/memories`,
      {
        messages: newMessages.map((message) => ({
          role: this.normalizeRole(message.role),
          content: String(message.content || ''),
        })),
        user_id: String(data.userId),
        metadata: {
          userId: data.userId,
          sessionId: data.sessionId || null,
          batchId: data.batchId,
          messageIds,
          memoryDate: data.date,
        },
      },
      {
        headers: this.getHeaders(),
        timeout: 120000,
      },
    );

    console.log(
      `[Mem0] Added batch ${data.batchId}: user=${data.userId}, messages=${newMessages.length}, messageIds=${messageIds.join(',')}`,
    );
  }

  async search(userId: number, query: string, limit = 6): Promise<Mem0Memory[]> {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) {
      return [];
    }

    await this.configureIfNeeded();

    const response = await axios.post(
      `${this.getApiUrl()}/search`,
      {
        query: normalizedQuery,
        user_id: String(userId),
        limit,
      },
      {
        headers: this.getHeaders(),
        timeout: 30000,
      },
    );

    return this.normalizeMemories(response.data);
  }

  async getMemories(userId: number): Promise<Mem0Memory[]> {
    await this.configureIfNeeded();

    const response = await axios.get(
      `${this.getApiUrl()}/memories`,
      {
        headers: this.getHeaders(),
        params: {
          user_id: String(userId),
        },
        timeout: 30000,
      },
    );

    return this.normalizeMemories(response.data);
  }

  async deleteUserMemories(userId: number): Promise<void> {
    await this.configureIfNeeded();

    await axios.delete(
      `${this.getApiUrl()}/memories`,
      {
        headers: this.getHeaders(),
        params: {
          user_id: String(userId),
        },
        data: {
          user_id: String(userId),
        },
        timeout: 30000,
      },
    );
  }
}
