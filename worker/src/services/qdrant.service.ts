import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  ChatMessageInput,
  DashscopeService,
  LineImpressionDraft,
  MemoryLineCandidate,
  MemoryPointOp,
  Node2PointDraft,
  RetrievedMemoryPoint,
  RetrievalDrafts,
} from './dashscope.service';
import {
  bumpSalienceScore,
  computeEffectiveScore,
  INITIAL_SALIENCE_SCORE,
} from './impression-logic.util';

export interface ChatMessage extends ChatMessageInput {}

export interface SummaryJobData {
  openId: string;
  sessionId?: string;
  date: string;
  batchId: string;
  messages: ChatMessage[];
}

interface BackendLineRecord extends MemoryLineCandidate {
  openId?: string;
  sessionId?: string | null;
  impressionVersion?: number;
  createdAt?: string;
  updatedAt?: string;
}

interface BackendPointRecord {
  id: string;
  openId: string;
  sessionId: string | null;
  lineId: string;
  op: MemoryPointOp;
  sourcePointId: string | null;
  text: string;
  memoryDate: string;
  salienceScore: number;
  createdAt: string;
  updatedAt: string;
}

interface CandidateLineAccumulator extends MemoryLineCandidate {
  recallScore: number;
  sourceKinds: Set<'recent' | 'keyword' | 'vector'>;
}

type DraftKind = 'history' | 'delta' | 'merged';

interface RecallBucket {
  kind: DraftKind;
  query: string;
  points: RetrievedMemoryPoint[];
}

interface QdrantLeafPayload {
  openId: string;
  sessionId: string | null;
  lineId: string;
  op: MemoryPointOp;
  sourcePointId: string | null;
  text: string;
  memoryDate: string;
  salienceScore: number;
  createdAt: string;
  updatedAt: string;
  anchorLabel: string;
  impressionLabel: string;
  impressionAbstract: string;
  impressionVersion: number;
  lineSalienceScore: number;
  lineLastActivatedAt: string;
  lineCreatedAt: string;
  lineUpdatedAt: string;
}

const DRAFT_WEIGHTS: Record<DraftKind, number> = {
  merged: 1,
  delta: 0.8,
  history: 0.6,
};

const QUERY_RECALL_LIMIT = 8;
const FINAL_RECALL_LIMIT = 8;
const CANDIDATE_LINE_LIMIT = 8;
const RECENT_LINE_LIMIT = 10;
const KEYWORD_LINE_LIMIT = 10;

