import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import { In, Repository } from 'typeorm';
import { ImpressionEdge } from './impression-edge.entity';
import { ImpressionMessageLink } from './impression-message-link.entity';
import { ChatMessage } from '../chat/chat_message.entity';

export interface SearchResult {
  content: string;
  score: number;
}

export interface ImpressionRecord {
  id: string;
  scene: string;
  points: string[];
  entities: string[];
  retrievalText: string;
  content: string;
  score: number;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
  memoryDate: string;
  date: string;
  salienceScore: number;
  lastActivatedAt: string;
  originType: string;
  sourceImpressionId: string | null;
  rootImpressionId: string | null;
}

export interface ImpressionSourceRecord {
  relationType: string;
  batchId: string;
  createdAt: string;
  source: ImpressionRecord | null;
}

export interface ImpressionMessageRecord {
  batchId: string;
  linkedAt: string;
  message: {
    id: number;
    role: 'user' | 'assistant';
    content: string;
    sessionId: string | null;
    createdAt: string;
  } | null;
}

interface RecordImpressionEdgeParams {
  userId: number;
  fromImpressionId: string;
  toImpressionId: string;
  relationType?: string;
  batchId: string;
}

interface RecordImpressionMessageLinksParams {
  impressionId: string;
  messageIds: number[];
  batchId: string;
}

@Injectable()
export class ImpressionsService {
  constructor(
    private configService: ConfigService,
    @InjectRepository(ImpressionEdge)
    private impressionEdgeRepository: Repository<ImpressionEdge>,
    @InjectRepository(ImpressionMessageLink)
    private impressionMessageLinkRepository: Repository<ImpressionMessageLink>,
    @InjectRepository(ChatMessage)
    private chatMessageRepository: Repository<ChatMessage>,
  ) {}

  private getEmbeddingUrl(): string {
    return this.configService.get<string>('dashscope.embeddingUrl')!;
  }

  private getEmbeddingModel(): string {
    return this.configService.get<string>('dashscope.embeddingModel')!;
  }

  private getQdrantUrl(): string {
    return this.configService.get<string>('qdrant.url')!;
  }

  private getCollectionName(): string {
    return this.configService.get<string>('qdrant.collectionName')!;
  }

  private mapPointToImpressionRecord(point: any): ImpressionRecord {
    const payload = point.payload || {};
    const memoryDate = payload.memoryDate || payload.date || '';
    const originType = payload.originType === 'continued_from_history'
      ? 'continued'
      : (payload.originType || 'standalone');
    const scene = String(payload.scene || '').trim();
    const points = Array.isArray(payload.points)
      ? payload.points.map((item: unknown) => String(item || '').trim()).filter(Boolean)
      : [];
    const entities = Array.isArray(payload.entities)
      ? payload.entities.map((item: unknown) => String(item || '').trim()).filter(Boolean)
      : [];
    const retrievalText = String(payload.retrievalText || '').trim();
    return {
      id: String(point.id),
      scene,
      points,
      entities,
      retrievalText,
      content: payload.content || [scene, ...points.map((item) => `- ${item}`)].join('\n'),
      score: point.score || 0,
      sessionId: payload.sessionId || null,
      createdAt: payload.createdAt || '',
      updatedAt: payload.updatedAt || '',
      memoryDate,
      date: memoryDate,
      salienceScore: Number(payload.salienceScore || 0),
      lastActivatedAt: payload.lastActivatedAt || payload.updatedAt || payload.createdAt || '',
      originType,
      sourceImpressionId: payload.sourceImpressionId || null,
      rootImpressionId: payload.rootImpressionId || String(point.id),
    };
  }

  private sortByRecent(records: ImpressionRecord[]): ImpressionRecord[] {
    return [...records].sort((a, b) => {
      const aTime = new Date(a.lastActivatedAt || a.updatedAt || a.createdAt).getTime();
      const bTime = new Date(b.lastActivatedAt || b.updatedAt || b.createdAt).getTime();
      return bTime - aTime;
    });
  }

