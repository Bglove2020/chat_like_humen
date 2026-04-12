import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  LineMessageRecord,
  MemoryLineRecord,
  MemoryPointRecord,
  MemoryService,
} from '../memory/memory.service';

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

export type ImpressionMessageRecord = LineMessageRecord;

const INITIAL_SALIENCE_SCORE = 1;
const DECAY_HALF_LIFE_DAYS = 30;

function computeDecayWeight(
  salienceScore = INITIAL_SALIENCE_SCORE,
  lastActivatedAt?: string,
  now = new Date(),
): number {
  const activatedAt = lastActivatedAt ? new Date(lastActivatedAt) : now;
  const elapsedMs = Math.max(0, now.getTime() - activatedAt.getTime());
  const elapsedDays = elapsedMs / (24 * 60 * 60 * 1000);
  const decayFactor = Math.exp((-Math.log(2) * elapsedDays) / DECAY_HALF_LIFE_DAYS);
  return salienceScore * decayFactor;
}

function computeEffectiveScore(record: Pick<ImpressionRecord, 'score' | 'salienceScore' | 'lastActivatedAt'>): number {
  return (record.score || 0) * computeDecayWeight(record.salienceScore, record.lastActivatedAt);
}

function normalizeText(value: string, maxLength: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

@Injectable()
export class ImpressionsService {
  constructor(
    private configService: ConfigService,
    private memoryService: MemoryService,
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

  private buildRetrievalText(line: MemoryLineRecord, leafPoints: MemoryPointRecord[]): string {
    const parts = [
      line.anchorLabel,
      line.impressionLabel,
      line.impressionAbstract,
      ...leafPoints.slice(0, 3).map((point) => point.text),
    ]
      .map((item) => normalizeText(item, 180))
      .filter(Boolean);

    return normalizeText(parts.join('。'), 360);
  }

  private getMemoryDate(line: MemoryLineRecord, leafPoints: MemoryPointRecord[]): string {
    const latestPoint = [...leafPoints]
      .sort((left, right) => (
        new Date(right.updatedAt || right.createdAt || 0).getTime()
        - new Date(left.updatedAt || left.createdAt || 0).getTime()
      ))[0];

    if (latestPoint?.memoryDate) {
      return latestPoint.memoryDate;
    }

    return (line.updatedAt || line.createdAt || '').split('T')[0] || '';
  }

  private mapLineToImpressionRecord(
    line: MemoryLineRecord,
    leafPoints: MemoryPointRecord[],
    score = 0,
  ): ImpressionRecord {
    const scene = normalizeText(line.impressionLabel || line.anchorLabel, 120);
    const points = Array.from(new Set(
      leafPoints
        .map((point) => normalizeText(point.text, 220))
        .filter(Boolean),
    )).slice(0, 4);
    const memoryDate = this.getMemoryDate(line, leafPoints);
    const retrievalText = this.buildRetrievalText(line, leafPoints);

    return {
      id: line.id,
      scene,
      points,
      entities: [],
      retrievalText,
      content: line.impressionAbstract || [scene, ...points.map((point) => `- ${point}`)].join('\n'),
      score,
      sessionId: line.sessionId,
      createdAt: line.createdAt,
      updatedAt: line.updatedAt,
      memoryDate,
      date: memoryDate,
      salienceScore: Number(line.salienceScore || INITIAL_SALIENCE_SCORE),
      lastActivatedAt: line.lastActivatedAt || line.updatedAt || line.createdAt,
      originType: 'line',
      sourceImpressionId: null,
      rootImpressionId: line.id,
    };
  }

  private async hydrateLineSummaries(
    lineScores: Array<{ lineId: string; score: number }>,
  ): Promise<ImpressionRecord[]> {
    const lineIds = Array.from(new Set(lineScores.map((item) => item.lineId).filter(Boolean)));
    if (!lineIds.length) {
      return [];
    }

    const [lines, leafPointsByLineId] = await Promise.all([
      this.memoryService.getLinesByIds(lineIds),
      this.memoryService.getLeafPointsByLineIds(lineIds),
    ]);
    const lineById = new Map(lines.map((line) => [line.id, line]));
    const scoreByLineId = new Map(lineScores.map((item) => [item.lineId, item.score]));

    return lineIds
      .map((lineId) => {
        const line = lineById.get(lineId);
        if (!line) {
          return null;
        }

        return this.mapLineToImpressionRecord(
          line,
          leafPointsByLineId[lineId] || [],
          scoreByLineId.get(lineId) || 0,
        );
      })
      .filter((item): item is ImpressionRecord => Boolean(item));
  }

  async getEmbedding(text: string): Promise<number[]> {
    const apiKey = this.configService.get<string>('dashscope.apiKey');

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
      throw new Error('Invalid embedding response');
    }
    return embeddings[0].embedding;
  }

  async search(query: string, limit = 5): Promise<SearchResult[]> {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) {
      return [];
    }

    const embedding = await this.getEmbedding(normalizedQuery);
    const response = await axios.post(
      `${this.getQdrantUrl()}/collections/${this.getCollectionName()}/points/search`,
      {
        vector: embedding,
        limit,
        with_payload: true,
      },
    );

    return (response.data.result || []).map((point: any) => ({
      content: String(point.payload?.text || point.payload?.impressionAbstract || point.payload?.content || ''),
      score: Number(point.score || 0),
    }));
  }

  async getUserImpressions(userId: number): Promise<ImpressionRecord[]> {
    const lines = await this.memoryService.getAllLines(userId);
    if (!lines.length) {
      return [];
    }

    const lineIds = lines.map((line) => line.id);
    const leafPointsByLineId = await this.memoryService.getLeafPointsByLineIds(lineIds);

    return lines.map((line) => this.mapLineToImpressionRecord(line, leafPointsByLineId[line.id] || []));
  }

  async getRecentUserImpressions(
    userId: number,
    limit = 5,
    days = 7,
  ): Promise<ImpressionRecord[]> {
    const lines = await this.memoryService.getRecentLines(userId, limit, days);
    if (!lines.length) {
      return [];
    }

    const lineIds = lines.map((line) => line.id);
    const leafPointsByLineId = await this.memoryService.getLeafPointsByLineIds(lineIds);

    return lines.map((line) => this.mapLineToImpressionRecord(line, leafPointsByLineId[line.id] || []));
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
    const response = await axios.post(
      `${this.getQdrantUrl()}/collections/${this.getCollectionName()}/points/search`,
      {
        vector: embedding,
        limit: Math.max(limit * 4, 12),
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

    const bestByLineId = new Map<string, number>();
    for (const point of response.data.result || []) {
      const lineId = String(point.payload?.lineId || '').trim();
      if (!lineId) {
        continue;
      }

      const score = Number(point.score || 0);
      const existing = bestByLineId.get(lineId) || 0;
      if (score > existing) {
        bestByLineId.set(lineId, score);
      }
    }

    const records = await this.hydrateLineSummaries(
      Array.from(bestByLineId.entries()).map(([lineId, score]) => ({ lineId, score })),
    );

    return records
      .sort((left, right) => {
        const rightEffective = computeEffectiveScore(right);
        const leftEffective = computeEffectiveScore(left);
        if (rightEffective !== leftEffective) {
          return rightEffective - leftEffective;
        }

        return new Date(right.lastActivatedAt || right.updatedAt || right.createdAt).getTime()
          - new Date(left.lastActivatedAt || left.updatedAt || left.createdAt).getTime();
      })
      .slice(0, limit);
  }

  async getImpressionsByIds(ids: string[]): Promise<ImpressionRecord[]> {
    return this.hydrateLineSummaries(ids.map((lineId) => ({ lineId, score: 0 })));
  }

  async getImpressionSources(_impressionId: string): Promise<ImpressionSourceRecord[]> {
    return [];
  }

  async getImpressionMessages(impressionId: string): Promise<ImpressionMessageRecord[]> {
    return this.memoryService.getLineMessages(impressionId);
  }

  async recordImpressionEdge(_params?: unknown): Promise<{ created: boolean }> {
    return { created: false };
  }

  async recordImpressionMessageLinks(_params?: unknown): Promise<{ created: number }> {
    return { created: 0 };
  }
}
