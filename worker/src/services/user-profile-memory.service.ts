import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { DashscopeService } from './dashscope.service';
import { PreferenceMemoryCandidate, ProfileMemoryPolarity, ProfileMemoryType } from './fact-extraction.service';

export interface UserProfileMemoryPayload {
  userId: number;
  type: ProfileMemoryType;
  category: string;
  subject: string;
  preference: string;
  condition?: string | null;
  reason?: string | null;
  polarity: ProfileMemoryPolarity;
  confidence: number;
  status: 'active' | 'superseded';
  sourceMessageIds: number[];
  batchId: string;
  retrievalText: string;
  createdAt: string;
  updatedAt: string;
  lastActivatedAt: string;
  supersededById?: string | null;
}

export interface UserProfileMemoryRecord extends UserProfileMemoryPayload {
  id: string;
  score: number;
}

export interface UserProfileMemoryStats {
  candidates: number;
  created: number;
  updated: number;
  superseded: number;
  discarded: number;
}

const SAME_SUBJECT_SCORE_THRESHOLD = 0.78;
const CHANGE_MARKER_RE = /(现在|不再|改成|更喜欢|以前|最近|目前|如今|转成|换成|开始不|不太|少了|减少)/;

function normalizeText(value: unknown, maxLength: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().substring(0, maxLength);
}

function normalizeKey(value: unknown): string {
  return String(value || '').replace(/\s+/g, '').trim().toLowerCase();
}

function mergeUniqueNumbers(left: number[], right: number[]): number[] {
  return Array.from(new Set([...(left || []), ...(right || [])]
    .map((item) => Number(item))
    .filter(Number.isInteger)))
    .slice(0, 20);
}

@Injectable()
export class UserProfileMemoryService {
  constructor(
    private configService: ConfigService,
    private dashscopeService: DashscopeService,
  ) {}

  async reconcileAndPersist(
    userId: number,
    batchId: string,
    candidates: PreferenceMemoryCandidate[],
  ): Promise<UserProfileMemoryStats> {
    const stats: UserProfileMemoryStats = {
      candidates: candidates.length,
      created: 0,
      updated: 0,
      superseded: 0,
      discarded: 0,
    };

    if (!candidates.length) {
      return stats;
    }

    await this.ensureProfileCollection();

    for (const candidate of candidates) {
      const existingMemories = await this.searchExistingMemories(userId, candidate);
      const decision = this.decideAction(candidate, existingMemories);

      if (decision.action === 'discard') {
        stats.discarded += 1;
        continue;
      }

      if (decision.action === 'update' && decision.existing) {
        const updated = await this.upsertMemory({
          userId,
          batchId,
          candidate,
          action: 'update',
          existing: decision.existing,
        });
        if (updated) {
          stats.updated += 1;
        } else {
          stats.discarded += 1;
        }
        continue;
      }

      if (decision.action === 'supersede' && decision.existing) {
        const created = await this.upsertMemory({
          userId,
          batchId,
          candidate,
          action: 'create',
        });
        if (created) {
          await this.markSuperseded(decision.existing.id, created.id);
          stats.created += 1;
          stats.superseded += 1;
        } else {
          stats.discarded += 1;
        }
        continue;
      }

      const created = await this.upsertMemory({
        userId,
        batchId,
        candidate,
        action: 'create',
      });
      if (created) {
        stats.created += 1;
      } else {
        stats.discarded += 1;
      }
    }

    return stats;
  }