  private getRecordTimestamp(record: Pick<ImpressionRecord, 'lastActivatedAt' | 'updatedAt' | 'createdAt'>): number {
    return new Date(record.lastActivatedAt || record.updatedAt || record.createdAt).getTime();
  }

  async search(query: string, limit = 5): Promise<SearchResult[]> {
    // Get query embedding
    const embedding = await this.getEmbedding(query);

    // Search Qdrant
    const qdrantUrl = this.getQdrantUrl();
    const collection = this.getCollectionName();

    try {
      const response = await axios.post(
        `${qdrantUrl}/collections/${collection}/points/search`,
        {
          vector: embedding,
          limit,
          with_payload: true,
        },
      );

      const points = response.data.result || [];
      return points.map((point: any) => ({
        content: point.payload?.content || '',
        score: point.score,
      }));
    } catch (error: any) {
      console.error('[Qdrant] Search error:', error?.message);
      return [];
    }
  }

  async getEmbedding(text: string): Promise<number[]> {
    const apiKey = this.configService.get<string>('dashscope.apiKey');

    try {
      const response = await axios.post(
        this.getEmbeddingUrl(),
        {
          model: this.getEmbeddingModel(),
          input: { texts: [text] },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
        },
      );

      const embeddings = response.data.output?.embeddings;
      if (!embeddings || !embeddings[0]?.embedding) {
        console.error('[DashScope] No embeddings in response:', JSON.stringify(response.data).substring(0, 300));
        throw new Error('Invalid embedding response');
      }
      return embeddings[0].embedding;
    } catch (error: any) {
      console.error('[DashScope] Embedding error:', error?.message);
      throw error;
    }
  }

  async ensureCollection(): Promise<void> {
    const qdrantUrl = this.getQdrantUrl();
    const collection = this.getCollectionName();
    const dim = this.configService.get<number>('dashscope.embeddingDim')!;

    try {
      // Check if collection exists
      await axios.get(`${qdrantUrl}/collections/${collection}`);
    } catch {
      // Create collection if not exists
      await axios.put(`${qdrantUrl}/collections/${collection}`, {
        vectors: {
          size: dim,
          distance: 'Cosine',
        },
      });
      console.log(`[Qdrant] Created collection: ${collection}`);
    }
  }

  async getUserImpressions(userId: number): Promise<ImpressionRecord[]> {
    const qdrantUrl = this.getQdrantUrl();
    const collection = this.getCollectionName();

    try {
      // Use scroll API to get all points for this user
      const response = await axios.post(
        `${qdrantUrl}/collections/${collection}/points/scroll`,
        {
          filter: {
            must: [
              {
                key: 'userId',
                match: { value: userId },
              },
            ],
          },
          with_payload: true,
          limit: 1000,
        },
      );

      const points = response.data.result?.points || [];
      return this.sortByRecent(points.map((point: any) => this.mapPointToImpressionRecord(point)));
    } catch (error: any) {
      console.error('[Qdrant] Get user impressions error:', error?.message);
      return [];
    }
  }

  async getRecentUserImpressions(
    userId: number,
    limit = 5,
    days = 7,
  ): Promise<ImpressionRecord[]> {
    const impressions = await this.getUserImpressions(userId);
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

    return impressions
      .filter((record) => this.getRecordTimestamp(record) >= cutoff)
      .slice(0, limit);
  }

  async searchUserImpressions(
    userId: number,
    query: string,
    limit = 8,
  ): Promise<ImpressionRecord[]> {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) {
      return [];
    }

    const embedding = await this.getEmbedding(normalizedQuery);
    const qdrantUrl = this.getQdrantUrl();
    const collection = this.getCollectionName();

