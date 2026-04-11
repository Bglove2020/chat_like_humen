import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { randomUUID } from 'crypto';
import {
  ChatMessageInput,
  DashscopeService,
  FinalImpressionDraft,
  Impression,
  RetrievalDrafts,
} from './dashscope.service';
import {
  bumpSalienceScore,
  computeEffectiveScore,
  dedupeByAncestorChain,
  dedupeByIdKeepBest,
  INITIAL_SALIENCE_SCORE,
  normalizeOriginType,
  shouldUpdateExistingImpression,
} from './impression-logic.util';

export interface ChatMessage extends ChatMessageInput {}

export interface SummaryJobData {
  userId: number;
  sessionId?: string;
  date: string;
  batchId: string;
  messages: ChatMessage[];
}

type OriginType = 'standalone' | 'continued';
type DraftKind = 'history' | 'delta' | 'merged' | 'recent';

interface UpsertImpressionParams {
  impressionId?: string;
  userId: number;
  sessionId?: string;
  date: string;
  scene: string;
  points: string[];
  entities?: string[];
  retrievalText: string;
  action: 'create' | 'update';
  existingImpression?: Impression;
  originType?: OriginType;
  sourceImpressionId?: string | null;
  rootImpressionId?: string | null;
}

interface RecallBucket {
  kind: DraftKind;
  query: string;
  impressions: Impression[];
}

interface Node1RecentRerankBreakdown {
  impression: Impression;
  semanticScore: number;
  anchorCoverage: number;
  normalizedSalienceScore: number;
  rerankScore: number;
  impressionAnchors: string[];
}

const DRAFT_WEIGHTS: Record<DraftKind, number> = {
  merged: 1,
  delta: 0.8,
  history: 0.6,
  recent: 0.25,
};

const NODE1_RERANK_WEIGHTS = {
  semantic: 0.55,
  anchor: 0.25,
  salience: 0.2,
} as const;

const ANCHOR_STOPWORDS = new Set([
  '用户',
  'AI',
  '我们',
  '你们',
  '他们',
  '这个',
  '那个',
  '这些',
  '那些',
  '现在',
  '之前',
  '还是',
  '然后',
  '就是',
  '因为',
  '所以',
  '如果',
  '已经',
  '可以',
  '一下',
  '一个',
  '一种',
  '一些',
  '问题',
  '事情',
  '情况',
  '内容',
  '话题',
  '聊天',
  '对话',
  '感觉',
  '觉得',
  '时候',
  '东西',
]);

function normalizeScene(scene: string): string {
  return String(scene || '').replace(/\s+/g, ' ').trim().substring(0, 60);
}

function normalizePoints(points: string[]): string[] {
  return Array.from(new Set(
    (points || [])
      .map((point) => String(point || '').replace(/\s+/g, ' ').trim().substring(0, 180))
      .filter(Boolean),
  )).slice(0, 6);
}

function normalizeRetrievalText(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim().substring(0, 360);
}

function composeLegacyContent(scene: string, points: string[]): string {
  const normalizedScene = normalizeScene(scene);
  const normalizedPoints = normalizePoints(points);
  return [normalizedScene, ...normalizedPoints.map((point) => `- ${point}`)].join('\n');
}

@Injectable()
export class QdrantService {
  private static readonly NODE1_RECENT_CANDIDATE_LIMIT = 10;
  private static readonly RECENT_IMPRESSION_SCAN_LIMIT = 1000;
  private static readonly NODE1_RECENT_SUPPORT_LIMIT = 6;
  private static readonly QUERY_RECALL_LIMIT = 8;
  private static readonly FINAL_RECALL_LIMIT = 6;

  constructor(
    private configService: ConfigService,
    private dashscopeService: DashscopeService,
  ) {}

  private getCollectionName(): string {
    return this.configService.get<string>('qdrant.collectionName')!;
  }

  private getQdrantUrl(): string {
    return this.configService.get<string>('qdrant.url')!;
  }

