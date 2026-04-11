import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface Mem0SearchResult {
  id?: string;
  memory: string;
  score: number | null;
  metadata: Record<string, unknown>;
}

@Injectable()
export class Mem0RestService {
  private configurePromise: Promise<void> | null = null;

  constructor(private configService: ConfigService) {}

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
    await axios.post(
      `${this.getApiUrl()}/configure`,
      {
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
      },
      {
        headers: this.getHeaders(),
        timeout: 30000,
      },
    );
  }

  private normalizeSearchResults(payload: unknown): Mem0SearchResult[] {
    const rawResults = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as any)?.results)
        ? (payload as any).results
        : Array.isArray((payload as any)?.memories)
          ? (payload as any).memories
          : [];

    return rawResults.map((item: any) => ({
      id: item.id ? String(item.id) : undefined,
      memory: String(item.memory || item.text || item.content || ''),
      score: Number.isFinite(Number(item.score)) ? Number(item.score) : null,
      metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : {},
    })).filter((item) => item.memory);
  }

  async search(userId: number, query: string, limit: number): Promise<Mem0SearchResult[]> {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) {
      return [];
    }

    try {
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

      return this.normalizeSearchResults(response.data);
    } catch (error: any) {
      console.error('[Mem0] Search error:', error?.message);
      return [];
    }
  }
}