  async ensureProfileCollection(): Promise<void> {
    const qdrantUrl = this.getQdrantUrl();
    const collection = this.getProfileCollectionName();
    const dim = this.configService.get<number>('dashscope.embeddingDim')!;

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

  private decideAction(
    candidate: PreferenceMemoryCandidate,
    existingMemories: UserProfileMemoryRecord[],
  ): {
    action: 'create' | 'update' | 'supersede' | 'discard';
    existing?: UserProfileMemoryRecord;
  } {
    const sameSubject = existingMemories.find((memory) => this.isSameCategorySubject(candidate, memory));

    if (sameSubject) {
      if (this.isDuplicate(candidate, sameSubject)) {
        return { action: 'discard', existing: sameSubject };
      }

      if (this.isConflict(candidate, sameSubject)) {
        return { action: 'supersede', existing: sameSubject };
      }

      return { action: 'update', existing: sameSubject };
    }

    const related = existingMemories.find((memory) => (
      memory.category === candidate.category
      && memory.score >= SAME_SUBJECT_SCORE_THRESHOLD
    ));

    if (related && this.hasChangeMarker(candidate)) {
      return { action: 'supersede', existing: related };
    }

    return { action: 'create' };
  }

  private isSameCategorySubject(candidate: PreferenceMemoryCandidate, memory: UserProfileMemoryRecord): boolean {
    return normalizeKey(candidate.category) === normalizeKey(memory.category)
      && normalizeKey(candidate.subject) === normalizeKey(memory.subject);
  }

  private isDuplicate(candidate: PreferenceMemoryCandidate, memory: UserProfileMemoryRecord): boolean {
    const candidateText = normalizeKey([
      candidate.preference,
      candidate.condition || '',
      candidate.reason || '',
      candidate.polarity,
    ].join('|'));
    const memoryText = normalizeKey([
      memory.preference,
      memory.condition || '',
      memory.reason || '',
      memory.polarity,
    ].join('|'));

    return candidateText === memoryText
      || (
        memoryText.includes(candidateText)
        && !(candidate.condition && normalizeKey(candidate.condition) !== normalizeKey(memory.condition))
        && !(candidate.reason && normalizeKey(candidate.reason) !== normalizeKey(memory.reason))
      );
  }

  private isConflict(candidate: PreferenceMemoryCandidate, memory: UserProfileMemoryRecord): boolean {
    const positive = new Set<ProfileMemoryPolarity>(['like', 'prefer']);
    const negative = new Set<ProfileMemoryPolarity>(['dislike', 'avoid']);
    const polarityConflict = (
      positive.has(candidate.polarity) && negative.has(memory.polarity)
    ) || (
      negative.has(candidate.polarity) && positive.has(memory.polarity)
    );

    return polarityConflict || (this.hasChangeMarker(candidate) && candidate.polarity !== memory.polarity);
  }

  private hasChangeMarker(candidate: PreferenceMemoryCandidate): boolean {
    return CHANGE_MARKER_RE.test([
      candidate.subject,
      candidate.preference,
      candidate.condition || '',
      candidate.reason || '',
    ].join(' '));
  }

  private async searchExistingMemories(
    userId: number,
    candidate: PreferenceMemoryCandidate,
  ): Promise<UserProfileMemoryRecord[]> {
    try {
      const embedding = await this.dashscopeService.getEmbedding(candidate.retrievalText);
      const response = await axios.post(
        `${this.getQdrantUrl()}/collections/${this.getProfileCollectionName()}/points/search`,
        {
          vector: embedding,
          limit: 5,
          with_payload: true,
          filter: {
            must: [
              {
                key: 'userId',
                match: { value: userId },
              },
              {
                key: 'status',
                match: { value: 'active' },
              },
            ],
          },
        },
      );

      return (response.data.result || [])
        .map((point: any) => this.mapPointToMemory(point))
        .filter((memory: UserProfileMemoryRecord | null): memory is UserProfileMemoryRecord => Boolean(memory));
    } catch (error: any) {
      console.error('[Qdrant] Profile memory search error:', error?.message);
      return [];
    }
  }

  private mapPointToMemory(point: any): UserProfileMemoryRecord | null {
    const payload = point.payload || {};
    const category = normalizeText(payload.category, 48);
    const subject = normalizeText(payload.subject, 80);
    const preference = normalizeText(payload.preference, 180);

    if (!category || !subject || !preference) {
      return null;
    }

    return {
      id: String(point.id),
      score: Number(point.score || 0),
      userId: Number(payload.userId),
      type: payload.type || 'preference',
      category,
      subject,
      preference,
      condition: payload.condition || null,
      reason: payload.reason || null,
      polarity: payload.polarity || 'neutral',
      confidence: Number(payload.confidence || 0),
      status: payload.status || 'active',
      sourceMessageIds: Array.isArray(payload.sourceMessageIds)
        ? payload.sourceMessageIds.map((item: unknown) => Number(item)).filter(Number.isInteger)
        : [],
      batchId: payload.batchId || '',
      retrievalText: payload.retrievalText || preference,
      createdAt: payload.createdAt || '',
      updatedAt: payload.updatedAt || '',
      lastActivatedAt: payload.lastActivatedAt || payload.updatedAt || payload.createdAt || '',
      supersededById: payload.supersededById || null,
    };
  }

  private async upsertMemory(params: {
    userId: number;
    batchId: string;
    candidate: PreferenceMemoryCandidate;
    action: 'create' | 'update';
    existing?: UserProfileMemoryRecord;
  }): Promise<UserProfileMemoryRecord | null> {
    const now = new Date().toISOString();
    const id = params.action === 'create' ? randomUUID() : params.existing!.id;
    const payload = this.buildPayload({
      userId: params.userId,
      batchId: params.batchId,
      candidate: params.candidate,
      existing: params.existing,
      now,
    });
    const vector = await this.dashscopeService.getEmbedding(payload.retrievalText);

    try {
      await axios.put(
        `${this.getQdrantUrl()}/collections/${this.getProfileCollectionName()}/points`,
        {
          points: [
            {
              id,
              vector,
              payload,
            },
          ],
        },
      );

      console.log(`[Qdrant] ${params.action === 'create' ? 'Created' : 'Updated'} profile memory: ${id}`);
      return {
        id,
        score: 1,
        ...payload,
      };
    } catch (error: any) {
      console.error('[Qdrant] Profile memory upsert error:', error?.message);
      return null;
    }
  }

  private buildPayload(params: {
    userId: number;
    batchId: string;
    candidate: PreferenceMemoryCandidate;
    existing?: UserProfileMemoryRecord;
    now: string;
  }): UserProfileMemoryPayload {
    const { userId, batchId, candidate, existing, now } = params;
    const condition = candidate.condition || existing?.condition || null;
    const reason = candidate.reason || existing?.reason || null;
    const retrievalText = this.buildRetrievalText({
      ...candidate,
      condition,
      reason,
    });

    return {
      userId,
      type: candidate.type || existing?.type || 'preference',
      category: normalizeText(candidate.category || existing?.category, 48),
      subject: normalizeText(candidate.subject || existing?.subject, 80),
      preference: normalizeText(candidate.preference || existing?.preference, 180),
      condition,
      reason,
      polarity: candidate.polarity || existing?.polarity || 'neutral',
      confidence: Math.max(candidate.confidence || 0, existing?.confidence || 0),
      status: 'active',
      sourceMessageIds: mergeUniqueNumbers(existing?.sourceMessageIds || [], candidate.evidenceMessageIds),
      batchId,
      retrievalText,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      lastActivatedAt: now,
      supersededById: null,
    };
  }

  private buildRetrievalText(candidate: Pick<
    PreferenceMemoryCandidate,
    'preference' | 'condition' | 'reason' | 'category' | 'subject' | 'polarity'
  >): string {
    return [
      normalizeText(candidate.preference, 180),
      candidate.condition ? `条件：${normalizeText(candidate.condition, 120)}` : '',
      candidate.reason ? `原因：${normalizeText(candidate.reason, 120)}` : '',
      `类别：${normalizeText(candidate.category, 48)}`,
      `对象：${normalizeText(candidate.subject, 80)}`,
      `倾向：${candidate.polarity}`,
    ].filter(Boolean).join('；').substring(0, 360);
  }

  private async markSuperseded(memoryId: string, supersededById: string): Promise<void> {
    try {
      await axios.post(
        `${this.getQdrantUrl()}/collections/${this.getProfileCollectionName()}/points/payload`,
        {
          payload: {
            status: 'superseded',
            updatedAt: new Date().toISOString(),
            supersededById,
          },
          points: [memoryId],
        },
      );
      console.log(`[Qdrant] Superseded profile memory: ${memoryId} -> ${supersededById}`);
    } catch (error: any) {
      console.error('[Qdrant] Profile memory supersede error:', error?.message);
    }
  }

  private getQdrantUrl(): string {
    return this.configService.get<string>('qdrant.url')!;
  }

  private getProfileCollectionName(): string {
    return this.configService.get<string>('qdrant.profileCollectionName')!;
  }
}