  private getBackendInternalUrl(): string {
    return this.configService.get<string>('backend.internalUrl')!;
  }

  private getEmbeddingDim(): number {
    return this.configService.get<number>('dashscope.embeddingDim')!;
  }

  private sortByActivity(impressions: Impression[]): Impression[] {
    return [...impressions].sort((left, right) => {
      const leftTime = new Date(
        left.lastActivatedAt || left.updatedAt || left.createdAt,
      ).getTime();
      const rightTime = new Date(
        right.lastActivatedAt || right.updatedAt || right.createdAt,
      ).getTime();
      return rightTime - leftTime;
    });
  }

  private mapPointToImpression(point: any): Impression {
    const payload = point.payload || {};
    const memoryDate = payload.memoryDate || payload.date || '';
    const scene = normalizeScene(payload.scene || '');
    const points = normalizePoints(Array.isArray(payload.points) ? payload.points : []);
    const entities = Array.isArray(payload.entities)
      ? payload.entities.map((item: unknown) => String(item || '').trim()).filter(Boolean).slice(0, 8)
      : [];
    const retrievalText = normalizeRetrievalText(
      payload.retrievalText || payload.content || composeLegacyContent(scene, points),
    );

    return {
      id: String(point.id),
      scene,
      points,
      entities,
      retrievalText,
      content: payload.content || composeLegacyContent(scene, points),
      createdAt: payload.createdAt || '',
      updatedAt: payload.updatedAt || '',
      sessionId: payload.sessionId || null,
      memoryDate,
      relevanceScore: point.score || payload.relevanceScore || 0,
      sourceImpressionId: payload.sourceImpressionId || null,
      rootImpressionId: payload.rootImpressionId || String(point.id),
      originType: normalizeOriginType(payload.originType),
      salienceScore: Number(payload.salienceScore || INITIAL_SALIENCE_SCORE),
      lastActivatedAt: payload.lastActivatedAt || payload.updatedAt || payload.createdAt || '',
    };
  }

  async ensureCollection(): Promise<void> {
    const qdrantUrl = this.getQdrantUrl();
    const collection = this.getCollectionName();
    const dim = this.getEmbeddingDim();

    try {
      await axios.get(`${qdrantUrl}/collections/${collection}`);
      console.log(`[Qdrant] Collection "${collection}" already exists`);
    } catch {
      await axios.put(`${qdrantUrl}/collections/${collection}`, {
        vectors: {
          size: dim,
          distance: 'Cosine',
        },
      });
      console.log(`[Qdrant] Created collection: ${collection}`);
    }
  }