    try {
      const response = await axios.post(
        `${qdrantUrl}/collections/${collection}/points/search`,
        {
          vector: embedding,
          limit,
          with_payload: true,
          filter: {
            must: [
              {
                key: 'userId',
                match: { value: userId },
              },
            ],
          },
        },
      );

      return (response.data.result || []).map((point: any) => this.mapPointToImpressionRecord(point));
    } catch (error: any) {
      console.error('[Qdrant] Search user impressions error:', error?.message);
      return [];
    }
  }

  async recordImpressionEdge(params: RecordImpressionEdgeParams): Promise<{ created: boolean }> {
    const {
      userId,
      fromImpressionId,
      toImpressionId,
      relationType = 'continued_from',
      batchId,
    } = params;

    if (!fromImpressionId || !toImpressionId || fromImpressionId === toImpressionId) {
      return { created: false };
    }

    const existing = await this.impressionEdgeRepository.findOne({
      where: { fromImpressionId, toImpressionId, batchId },
    });

    if (existing) {
      return { created: false };
    }

    const edge = this.impressionEdgeRepository.create({
      userId,
      fromImpressionId,
      toImpressionId,
      relationType,
      batchId,
    });
    await this.impressionEdgeRepository.save(edge);
    return { created: true };
  }

  async recordImpressionMessageLinks(
    params: RecordImpressionMessageLinksParams,
  ): Promise<{ created: number }> {
    const impressionId = params.impressionId?.trim();
    const batchId = params.batchId?.trim();
    const uniqueMessageIds = Array.from(
      new Set((params.messageIds || []).map((messageId) => Number(messageId)).filter(Number.isInteger)),
    );

    if (!impressionId || !batchId || !uniqueMessageIds.length) {
      return { created: 0 };
    }

    const existingLinks = await this.impressionMessageLinkRepository.find({
      where: {
        impressionId,
        batchId,
        messageId: In(uniqueMessageIds),
      },
    });

    const existingMessageIds = new Set(existingLinks.map((link) => link.messageId));
    const toInsert = uniqueMessageIds
      .filter((messageId) => !existingMessageIds.has(messageId))
      .map((messageId) => this.impressionMessageLinkRepository.create({
        impressionId,
        messageId,
        batchId,
      }));

    if (!toInsert.length) {
      return { created: 0 };
    }

    await this.impressionMessageLinkRepository.save(toInsert);
    return { created: toInsert.length };
  }

  async getImpressionsByIds(ids: string[]): Promise<ImpressionRecord[]> {
    const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
    if (!uniqueIds.length) {
      return [];
    }

    const qdrantUrl = this.getQdrantUrl();
    const collection = this.getCollectionName();

    try {
      const response = await axios.post(
        `${qdrantUrl}/collections/${collection}/points`,
        {
          ids: uniqueIds,
          with_payload: true,
        },
      );

      const raw = response.data.result;
      const points = Array.isArray(raw) ? raw : raw?.points || [];
      return points.map((point: any) => this.mapPointToImpressionRecord(point));
    } catch (error: any) {
      console.error('[Qdrant] Get impressions by ids error:', error?.message);
      return [];
    }
  }

  async getImpressionSources(impressionId: string): Promise<ImpressionSourceRecord[]> {
    const edges = await this.impressionEdgeRepository.find({
      where: { toImpressionId: impressionId },
      order: { createdAt: 'ASC' },
    });

    if (!edges.length) {
      return [];
    }

    const sourceRecords = await this.getImpressionsByIds(edges.map((edge) => edge.fromImpressionId));
    const sourceById = new Map(sourceRecords.map((record) => [record.id, record]));

    return edges.map((edge) => ({
      relationType: edge.relationType,
      batchId: edge.batchId,
      createdAt: edge.createdAt.toISOString(),
      source: sourceById.get(edge.fromImpressionId) || null,
    }));
  }

  async getImpressionMessages(impressionId: string): Promise<ImpressionMessageRecord[]> {
    const links = await this.impressionMessageLinkRepository.find({
      where: { impressionId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });

    if (!links.length) {
      return [];
    }

    const messageIds = Array.from(new Set(links.map((link) => link.messageId)));
    const messages = await this.chatMessageRepository.find({
      where: { id: In(messageIds) },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    const messageById = new Map(messages.map((message) => [message.id, message]));

    return links.map((link) => {
      const message = messageById.get(link.messageId);
      return {
        batchId: link.batchId,
        linkedAt: link.createdAt.toISOString(),
        message: message ? {
          id: message.id,
          role: message.role,
          content: message.content,
          sessionId: message.chatSessionId,
          createdAt: message.createdAt.toISOString(),
        } : null,
      };
    });
  }
}