function normalizeText(value: string, maxLength: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function buildLineCandidate(line: BackendLineRecord): MemoryLineCandidate {
  return {
    id: line.id,
    anchorLabel: normalizeText(line.anchorLabel || '', 120),
    impressionLabel: normalizeText(line.impressionLabel || line.anchorLabel || '', 120),
    impressionAbstract: normalizeText(line.impressionAbstract || '', 360),
    salienceScore: Number(line.salienceScore || INITIAL_SALIENCE_SCORE),
    lastActivatedAt: line.lastActivatedAt || line.updatedAt || line.createdAt || new Date().toISOString(),
  };
}

@Injectable()
export class QdrantService {
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

  private getBackendInternalApiKey(): string {
    return this.configService.get<string>('backend.internalApiKey')!;
  }

  private getBackendRequestConfig() {
    const apiKey = this.getBackendInternalApiKey();
    return {
      headers: {
        'x-api-key': apiKey,
      },
    };
  }

  private getEmbeddingDim(): number {
    return this.configService.get<number>('dashscope.embeddingDim')!;
  }

  private mapPointHit(point: any): RetrievedMemoryPoint {
    const payload = (point?.payload || {}) as Partial<QdrantLeafPayload>;
    const line = buildLineCandidate({
      id: String(payload.lineId || ''),
      anchorLabel: String(payload.anchorLabel || ''),
      impressionLabel: String(payload.impressionLabel || payload.anchorLabel || ''),
      impressionAbstract: String(payload.impressionAbstract || ''),
      salienceScore: Number(payload.lineSalienceScore || payload.salienceScore || INITIAL_SALIENCE_SCORE),
      lastActivatedAt: String(payload.lineLastActivatedAt || payload.updatedAt || payload.createdAt || ''),
    });

    return {
      id: String(point.id),
      lineId: String(payload.lineId || ''),
      op: ['new', 'supplement', 'revise', 'conflict'].includes(String(payload.op))
        ? payload.op as MemoryPointOp
        : 'new',
      sourcePointId: payload.sourcePointId ? String(payload.sourcePointId) : null,
      text: normalizeText(String(payload.text || ''), 220),
      memoryDate: String(payload.memoryDate || ''),
      salienceScore: Number(payload.salienceScore || INITIAL_SALIENCE_SCORE),
      createdAt: String(payload.createdAt || ''),
      updatedAt: String(payload.updatedAt || ''),
      sessionId: payload.sessionId ? String(payload.sessionId) : null,
      relevanceScore: Number(point.score || 0),
      line,
    };
  }

  async ensureCollection(): Promise<void> {
    const qdrantUrl = this.getQdrantUrl();
    const collection = this.getCollectionName();
    const dim = this.getEmbeddingDim();

    try {
      await axios.get(`${qdrantUrl}/collections/${collection}`);
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

  private async searchPoints(
    openId: string,
    query: string,
    limit: number,
  ): Promise<RetrievedMemoryPoint[]> {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) {
      return [];
    }

    const embedding = await this.dashscopeService.getEmbedding(normalizedQuery);
    const response = await axios.post(
      `${this.getQdrantUrl()}/collections/${this.getCollectionName()}/points/search`,
      {
        vector: embedding,
        limit,
        with_payload: true,
        filter: {
          must: [
            {
              key: 'openId',
              match: { value: openId },
            },
          ],
        },
      },
    );

    return (response.data.result || []).map((point: any) => this.mapPointHit(point));
  }

  private async getPointById(pointId: string): Promise<RetrievedMemoryPoint | null> {
    if (!pointId) {
      return null;
    }

    const response = await axios.post(
      `${this.getQdrantUrl()}/collections/${this.getCollectionName()}/points`,
      {
        ids: [pointId],
        with_payload: true,
      },
    );
    const raw = response.data.result;
    const points = Array.isArray(raw) ? raw : raw?.points || [];
    return points[0] ? this.mapPointHit(points[0]) : null;
  }

  private async getLeafPointsForLine(lineId: string): Promise<RetrievedMemoryPoint[]> {
    if (!lineId) {
      return [];
    }

    const response = await axios.post(
      `${this.getQdrantUrl()}/collections/${this.getCollectionName()}/points/scroll`,
      {
        limit: 50,
        with_payload: true,
        filter: {
          must: [
            {
              key: 'lineId',
              match: { value: lineId },
            },
          ],
        },
      },
    );

    return (response.data.result?.points || []).map((point: any) => this.mapPointHit(point));
  }

  private async upsertLeafPoint(point: BackendPointRecord, line: BackendLineRecord): Promise<void> {
    const embedding = await this.dashscopeService.getEmbedding(point.text);
    const payload: QdrantLeafPayload = {
      openId: point.openId,
      sessionId: point.sessionId,
      lineId: point.lineId,
      op: point.op,
      sourcePointId: point.sourcePointId,
      text: point.text,
      memoryDate: point.memoryDate,
      salienceScore: point.salienceScore,
      createdAt: point.createdAt,
      updatedAt: point.updatedAt,
      anchorLabel: line.anchorLabel,
      impressionLabel: line.impressionLabel || line.anchorLabel,
      impressionAbstract: line.impressionAbstract || '',
      impressionVersion: Number(line.impressionVersion || 1),
      lineSalienceScore: Number(line.salienceScore || INITIAL_SALIENCE_SCORE),
      lineLastActivatedAt: line.lastActivatedAt || line.updatedAt || line.createdAt || new Date().toISOString(),
      lineCreatedAt: line.createdAt || new Date().toISOString(),
      lineUpdatedAt: line.updatedAt || new Date().toISOString(),
    };

    await axios.put(
      `${this.getQdrantUrl()}/collections/${this.getCollectionName()}/points`,
      {
        points: [
          {
            id: point.id,
            vector: embedding,
            payload,
          },
        ],
      },
    );
  }

  private async patchLeafPointPayloads(
    pointIds: string[],
    patch: Partial<QdrantLeafPayload>,
  ): Promise<void> {
    const uniquePointIds = Array.from(new Set(pointIds.filter(Boolean)));
    if (!uniquePointIds.length) {
      return;
    }

    await axios.post(
      `${this.getQdrantUrl()}/collections/${this.getCollectionName()}/points/payload`,
      {
        points: uniquePointIds,
        payload: patch,
      },
    );
  }

  private async deleteLeafPoint(pointId: string): Promise<void> {
    if (!pointId) {
      return;
    }

    await axios.post(
      `${this.getQdrantUrl()}/collections/${this.getCollectionName()}/points/delete`,
      {
        points: [pointId],
      },
    );
  }

  private async getRecentLines(openId: string, limit = RECENT_LINE_LIMIT): Promise<BackendLineRecord[]> {
    const response = await axios.post(
      `${this.getBackendInternalUrl()}/internal/memory/lines/recent`,
      { openId, limit },
      this.getBackendRequestConfig(),
    );
    return Array.isArray(response.data) ? response.data : [];
  }

  private async searchLinesByKeywords(openId: string, query: string, limit = KEYWORD_LINE_LIMIT): Promise<BackendLineRecord[]> {
    const response = await axios.post(
      `${this.getBackendInternalUrl()}/internal/memory/lines/keyword-search`,
      { openId, query, limit },
      this.getBackendRequestConfig(),
    );
    return Array.isArray(response.data) ? response.data : [];
  }

  private async getLinesByIds(lineIds: string[]): Promise<BackendLineRecord[]> {
    const response = await axios.post(
      `${this.getBackendInternalUrl()}/internal/memory/lines/by-ids`,
      { lineIds },
      this.getBackendRequestConfig(),
    );
    return Array.isArray(response.data) ? response.data : [];
  }

  private async getLeafPointsByLineIds(lineIds: string[]): Promise<Record<string, BackendPointRecord[]>> {
    const response = await axios.post(
      `${this.getBackendInternalUrl()}/internal/memory/lines/leaf-points`,
      { lineIds },
      this.getBackendRequestConfig(),
    );
    return response.data || {};
  }

  private async createLine(params: {
    openId: string;
    sessionId?: string;
    anchorLabel: string;
  }): Promise<BackendLineRecord> {
    const response = await axios.post(
      `${this.getBackendInternalUrl()}/internal/memory/lines`,
      {
        openId: params.openId,
        sessionId: params.sessionId || null,
        anchorLabel: params.anchorLabel,
        impressionLabel: params.anchorLabel,
        impressionAbstract: '',
        salienceScore: INITIAL_SALIENCE_SCORE,
      },
      this.getBackendRequestConfig(),
    );
    return response.data as BackendLineRecord;
  }

  private async updateLineImpression(
    lineId: string,
    impression: LineImpressionDraft,
    salienceScore: number,
  ): Promise<BackendLineRecord | null> {
    const response = await axios.patch(
      `${this.getBackendInternalUrl()}/internal/memory/lines/${lineId}/impression`,
      {
        impressionLabel: impression.impressionLabel,
        impressionAbstract: impression.impressionAbstract,
        salienceScore,
        lastActivatedAt: new Date().toISOString(),
      },
      this.getBackendRequestConfig(),
    );
    return response.data || null;
  }

  private async createPoint(params: {
    openId: string;
    sessionId?: string;
    lineId: string;
    op: MemoryPointOp;
    sourcePointId: string | null;
    text: string;
    memoryDate: string;
    salienceScore: number;
  }): Promise<BackendPointRecord> {
    const response = await axios.post(
      `${this.getBackendInternalUrl()}/internal/memory/points`,
      {
        openId: params.openId,
        sessionId: params.sessionId || null,
        lineId: params.lineId,
        op: params.op,
        sourcePointId: params.sourcePointId,
        text: params.text,
        memoryDate: params.memoryDate,
        salienceScore: params.salienceScore,
      },
      this.getBackendRequestConfig(),
    );
    return response.data as BackendPointRecord;
  }

  private async updatePointInPlace(params: {
    pointId: string;
    text: string;
    batchId: string;
    salienceScore: number;
  }): Promise<BackendPointRecord | null> {
    const response = await axios.patch(
      `${this.getBackendInternalUrl()}/internal/memory/points/${params.pointId}`,
      {
        text: params.text,
        batchId: params.batchId,
        salienceScore: params.salienceScore,
      },
      this.getBackendRequestConfig(),
    );
    return response.data || null;
  }

  private async recordPointMessageLinks(pointId: string, messageIds: number[], batchId: string): Promise<void> {
    const uniqueMessageIds = Array.from(
      new Set((messageIds || []).map((messageId) => Number(messageId)).filter(Number.isInteger)),
    );
    if (!pointId || !uniqueMessageIds.length) {
      return;
    }

    await axios.post(
      `${this.getBackendInternalUrl()}/internal/memory/point-message-links`,
      {
        pointId,
        messageIds: uniqueMessageIds,
        batchId,
      },
      this.getBackendRequestConfig(),
    );
  }

  private sortRecalledPoints(points: RetrievedMemoryPoint[]): RetrievedMemoryPoint[] {
    return [...points].sort((left, right) => {
      const rightScore = computeEffectiveScore({
        id: right.id,
        createdAt: right.createdAt,
        updatedAt: right.updatedAt,
        salienceScore: right.salienceScore,
        lastActivatedAt: right.line.lastActivatedAt || right.updatedAt || right.createdAt,
        relevanceScore: right.relevanceScore || 0,
      });
      const leftScore = computeEffectiveScore({
        id: left.id,
        createdAt: left.createdAt,
        updatedAt: left.updatedAt,
        salienceScore: left.salienceScore,
        lastActivatedAt: left.line.lastActivatedAt || left.updatedAt || left.createdAt,
        relevanceScore: left.relevanceScore || 0,
      });
      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }

      return new Date(right.updatedAt || right.createdAt).getTime()
        - new Date(left.updatedAt || left.createdAt).getTime();
    });
  }

  private async recallPointsForDrafts(openId: string, drafts: RetrievalDrafts): Promise<RetrievedMemoryPoint[]> {
    const buckets: RecallBucket[] = [];

    for (const draft of [
      { kind: 'history' as const, query: drafts.historyRetrievalDraft },
      { kind: 'delta' as const, query: drafts.deltaRetrievalDraft },
      { kind: 'merged' as const, query: drafts.mergedRetrievalDraft },
    ]) {
      const normalizedQuery = String(draft.query || '').trim();
      if (!normalizedQuery) {
        continue;
      }

      const points = await this.searchPoints(openId, normalizedQuery, QUERY_RECALL_LIMIT);
      buckets.push({ kind: draft.kind, query: normalizedQuery, points });
    }

    const merged = new Map<string, RetrievedMemoryPoint>();
    for (const bucket of buckets) {
      const weight = DRAFT_WEIGHTS[bucket.kind];
      for (const point of bucket.points) {
        const weightedScore = Number(((point.relevanceScore || 0) * weight).toFixed(6));
        const existing = merged.get(point.id);
        if (!existing || weightedScore > (existing.relevanceScore || 0)) {
          merged.set(point.id, {
            ...point,
            relevanceScore: weightedScore,
          });
        }
      }
    }

    return this.sortRecalledPoints(Array.from(merged.values())).slice(0, FINAL_RECALL_LIMIT);
  }

  private upsertCandidateLine(
    bucket: Map<string, CandidateLineAccumulator>,
    line: MemoryLineCandidate,
    sourceKind: 'recent' | 'keyword' | 'vector',
    score: number,
  ): void {
    const existing = bucket.get(line.id);
    if (existing) {
      existing.recallScore = Math.max(existing.recallScore, score);
      existing.sourceKinds.add(sourceKind);
      return;
    }

    bucket.set(line.id, {
      ...line,
      recallScore: score,
      sourceKinds: new Set([sourceKind]),
    });
  }

  private async recallCandidateLines(
    openId: string,
    pointText: string,
  ): Promise<MemoryLineCandidate[]> {
    const [recentLines, keywordLines, vectorPoints] = await Promise.all([
      this.getRecentLines(openId, RECENT_LINE_LIMIT),
      this.searchLinesByKeywords(openId, pointText, KEYWORD_LINE_LIMIT),
      this.searchPoints(openId, pointText, QUERY_RECALL_LIMIT),
    ]);

    const bucket = new Map<string, CandidateLineAccumulator>();

    for (const line of recentLines) {
      this.upsertCandidateLine(bucket, buildLineCandidate(line), 'recent', 0.2);
    }

    for (const line of keywordLines) {
      this.upsertCandidateLine(bucket, buildLineCandidate(line), 'keyword', 0.45);
    }

    const bestVectorScoreByLine = new Map<string, RetrievedMemoryPoint>();
    for (const point of vectorPoints) {
      const existing = bestVectorScoreByLine.get(point.lineId);
      if (!existing || (point.relevanceScore || 0) > (existing.relevanceScore || 0)) {
        bestVectorScoreByLine.set(point.lineId, point);
      }
    }

    for (const point of bestVectorScoreByLine.values()) {
      this.upsertCandidateLine(
        bucket,
        point.line,
        'vector',
        Number((point.relevanceScore || 0).toFixed(6)),
      );
    }

    return Array.from(bucket.values())
      .sort((left, right) => {
        if (right.recallScore !== left.recallScore) {
          return right.recallScore - left.recallScore;
        }

        return new Date(right.lastActivatedAt).getTime() - new Date(left.lastActivatedAt).getTime();
      })
      .slice(0, CANDIDATE_LINE_LIMIT)
      .map((line) => ({
        id: line.id,
        anchorLabel: line.anchorLabel,
        impressionLabel: line.impressionLabel,
        impressionAbstract: line.impressionAbstract,
        salienceScore: line.salienceScore,
        lastActivatedAt: line.lastActivatedAt,
      }));
  }

  private resolveMessageIds(messages: ChatMessage[]): number[] {
    return messages
      .map((message) => message.messageId)
      .filter((messageId): messageId is number => Number.isInteger(messageId));
  }

  private async rebuildDirtyLines(dirtyLineIds: Set<string>): Promise<void> {
    const lineIds = Array.from(dirtyLineIds);
    if (!lineIds.length) {
      return;
    }

    const [lines, leafPointsByLineId] = await Promise.all([
      this.getLinesByIds(lineIds),
      this.getLeafPointsByLineIds(lineIds),
    ]);
    const lineById = new Map(lines.map((line) => [line.id, line]));

    for (const lineId of lineIds) {
      const line = lineById.get(lineId);
      const leafPoints = leafPointsByLineId[lineId] || [];
      if (!line || !leafPoints.length) {
        continue;
      }

      const impression = await this.dashscopeService.rebuildLineImpression({
        anchorLabel: line.anchorLabel,
        leafPoints: leafPoints.map((point) => point.text),
      });
      const nextLine = await this.updateLineImpression(
        lineId,
        impression,
        bumpSalienceScore(line.salienceScore),
      );

      if (!nextLine) {
        continue;
      }

      await this.patchLeafPointPayloads(
        leafPoints.map((point) => point.id),
        {
          anchorLabel: nextLine.anchorLabel,
          impressionLabel: nextLine.impressionLabel,
          impressionAbstract: nextLine.impressionAbstract,
          impressionVersion: Number(nextLine.impressionVersion || 1),
          lineSalienceScore: Number(nextLine.salienceScore || INITIAL_SALIENCE_SCORE),
          lineLastActivatedAt: nextLine.lastActivatedAt || new Date().toISOString(),
          lineCreatedAt: nextLine.createdAt || new Date().toISOString(),
          lineUpdatedAt: nextLine.updatedAt || new Date().toISOString(),
        },
      );
    }
  }

  private async processSourcePointDrafts(params: {
    openId: string;
    sessionId?: string;
    batchId: string;
    batchMemoryDate: string;
    linkedMessages: ChatMessage[];
    pointDrafts: Node2PointDraft[];
    recalledPoints: RetrievedMemoryPoint[];
    dirtyLineIds: Set<string>;
  }): Promise<void> {
    const recalledById = new Map(params.recalledPoints.map((point) => [point.id, point]));

    for (const draft of params.pointDrafts) {
      if (draft.op === 'new' || !draft.sourcePointId) {
        continue;
      }

      const source = recalledById.get(draft.sourcePointId)
        || await this.getPointById(draft.sourcePointId);
      if (!source) {
        continue;
      }

      const nextSalienceScore = bumpSalienceScore(source.salienceScore);
      if (source.memoryDate === params.batchMemoryDate) {
        const updatedPoint = await this.updatePointInPlace({
          pointId: source.id,
          text: draft.text,
          batchId: params.batchId,
          salienceScore: nextSalienceScore,
        });
        if (!updatedPoint) {
          continue;
        }

        await this.upsertLeafPoint(updatedPoint, source.line);
        await this.recordPointMessageLinks(
          updatedPoint.id,
          this.resolveMessageIds(params.linkedMessages),
          params.batchId,
        );
      } else {
        const createdPoint = await this.createPoint({
          openId: params.openId,
          sessionId: params.sessionId,
          lineId: source.lineId,
          op: draft.op,
          sourcePointId: source.id,
          text: draft.text,
          memoryDate: params.batchMemoryDate,
          salienceScore: INITIAL_SALIENCE_SCORE,
        });
        await this.deleteLeafPoint(source.id);
        await this.upsertLeafPoint(createdPoint, source.line);
        await this.recordPointMessageLinks(
          createdPoint.id,
          this.resolveMessageIds(params.linkedMessages),
          params.batchId,
        );
      }

      params.dirtyLineIds.add(source.lineId);
    }
  }

  private async processNewPointDrafts(params: {
    openId: string;
    sessionId?: string;
    batchId: string;
    batchMemoryDate: string;
    linkedMessages: ChatMessage[];
    pointDrafts: Node2PointDraft[];
    dirtyLineIds: Set<string>;
  }): Promise<void> {
    const unresolvedDrafts: Node2PointDraft[] = [];

    const attachmentResults = await Promise.all(
      params.pointDrafts
        .filter((draft) => draft.op === 'new' && !draft.sourcePointId)
        .map(async (draft) => {
          const candidateLines = await this.recallCandidateLines(
            params.openId,
            draft.text,
          );
          const route = await this.dashscopeService.attachPointToExistingLine({
            pointText: draft.text,
            candidateLines,
          });
          return { draft, candidateLines, route };
        }),
    );

    const lineCache = new Map<string, BackendLineRecord>();
    for (const result of attachmentResults) {
      if (!result.route.targetLineId) {
        unresolvedDrafts.push(result.draft);
        continue;
      }

      let line = lineCache.get(result.route.targetLineId);
      if (!line) {
        const matched = result.candidateLines.find(
          (candidate) => candidate.id === result.route.targetLineId,
        );
        line = matched
          ? {
              ...matched,
              impressionVersion: 1,
            }
          : (await this.getLinesByIds([result.route.targetLineId]))[0];
        if (line) {
          lineCache.set(line.id, line);
        }
      }

      if (!line) {
        unresolvedDrafts.push(result.draft);
        continue;
      }

      const createdPoint = await this.createPoint({
        openId: params.openId,
        sessionId: params.sessionId,
        lineId: line.id,
        op: 'new',
        sourcePointId: null,
        text: result.draft.text,
        memoryDate: params.batchMemoryDate,
        salienceScore: INITIAL_SALIENCE_SCORE,
      });
      await this.upsertLeafPoint(createdPoint, line);
      await this.recordPointMessageLinks(
        createdPoint.id,
        this.resolveMessageIds(params.linkedMessages),
        params.batchId,
      );
      params.dirtyLineIds.add(line.id);
    }

    if (!unresolvedDrafts.length) {
      return;
    }

    const newLinePlan = await this.dashscopeService.planNewLines({
      pointTexts: unresolvedDrafts.map((draft) => draft.text),
    });

    for (const group of newLinePlan.newLines) {
      const line = await this.createLine({
        openId: params.openId,
        sessionId: params.sessionId,
        anchorLabel: group.anchorLabel,
      });

      for (const pointIndex of group.pointIndexes) {
        const draft = unresolvedDrafts[pointIndex];
        if (!draft) {
          continue;
        }

        const createdPoint = await this.createPoint({
          openId: params.openId,
          sessionId: params.sessionId,
          lineId: line.id,
          op: 'new',
          sourcePointId: null,
          text: draft.text,
          memoryDate: params.batchMemoryDate,
          salienceScore: INITIAL_SALIENCE_SCORE,
        });
        await this.upsertLeafPoint(createdPoint, line);
        await this.recordPointMessageLinks(
          createdPoint.id,
          this.resolveMessageIds(params.linkedMessages),
          params.batchId,
        );
      }

      params.dirtyLineIds.add(line.id);
    }
  }

  async processSummaryJob(data: SummaryJobData): Promise<void> {
    const { openId, sessionId, date, batchId, messages } = data;
    const startedAt = Date.now();
    const historyMessages = messages.filter((message) => message.isNew === false);
    const newMessages = messages.filter((message) => message.isNew !== false);
    const dirtyLineIds = new Set<string>();

    console.log(`[Worker] Processing batch ${batchId} for openId ${openId}`);

    await this.ensureCollection();

    const drafts = await this.dashscopeService.generateRetrievalDrafts({
      messages,
      recentActivatedImpressions: [],
    });
    console.log(
      `[Worker][Drafts] batch=${batchId} history="${drafts.historyRetrievalDraft.substring(0, 80)}" delta="${drafts.deltaRetrievalDraft.substring(0, 80)}" merged="${drafts.mergedRetrievalDraft.substring(0, 80)}"`,
    );

    const recalledPoints = await this.recallPointsForDrafts(openId, drafts);
    console.log(
      `[Worker][RecallPoints] batch=${batchId} recalled=${recalledPoints.length} pointIds=${recalledPoints.map((point) => point.id).join(',')}`,
    );

    const node2PointResult = await this.dashscopeService.generateNode2Points({
      historyMessages,
      newMessages,
      oldPoints: recalledPoints,
    });
    const node2CandidateAnalysis = Array.isArray(node2PointResult)
      ? null
      : (node2PointResult.candidateAnalysis || null);
    const node2Points = Array.isArray(node2PointResult)
      ? node2PointResult
      : node2PointResult.points;
    console.log(
      `[Worker][Node2Points] batch=${batchId} candidateAnalysis=${JSON.stringify(node2CandidateAnalysis)} generated=${node2Points.length} drafts=${JSON.stringify(
        node2Points.map((point) => ({
          opAnalysis: point.opAnalysis || null,
          op: point.op,
          sourcePointId: point.sourcePointId,
          rewriteAnalysis: point.rewriteAnalysis || null,
          text: point.text,
        })),
      ).substring(0, 1500)}`,
    );

    await this.processSourcePointDrafts({
      openId,
      sessionId,
      batchId,
      batchMemoryDate: date,
      linkedMessages: newMessages,
      pointDrafts: node2Points,
      recalledPoints,
      dirtyLineIds,
    });

    await this.processNewPointDrafts({
      openId,
      sessionId,
      batchId,
      batchMemoryDate: date,
      linkedMessages: newMessages,
      pointDrafts: node2Points,
      dirtyLineIds,
    });

    await this.rebuildDirtyLines(dirtyLineIds);

    console.log(
      `[Worker] Finished batch ${batchId}: dirtyLines=${Array.from(dirtyLineIds).length}, duration=${Date.now() - startedAt}ms`,
    );
  }
}