  private async getRecentImpressions(userId: number, limit: number): Promise<Impression[]> {
    const qdrantUrl = this.getQdrantUrl();
    const collection = this.getCollectionName();
    const scanLimit = Math.max(limit, QdrantService.RECENT_IMPRESSION_SCAN_LIMIT);

    try {
      const response = await axios.post(
        `${qdrantUrl}/collections/${collection}/points/scroll`,
        {
          limit: scanLimit,
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

      const points = response.data.result?.points || [];
      return this.sortByActivity(points.map((point: any) => ({
        ...this.mapPointToImpression(point),
        relevanceScore: DRAFT_WEIGHTS.recent,
      }))).slice(0, limit);
    } catch (error: any) {
      console.error('[Qdrant] Recent impressions search error:', error?.message);
      return [];
    }
  }

  private async searchImpressionsByQuery(
    userId: number,
    query: string,
    limit = QdrantService.QUERY_RECALL_LIMIT,
  ): Promise<Impression[]> {
    if (!query.trim()) {
      return [];
    }

    const qdrantUrl = this.getQdrantUrl();
    const collection = this.getCollectionName();

    try {
      const queryEmbedding = await this.dashscopeService.getEmbedding(query);
      const response = await axios.post(
        `${qdrantUrl}/collections/${collection}/points/search`,
        {
          vector: queryEmbedding,
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

      return (response.data.result || []).map((point: any) => this.mapPointToImpression(point));
    } catch (error: any) {
      console.error('[Qdrant] Candidate search error:', error?.message);
      return [];
    }
  }

  private async getImpressionsByIds(ids: string[]): Promise<Impression[]> {
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
      return points.map((point: any) => this.mapPointToImpression(point));
    } catch (error: any) {
      console.error('[Qdrant] Get impressions by ids error:', error?.message);
      return [];
    }
  }

  private async hydrateAncestors(impressions: Impression[]): Promise<Impression[]> {
    const knownById = new Map(impressions.map((impression) => [impression.id, impression]));
    let frontier = impressions
      .map((impression) => impression.sourceImpressionId)
      .filter((id): id is string => Boolean(id && !knownById.has(id)));

    while (frontier.length) {
      const ancestors = await this.getImpressionsByIds(frontier);
      if (!ancestors.length) {
        break;
      }

      for (const ancestor of ancestors) {
        if (!knownById.has(ancestor.id)) {
          knownById.set(ancestor.id, ancestor);
        }
      }

      frontier = ancestors
        .map((impression) => impression.sourceImpressionId)
        .filter((id): id is string => Boolean(id && !knownById.has(id)));
    }

    return Array.from(knownById.values());
  }

  private rankRetrievedImpressions(impressions: Impression[]): Impression[] {
    const now = new Date();
    return [...impressions]
      .map((impression) => ({
        ...impression,
        effectiveScore: computeEffectiveScore(impression, now),
      }))
      .sort((left, right) => {
        if ((right.effectiveScore || 0) !== (left.effectiveScore || 0)) {
          return (right.effectiveScore || 0) - (left.effectiveScore || 0);
        }

        return new Date(
          right.lastActivatedAt || right.updatedAt || right.createdAt,
        ).getTime() - new Date(
          left.lastActivatedAt || left.updatedAt || left.createdAt,
        ).getTime();
      });
  }

  private async recallBucketsForDrafts(userId: number, drafts: RetrievalDrafts): Promise<RecallBucket[]> {
    const orderedDrafts: Array<{ kind: DraftKind; query: string }> = [
      { kind: 'history', query: drafts.historyRetrievalDraft || '' },
      { kind: 'delta', query: drafts.deltaRetrievalDraft || '' },
      { kind: 'merged', query: drafts.mergedRetrievalDraft || '' },
    ];

    const buckets: RecallBucket[] = [];

    for (const draft of orderedDrafts) {
      const impressions = draft.query.trim()
        ? await this.searchImpressionsByQuery(userId, draft.query, QdrantService.QUERY_RECALL_LIMIT)
        : [];
      buckets.push({ kind: draft.kind, query: draft.query, impressions });
    }

    return buckets;
  }

  private buildRecentSupportQuery(messages: ChatMessage[]): string {
    const recentMessages = messages.slice(-8);
    return recentMessages
      .map((message) => `[${message.role === 'user' ? '用户' : 'AI'}] ${message.content}`)
      .join('；')
      .substring(0, 500);
  }

  private formatNode1RecentSupportItem(impression: Impression): Record<string, unknown> {
    return {
      id: impression.id,
      scene: impression.scene,
      entities: (impression.entities || []).slice(0, 6),
      salienceScore: Number((impression.salienceScore || INITIAL_SALIENCE_SCORE).toFixed(3)),
      lastActivatedAt: impression.lastActivatedAt || impression.updatedAt || impression.createdAt || null,
    };
  }

  private formatNode1RecentRerankBreakdownItem(
    item: Node1RecentRerankBreakdown,
  ): Record<string, unknown> {
    return {
      id: item.impression.id,
      scene: item.impression.scene,
      semanticScore: item.semanticScore,
      anchorCoverage: item.anchorCoverage,
      normalizedSalienceScore: item.normalizedSalienceScore,
      rerankScore: item.rerankScore,
      anchors: item.impressionAnchors,
      entities: (item.impression.entities || []).slice(0, 6),
      salienceScore: Number((item.impression.salienceScore || INITIAL_SALIENCE_SCORE).toFixed(3)),
      lastActivatedAt: item.impression.lastActivatedAt || item.impression.updatedAt || item.impression.createdAt || null,
    };
  }

  private extractAnchorTokens(text: string): string[] {
    if (!text.trim()) {
      return [];
    }

    const matches = text.match(/《[^》]{1,20}》|[A-Za-z0-9_-]{3,}|[\u4e00-\u9fa5]{2,10}/g) || [];
    return Array.from(new Set(
      matches
        .map((token) => token.trim())
        .filter((token) => token.length >= 2 && !ANCHOR_STOPWORDS.has(token)),
    )).slice(0, 24);
  }

  private normalizeSalienceForRerank(salienceScore?: number): number {
    const raw = typeof salienceScore === 'number' && salienceScore > 0
      ? salienceScore
      : INITIAL_SALIENCE_SCORE;
    const normalized = raw / 5;
    return Math.max(0, Math.min(1, Number(normalized.toFixed(6))));
  }

  private extractImpressionAnchors(impression: Impression): string[] {
    const explicitAnchors = Array.isArray(impression.entities)
      ? impression.entities.map((item) => String(item || '').trim()).filter(Boolean)
      : [];

    if (explicitAnchors.length) {
      return Array.from(new Set(explicitAnchors)).slice(0, 8);
    }

    return this.extractAnchorTokens([
      impression.scene,
      ...(impression.points || []).slice(0, 3),
    ].join('；')).slice(0, 8);
  }

  private computeAnchorCoverage(
    queryText: string,
    queryAnchors: string[],
    impression: Impression,
  ): number {
    const impressionAnchors = this.extractImpressionAnchors(impression);
    if (!impressionAnchors.length) {
      return 0;
    }

    const matched = impressionAnchors.filter((anchor) => (
      queryText.includes(anchor)
      || queryAnchors.some((queryAnchor) => (
        queryAnchor.includes(anchor) || anchor.includes(queryAnchor)
      ))
    ));

    return Number((matched.length / impressionAnchors.length).toFixed(6));
  }

  private async rerankRecentActivatedImpressions(
    batchId: string,
    userId: number,
    messages: ChatMessage[],
    recentCandidates: Impression[],
  ): Promise<Impression[]> {
    if (recentCandidates.length <= QdrantService.NODE1_RECENT_SUPPORT_LIMIT) {
      console.log(
        `[Worker][Node1Support] batch=${batchId} mode=direct reason=candidate_count_le_limit candidates=${JSON.stringify(
          recentCandidates.map((impression) => this.formatNode1RecentSupportItem(impression)),
        )}`,
      );
      return recentCandidates;
    }

    const supportQuery = this.buildRecentSupportQuery(messages);
    if (!supportQuery.trim()) {
      const selected = recentCandidates.slice(0, QdrantService.NODE1_RECENT_SUPPORT_LIMIT);
      console.log(
        `[Worker][Node1Support] batch=${batchId} mode=direct reason=empty_support_query candidates=${JSON.stringify(
          recentCandidates.map((impression) => this.formatNode1RecentSupportItem(impression)),
        )} selected=${JSON.stringify(
          selected.map((impression) => this.formatNode1RecentSupportItem(impression)),
        )}`,
      );
      return selected;
    }

    const queryAnchors = this.extractAnchorTokens(supportQuery);
    const relatedImpressions = await this.searchImpressionsByQuery(
      userId,
      supportQuery,
      QdrantService.NODE1_RECENT_CANDIDATE_LIMIT * 2,
    );
    const semanticScoreById = new Map(
      relatedImpressions.map((impression) => [impression.id, impression.relevanceScore || 0]),
    );

    const reranked = [...recentCandidates]
      .map((impression) => {
        const semanticScore = Number((semanticScoreById.get(impression.id) || 0).toFixed(6));
        const impressionAnchors = this.extractImpressionAnchors(impression);
        const anchorCoverage = this.computeAnchorCoverage(supportQuery, queryAnchors, impression);
        const normalizedSalienceScore = this.normalizeSalienceForRerank(impression.salienceScore);
        const rerankScore = Number((
          semanticScore * NODE1_RERANK_WEIGHTS.semantic
          + anchorCoverage * NODE1_RERANK_WEIGHTS.anchor
          + normalizedSalienceScore * NODE1_RERANK_WEIGHTS.salience
        ).toFixed(6));

        return {
          impression,
          semanticScore,
          anchorCoverage,
          normalizedSalienceScore,
          rerankScore,
          impressionAnchors,
        } satisfies Node1RecentRerankBreakdown;
      })
      .sort((left, right) => {
        if (right.rerankScore !== left.rerankScore) {
          return right.rerankScore - left.rerankScore;
        }

        if (right.semanticScore !== left.semanticScore) {
          return right.semanticScore - left.semanticScore;
        }

        if ((right.impression.salienceScore || 0) !== (left.impression.salienceScore || 0)) {
          return (right.impression.salienceScore || 0) - (left.impression.salienceScore || 0);
        }

        return new Date(
          right.impression.lastActivatedAt || right.impression.updatedAt || right.impression.createdAt,
        ).getTime() - new Date(
          left.impression.lastActivatedAt || left.impression.updatedAt || left.impression.createdAt,
        ).getTime();
      });

    const selected = reranked
      .slice(0, QdrantService.NODE1_RECENT_SUPPORT_LIMIT)
      .map((item) => item.impression);

    console.log(
      `[Worker][Node1Support] batch=${batchId} mode=hybrid_rerank supportQuery=${JSON.stringify(
        supportQuery,
      )} queryAnchors=${JSON.stringify(queryAnchors)} candidates=${JSON.stringify(
        recentCandidates.map((impression) => this.formatNode1RecentSupportItem(impression)),
      )} breakdown=${JSON.stringify(
        reranked.map((item) => this.formatNode1RecentRerankBreakdownItem(item)),
      )} selected=${JSON.stringify(
        selected.map((impression) => this.formatNode1RecentSupportItem(impression)),
      )}`,
    );

    return selected;
  }

  private async selectNode1RecentSupportImpressions(
    batchId: string,
    userId: number,
    messages: ChatMessage[],
  ): Promise<Impression[]> {
    const recentCandidates = await this.getRecentImpressions(
      userId,
      QdrantService.NODE1_RECENT_CANDIDATE_LIMIT,
    );

    return this.rerankRecentActivatedImpressions(batchId, userId, messages, recentCandidates);
  }

  private async recallImpressionsForDrafts(userId: number, drafts: RetrievalDrafts): Promise<Impression[]> {
    const buckets = await this.recallBucketsForDrafts(userId, drafts);
    const merged = new Map<string, Impression>();

    for (const bucket of buckets) {
      const weight = DRAFT_WEIGHTS[bucket.kind];
      for (const impression of bucket.impressions) {
        const weightedSimilarity = Number(((impression.relevanceScore || 0) * weight).toFixed(6));
        const existing = merged.get(impression.id);

        if (!existing || weightedSimilarity > (existing.relevanceScore || 0)) {
          merged.set(impression.id, {
            ...impression,
            relevanceScore: weightedSimilarity,
          });
        }
      }
    }

    const deduped = dedupeByIdKeepBest(Array.from(merged.values()));
    if (!deduped.length) {
      return [];
    }

    const knownChain = await this.hydrateAncestors(deduped);
    const chainDeduped = dedupeByAncestorChain(deduped, knownChain);
    return this.rankRetrievedImpressions(chainDeduped).slice(0, QdrantService.FINAL_RECALL_LIMIT);
  }

  private async isLeafImpression(userId: number, impressionId: string): Promise<boolean> {
    const qdrantUrl = this.getQdrantUrl();
    const collection = this.getCollectionName();

    try {
      const response = await axios.post(
        `${qdrantUrl}/collections/${collection}/points/scroll`,
        {
          limit: 1,
          with_payload: false,
          filter: {
            must: [
              {
                key: 'userId',
                match: { value: userId },
              },
              {
                key: 'sourceImpressionId',
                match: { value: impressionId },
              },
            ],
          },
        },
      );

      const points = response.data.result?.points || [];
      return points.length === 0;
    } catch (error: any) {
      console.error('[Qdrant] Leaf lookup error:', error?.message);
      return false;
    }
  }

  private async recordImpressionEdge(
    userId: number,
    fromImpressionId: string,
    toImpressionId: string,
    batchId: string,
  ): Promise<void> {
    try {
      await axios.post(`${this.getBackendInternalUrl()}/api/internal/impression-edges`, {
        userId,
        fromImpressionId,
        toImpressionId,
        relationType: 'continued_from',
        batchId,
      });
    } catch (error: any) {
      console.error('[Worker] Record impression edge error:', error?.message);
    }
  }

  private async recordImpressionMessageLinks(
    impressionId: string,
    messageIds: number[],
    batchId: string,
  ): Promise<void> {
    const uniqueMessageIds = Array.from(
      new Set((messageIds || []).map((messageId) => Number(messageId)).filter(Number.isInteger)),
    );

    if (!impressionId || !uniqueMessageIds.length) {
      return;
    }

    try {
      await axios.post(`${this.getBackendInternalUrl()}/api/internal/impression-message-links`, {
        impressionId,
        messageIds: uniqueMessageIds,
        batchId,
      });
    } catch (error: any) {
      console.error('[Worker] Record impression message links error:', error?.message);
    }
  }

  async upsertImpression(params: UpsertImpressionParams): Promise<Impression | null> {
    const {
      impressionId,
      userId,
      sessionId,
      date,
      scene,
      points,
      entities = [],
      retrievalText,
      action,
      existingImpression,
      originType = 'standalone',
      sourceImpressionId = null,
      rootImpressionId = null,
    } = params;

    const normalizedScene = normalizeScene(scene);
    const normalizedPoints = normalizePoints(points);
    const normalizedEntities = Array.from(new Set(
      (entities || [])
        .map((entity) => String(entity || '').replace(/\s+/g, ' ').trim().substring(0, 48))
        .filter(Boolean),
    )).slice(0, 8);
    const normalizedRetrievalText = normalizeRetrievalText(retrievalText);
    const content = composeLegacyContent(normalizedScene, normalizedPoints);

    if (!normalizedScene || !normalizedPoints.length || !normalizedRetrievalText) {
      console.log('[Qdrant] Skipping empty impression');
      return null;
    }

    const qdrantUrl = this.getQdrantUrl();
    const collection = this.getCollectionName();
    const embedding = await this.dashscopeService.getEmbedding(normalizedRetrievalText);
    const now = new Date().toISOString();

    const pointId = action === 'create' ? randomUUID() : impressionId!;
    const createdAt = action === 'update' ? (existingImpression?.createdAt || now) : now;
    const memoryDate = action === 'update'
      ? (existingImpression?.memoryDate || date)
      : date;
    const payloadOriginType = action === 'update'
      ? normalizeOriginType(existingImpression?.originType)
      : originType;
    const payloadSourceImpressionId = action === 'update'
      ? (existingImpression?.sourceImpressionId ?? sourceImpressionId)
      : sourceImpressionId;
    const payloadRootImpressionId = action === 'update'
      ? (existingImpression?.rootImpressionId || rootImpressionId || pointId)
      : (rootImpressionId || pointId);
    const salienceScore = action === 'update'
      ? bumpSalienceScore(existingImpression?.salienceScore)
      : INITIAL_SALIENCE_SCORE;
    const resolvedSessionId = action === 'update'
      ? (existingImpression?.sessionId || sessionId || null)
      : (sessionId || null);

    try {
      await axios.put(
        `${qdrantUrl}/collections/${collection}/points`,
        {
          points: [
            {
              id: pointId,
              vector: embedding,
              payload: {
                userId,
                sessionId: resolvedSessionId,
                memoryDate,
                date: memoryDate,
                scene: normalizedScene,
                points: normalizedPoints,
                entities: normalizedEntities,
                retrievalText: normalizedRetrievalText,
                content,
                createdAt,
                updatedAt: now,
                salienceScore,
                lastActivatedAt: now,
                originType: payloadOriginType,
                sourceImpressionId: payloadSourceImpressionId,
                rootImpressionId: payloadRootImpressionId,
              },
            },
          ],
        },
      );
      console.log(`[Qdrant] ${action === 'create' ? 'Created' : 'Updated'} impression: ${pointId}`);
      return {
        id: pointId,
        scene: normalizedScene,
        points: normalizedPoints,
        entities: normalizedEntities,
        retrievalText: normalizedRetrievalText,
        content,
        createdAt,
        updatedAt: now,
        sessionId: resolvedSessionId,
        memoryDate,
        originType: payloadOriginType,
        sourceImpressionId: payloadSourceImpressionId,
        rootImpressionId: payloadRootImpressionId,
        salienceScore,
        lastActivatedAt: now,
      };
    } catch (error: any) {
      console.error('[Qdrant] Upsert error:', error?.message);
      return null;
    }
  }

  private resolveMessageIds(messages: ChatMessage[]): number[] {
    return messages
      .map((message) => message.messageId)
      .filter((messageId): messageId is number => Number.isInteger(messageId));
  }

  private async createOrUpdateImpression(params: {
    userId: number;
    sessionId?: string;
    batchMemoryDate: string;
    batchId: string;
    finalImpression: FinalImpressionDraft;
    sourceImpression?: Impression;
    linkedMessages: ChatMessage[];
  }): Promise<'created' | 'updated' | 'skipped'> {
    const {
      userId,
      sessionId,
      batchMemoryDate,
      batchId,
      finalImpression,
      sourceImpression,
      linkedMessages,
    } = params;

    if (!finalImpression.scene.trim() || !finalImpression.points.length || !finalImpression.retrievalText.trim()) {
      return 'skipped';
    }

    let targetImpression: Impression | null = null;

    if (!sourceImpression) {
      targetImpression = await this.upsertImpression({
        userId,
        sessionId,
        date: batchMemoryDate,
        scene: finalImpression.scene,
        points: finalImpression.points,
        entities: finalImpression.entities,
        retrievalText: finalImpression.retrievalText,
        action: 'create',
        originType: 'standalone',
        sourceImpressionId: null,
        rootImpressionId: null,
      });
      if (!targetImpression) {
        return 'skipped';
      }
    } else {
      const isLeaf = await this.isLeafImpression(userId, sourceImpression.id);
      const canUpdate = shouldUpdateExistingImpression(sourceImpression, isLeaf, batchMemoryDate);

      if (canUpdate) {
        targetImpression = await this.upsertImpression({
          impressionId: sourceImpression.id,
          userId,
          sessionId,
          date: batchMemoryDate,
          scene: finalImpression.scene,
          points: finalImpression.points,
          entities: finalImpression.entities,
          retrievalText: finalImpression.retrievalText,
          action: 'update',
          existingImpression: sourceImpression,
        });
        if (!targetImpression) {
          return 'skipped';
        }
      } else {
        targetImpression = await this.upsertImpression({
          userId,
          sessionId,
          date: batchMemoryDate,
          scene: finalImpression.scene,
          points: finalImpression.points,
          entities: finalImpression.entities,
          retrievalText: finalImpression.retrievalText,
          action: 'create',
          originType: 'continued',
          sourceImpressionId: sourceImpression.id,
          rootImpressionId: sourceImpression.rootImpressionId || sourceImpression.id,
        });
        if (!targetImpression) {
          return 'skipped';
        }

        await this.recordImpressionEdge(
          userId,
          sourceImpression.id,
          targetImpression.id,
          batchId,
        );
      }
    }

    await this.recordImpressionMessageLinks(
      targetImpression.id,
      this.resolveMessageIds(linkedMessages),
      batchId,
    );

    return targetImpression.id === sourceImpression?.id ? 'updated' : 'created';
  }

  async processSummaryJob(data: SummaryJobData): Promise<void> {
    const { userId, sessionId, date, batchId, messages } = data;
    const startedAt = Date.now();
    const historyMessages = messages.filter((message) => message.isNew === false);
    const newMessages = messages.filter((message) => message.isNew !== false);

    console.log(`[Worker] Processing job ${batchId} for user ${userId}${sessionId ? `, session ${sessionId}` : ''}`);
    console.log(`[Worker] Messages: ${messages.length}, New messages: ${newMessages.length}, MemoryDate: ${date}`);

    await this.ensureCollection();

    const recentActivatedImpressions = await this.selectNode1RecentSupportImpressions(
      batchId,
      userId,
      messages,
    );
    const drafts = await this.dashscopeService.generateRetrievalDrafts({
      messages,
      recentActivatedImpressions,
    });
    console.log(
      `[Worker][Node1] batch=${batchId} recentSupport=${recentActivatedImpressions.length} history="${drafts.historyRetrievalDraft.substring(0, 120)}" delta="${drafts.deltaRetrievalDraft.substring(0, 120)}" merged="${drafts.mergedRetrievalDraft.substring(0, 120)}"`,
    );

    const recalledImpressions = await this.recallImpressionsForDrafts(userId, drafts);
    console.log(
      `[Worker][Recall] batch=${batchId} recalled=${recalledImpressions.length} scenes=${recalledImpressions.map((item) => item.scene).join(' | ')}`,
    );

    const candidateImpressions = await this.dashscopeService.generateCandidateImpressions({
      historyMessages,
      newMessages,
      oldImpressions: recalledImpressions,
    });
    console.log(
      `[Worker][Node2Candidate] batch=${batchId} history=${historyMessages.length} new=${newMessages.length} candidates=${candidateImpressions.length} scenes=${candidateImpressions.map((item) => item.scene).join(' | ')}`,
    );

    const finalImpressions = await this.dashscopeService.generateFinalImpressions({
      historyMessages,
      newMessages,
      oldImpressions: recalledImpressions,
      candidateImpressions,
    });
    console.log(`[Worker][Node2Reconcile] batch=${batchId} impressions=${finalImpressions.length}`);

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const [index, finalImpression] of finalImpressions.entries()) {
      const sourceImpression = finalImpression.sourceImpressionId
        ? recalledImpressions.find((impression) => impression.id === finalImpression.sourceImpressionId)
        : undefined;

      console.log(
        `[Worker][Persist] batch=${batchId} impression=${index + 1} scene=${finalImpression.scene} source=${sourceImpression?.id || 'null'}`,
      );

      const result = await this.createOrUpdateImpression({
        userId,
        sessionId,
        batchMemoryDate: date,
        batchId,
        finalImpression,
        sourceImpression,
        linkedMessages: newMessages,
      });

      if (result === 'created') {
        created += 1;
      } else if (result === 'updated') {
        updated += 1;
      } else {
        skipped += 1;
      }
    }

    console.log(
      `[Worker] Finished batch ${batchId}: created=${created}, updated=${updated}, skipped=${skipped}, duration=${Date.now() - startedAt}ms`,
    );
  }
}
