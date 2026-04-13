import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { DashscopeService } from './dashscope.service';
import {
  FactMessageInput,
  PreferenceMemoryCandidate,
  ProfileMemoryType,
} from './fact-extraction.service';

export interface UserProfileMemoryPayload {
  openId: string;
  type: ProfileMemoryType;
  content: string;
  keywords: string[];
  strengthScore: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserProfileMemoryRecord extends UserProfileMemoryPayload {
  id: string;
  score: number;
  isActive?: boolean;
}

export interface UserProfileMemoryStats {
  candidates: number;
  created: number;
  covered: number;
  discarded: number;
}

interface PreferenceMemoryDecision {
  candidateId: string;
  sourceMemoryId: string | null;
  action: 'new' | 'cover';
}

interface QwenCallOptions {
  enableThinking?: boolean;
}

interface BackendPreferenceMemoryPayload {
  openId: string;
  type: ProfileMemoryType;
  content: string;
  keywords: string[];
  strengthScore: number;
  messageIds: number[];
}

const SAME_SUBJECT_SCORE_THRESHOLD = 0.78;
const DEFAULT_STRENGTH_SCORE = 1;
const MAX_STRENGTH_SCORE = 5;

function normalizeText(value: unknown, maxLength: number): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, maxLength);
}

function normalizeKey(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

function normalizeKeywords(value: unknown): string[] {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[、，,]/)
      : [];

  return Array.from(
    new Set(
      rawItems
        .map(item => normalizeText(item, 32))
        .filter(Boolean)
    )
  ).slice(0, 6);
}

@Injectable()
export class UserProfileMemoryService {
  constructor(
    private configService: ConfigService,
    private dashscopeService: DashscopeService
  ) {}

  async reconcileAndPersist(
    openId: string,
    messages: FactMessageInput[],
    candidates: PreferenceMemoryCandidate[]
  ): Promise<UserProfileMemoryStats> {
    const stats: UserProfileMemoryStats = {
      candidates: candidates.length,
      created: 0,
      covered: 0,
      discarded: 0,
    };

    if (!candidates.length) {
      return stats;
    }

    await this.ensureProfileCollection();

    const normalizedMessages = messages
      .filter(
        message => message.role === 'user' || message.role === 'assistant'
      )
      .filter(message => String(message.content || '').trim());
    const recalledByCandidate = await Promise.all(
      candidates.map(async candidate => ({
        candidate,
        existingMemories: await this.searchExistingMemories(openId, candidate),
      }))
    );
    const oldMemories = Array.from(
      new Map(
        recalledByCandidate
          .flatMap(item => item.existingMemories)
          .map(memory => [memory.id, memory])
      ).values()
    );
    const decisionList = await this.reconcileCandidates({
      messages: normalizedMessages,
      candidates,
      oldMemories,
      recalledByCandidate,
    });
    const decisionByCandidateId = new Map(
      decisionList.map(decision => [decision.candidateId, decision])
    );
    const oldMemoryById = new Map(oldMemories.map(memory => [memory.id, memory]));

    for (const candidate of candidates) {
      const decision = decisionByCandidateId.get(candidate.candidateId);
      if (!decision) {
        stats.discarded += 1;
        continue;
      }

      if (decision.action === 'cover') {
        const existing = decision.sourceMemoryId
          ? oldMemoryById.get(decision.sourceMemoryId) || null
          : null;
        if (!existing) {
          stats.discarded += 1;
          continue;
        }

        const covered = await this.coverMemory(openId, candidate, existing);
        if (covered) {
          oldMemoryById.delete(existing.id);
          oldMemoryById.set(covered.id, covered);
          stats.covered += 1;
        } else {
          stats.discarded += 1;
        }
        continue;
      }

      const created = await this.createMemory(openId, candidate);
      if (created) {
        oldMemoryById.set(created.id, created);
        stats.created += 1;
      } else {
        stats.discarded += 1;
      }
    }

    return stats;
  }

  private async reconcileCandidates(params: {
    messages: FactMessageInput[];
    candidates: PreferenceMemoryCandidate[];
    oldMemories: UserProfileMemoryRecord[];
    recalledByCandidate: Array<{
      candidate: PreferenceMemoryCandidate;
      existingMemories: UserProfileMemoryRecord[];
    }>;
  }): Promise<PreferenceMemoryDecision[]> {
    if (!params.candidates.length) {
      return [];
    }

    try {
      const raw = await this.callQwenJson(
        this.getPreferenceReconcileSystemPrompt(),
        this.buildPreferenceReconcilePrompt(params),
        { enableThinking: true }
      );
      return this.normalizeReconcileDecisions(
        raw,
        params.candidates,
        params.oldMemories
      );
    } catch (error: any) {
      console.error(
        '[ProfileMemory] Preference reconcile error:',
        error?.message || error
      );
      return this.buildFallbackDecisions(params.recalledByCandidate);
    }
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
    existingMemories: UserProfileMemoryRecord[]
  ): 'new' | 'cover' | 'discard' {
    const sameCore = existingMemories.find(memory =>
      this.isSameSemanticCore(candidate, memory)
    );

    if (sameCore) {
      return this.isDuplicate(candidate, sameCore) ? 'discard' : 'cover';
    }

    const related = existingMemories.find(
      memory =>
        this.hasKeywordOverlap(candidate.keywords, memory.keywords) &&
        memory.score >= SAME_SUBJECT_SCORE_THRESHOLD
    );

    if (related) {
      return 'cover';
    }

    return 'new';
  }

  private isSameSemanticCore(
    candidate: PreferenceMemoryCandidate,
    memory: UserProfileMemoryRecord
  ): boolean {
    const candidateContent = normalizeKey(candidate.content);
    const memoryContent = normalizeKey(memory.content);

    if (!candidateContent || !memoryContent) {
      return false;
    }

    return (
      candidateContent === memoryContent ||
      candidateContent.includes(memoryContent) ||
      memoryContent.includes(candidateContent) ||
      this.keywordOverlapScore(candidate.keywords, memory.keywords) >= 0.6
    );
  }

  private isDuplicate(
    candidate: PreferenceMemoryCandidate,
    memory: UserProfileMemoryRecord
  ): boolean {
    const candidateText = normalizeKey(candidate.content);
    const memoryText = normalizeKey(memory.content);

    return (
      candidateText === memoryText ||
      (this.keywordOverlapScore(candidate.keywords, memory.keywords) >= 0.85 &&
        (memoryText.includes(candidateText) ||
          candidateText.includes(memoryText)))
    );
  }

  private hasKeywordOverlap(left: string[], right: string[]): boolean {
    return this.keywordOverlapScore(left, right) > 0;
  }

  private keywordOverlapScore(left: string[], right: string[]): number {
    const leftSet = new Set(left.map(item => normalizeKey(item)).filter(Boolean));
    const rightSet = new Set(right.map(item => normalizeKey(item)).filter(Boolean));

    if (!leftSet.size || !rightSet.size) {
      return 0;
    }

    const intersection = Array.from(leftSet).filter(item => rightSet.has(item)).length;
    return intersection / Math.max(leftSet.size, rightSet.size);
  }

  private async searchExistingMemories(
    openId: string,
    candidate: PreferenceMemoryCandidate
  ): Promise<UserProfileMemoryRecord[]> {
    try {
      const embedding = await this.dashscopeService.getEmbedding(
        this.buildEmbeddingText(candidate)
      );
      const response = await axios.post(
        `${this.getQdrantUrl()}/collections/${this.getProfileCollectionName()}/points/search`,
        {
          vector: embedding,
          limit: 5,
          with_payload: true,
          filter: {
            must: [
              {
                key: 'openId',
                match: { value: openId },
              },
            ],
          },
        }
      );

      return (response.data.result || [])
        .map((point: any) => this.mapPointToMemory(point))
        .filter(
          (memory: UserProfileMemoryRecord | null): memory is UserProfileMemoryRecord =>
            Boolean(memory)
        );
    } catch (error: any) {
      console.error('[Qdrant] Profile memory search error:', error?.message);
      return [];
    }
  }

  private mapPointToMemory(point: any): UserProfileMemoryRecord | null {
    const payload = point.payload || {};
    const content = normalizeText(payload.content || payload.preference, 200);
    const keywords = normalizeKeywords(payload.keywords);

    if (!content) {
      return null;
    }

    return {
      id: String(point.id),
      score: Number(point.score || 0),
      openId: String(payload.openId || ''),
      type:
        payload.type === 'habit' ||
        payload.type === 'constraint' ||
        payload.type === 'goal'
          ? payload.type
          : 'preference',
      content,
      keywords,
      strengthScore: Number(payload.strengthScore || DEFAULT_STRENGTH_SCORE),
      createdAt: String(payload.createdAt || ''),
      updatedAt: String(payload.updatedAt || ''),
    };
  }

  private async createMemory(
    openId: string,
    candidate: PreferenceMemoryCandidate
  ): Promise<UserProfileMemoryRecord | null> {
    const memory = await this.createBackendMemory({
      openId,
      type: candidate.type,
      content: candidate.content,
      keywords: candidate.keywords,
      strengthScore: DEFAULT_STRENGTH_SCORE,
      messageIds: candidate.evidenceMessageIds,
    });
    if (!memory) {
      return null;
    }

    return this.upsertQdrantMemory(memory);
  }

  private async coverMemory(
    openId: string,
    candidate: PreferenceMemoryCandidate,
    existing: UserProfileMemoryRecord
  ): Promise<UserProfileMemoryRecord | null> {
    const result = await this.coverBackendMemory(existing.id, {
      openId,
      type: candidate.type,
      content: candidate.content,
      keywords: candidate.keywords,
      strengthScore: this.computeStrengthScore(candidate, existing),
      messageIds: candidate.evidenceMessageIds,
    });
    if (!result) {
      return null;
    }

    await this.deleteQdrantMemory(result.previousId);
    return this.upsertQdrantMemory(result.next);
  }

  private async createBackendMemory(
    payload: BackendPreferenceMemoryPayload
  ): Promise<UserProfileMemoryRecord | null> {
    try {
      const response = await axios.post(
        `${this.getBackendInternalUrl()}/internal/user-profiles/preference-memories`,
        payload,
        {
          headers: this.getBackendHeaders(),
        }
      );

      return this.normalizeBackendMemory(response.data);
    } catch (error: any) {
      console.error('[ProfileMemory] Create backend memory error:', error?.message);
      return null;
    }
  }

  private async coverBackendMemory(
    preferenceId: string,
    payload: BackendPreferenceMemoryPayload
  ): Promise<{ previousId: string; next: UserProfileMemoryRecord } | null> {
    try {
      const response = await axios.post(
        `${this.getBackendInternalUrl()}/internal/user-profiles/preference-memories/${preferenceId}/cover`,
        payload,
        {
          headers: this.getBackendHeaders(),
        }
      );

      const previousId = String(response.data?.previousId || '').trim();
      const next = this.normalizeBackendMemory(response.data?.next);
      if (!previousId || !next) {
        return null;
      }

      return { previousId, next };
    } catch (error: any) {
      console.error('[ProfileMemory] Cover backend memory error:', error?.message);
      return null;
    }
  }

  private async upsertQdrantMemory(
    memory: UserProfileMemoryRecord
  ): Promise<UserProfileMemoryRecord | null> {
    const vector = await this.dashscopeService.getEmbedding(
      this.buildEmbeddingText(memory)
    );

    try {
      await axios.put(
        `${this.getQdrantUrl()}/collections/${this.getProfileCollectionName()}/points`,
        {
          points: [
            {
              id: memory.id,
              vector,
              payload: this.buildPayload(memory),
            },
          ],
        }
      );

      console.log(`[Qdrant] Upserted profile memory: ${memory.id}`);
      return memory;
    } catch (error: any) {
      console.error('[Qdrant] Profile memory upsert error:', error?.message);
      return null;
    }
  }

  private async deleteQdrantMemory(id: string): Promise<void> {
    try {
      await axios.post(
        `${this.getQdrantUrl()}/collections/${this.getProfileCollectionName()}/points/delete?wait=true`,
        {
          points: [id],
        }
      );
    } catch (error: any) {
      console.error('[Qdrant] Profile memory delete error:', error?.message);
    }
  }

  private buildPayload(memory: UserProfileMemoryRecord): UserProfileMemoryPayload {
    return {
      openId: memory.openId,
      type: memory.type,
      content: normalizeText(memory.content, 200),
      keywords: normalizeKeywords(memory.keywords),
      strengthScore: Number(memory.strengthScore || DEFAULT_STRENGTH_SCORE),
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
    };
  }

  private buildEmbeddingText(
    memory: Pick<UserProfileMemoryPayload, 'type' | 'content' | 'keywords'>
  ): string {
    return [
      normalizeText(memory.content, 200),
      `type:${memory.type}`,
      memory.keywords.length
        ? `keywords:${memory.keywords
            .map(item => normalizeText(item, 32))
            .join(',')}`
        : '',
    ]
      .filter(Boolean)
      .join(' | ')
      .substring(0, 360);
  }

  private normalizeBackendMemory(data: any): UserProfileMemoryRecord | null {
    if (!data || !data.id) {
      return null;
    }

    return {
      id: String(data.id),
      score: 1,
      openId: String(data.openId || ''),
      type:
        data.type === 'habit' ||
        data.type === 'constraint' ||
        data.type === 'goal'
          ? data.type
          : 'preference',
      content: normalizeText(data.content, 200),
      keywords: normalizeKeywords(data.keywords),
      strengthScore: Number(data.strengthScore || DEFAULT_STRENGTH_SCORE),
      createdAt: String(data.createdAt || ''),
      updatedAt: String(data.updatedAt || ''),
      isActive:
        data.isActive === undefined ? true : Boolean(Number(data.isActive)),
    };
  }

  private computeStrengthScore(
    candidate: PreferenceMemoryCandidate,
    existing?: UserProfileMemoryRecord
  ): number {
    if (!existing) {
      return DEFAULT_STRENGTH_SCORE;
    }

    if (this.isDuplicate(candidate, existing)) {
      return Math.min(
        MAX_STRENGTH_SCORE,
        Number((existing.strengthScore || DEFAULT_STRENGTH_SCORE) + 1)
      );
    }

    if (this.isSameSemanticCore(candidate, existing)) {
      return Math.min(
        MAX_STRENGTH_SCORE,
        Number(
          ((existing.strengthScore || DEFAULT_STRENGTH_SCORE) + 0.5).toFixed(2)
        )
      );
    }

    return DEFAULT_STRENGTH_SCORE;
  }

  private buildFallbackDecisions(
    params: Array<{
      candidate: PreferenceMemoryCandidate;
      existingMemories: UserProfileMemoryRecord[];
    }>
  ): PreferenceMemoryDecision[] {
    return params.flatMap<PreferenceMemoryDecision>(
      ({ candidate, existingMemories }) => {
        const action = this.decideAction(candidate, existingMemories);
        if (action === 'discard') {
          return [];
        }

        if (action === 'cover') {
          const sourceMemoryId = existingMemories[0]?.id || null;
          if (!sourceMemoryId) {
            return [];
          }

          return [
            {
              candidateId: candidate.candidateId,
              sourceMemoryId,
              action: 'cover',
            },
          ];
        }

        return [
          {
            candidateId: candidate.candidateId,
            sourceMemoryId: null,
            action: 'new',
          },
        ];
      }
    );
  }

  private normalizeReconcileDecisions(
    raw: any,
    candidates: PreferenceMemoryCandidate[],
    oldMemories: UserProfileMemoryRecord[]
  ): PreferenceMemoryDecision[] {
    const allowedCandidateIds = new Set(
      candidates.map(candidate => candidate.candidateId)
    );
    const allowedMemoryIds = new Set(oldMemories.map(memory => memory.id));
    const seenCandidates = new Set<string>();
    const results = Array.isArray(raw?.results) ? raw.results : [];

    return results
      .map((item: any) => {
        const candidateId = String(item?.candidateId || '').trim();
        const action =
          item?.action === 'cover'
            ? 'cover'
            : item?.action === 'new'
              ? 'new'
              : null;
        const sourceMemoryId = item?.sourceMemoryId
          ? String(item.sourceMemoryId).trim()
          : null;

        if (
          !candidateId ||
          !allowedCandidateIds.has(candidateId) ||
          seenCandidates.has(candidateId) ||
          !action
        ) {
          return null;
        }

        if (
          action === 'cover' &&
          (!sourceMemoryId || !allowedMemoryIds.has(sourceMemoryId))
        ) {
          return null;
        }

        seenCandidates.add(candidateId);
        return {
          candidateId,
          sourceMemoryId: action === 'cover' ? sourceMemoryId : null,
          action,
        } satisfies PreferenceMemoryDecision;
      })
      .filter(
        (item: PreferenceMemoryDecision | null): item is PreferenceMemoryDecision =>
          Boolean(item)
      );
  }

  private buildPreferenceReconcilePrompt(params: {
    messages: FactMessageInput[];
    candidates: PreferenceMemoryCandidate[];
    oldMemories: UserProfileMemoryRecord[];
  }): string {
    const promptMessages = params.messages.map(message => ({
      messageId: Number.isInteger(message.messageId)
        ? String(message.messageId)
        : null,
      role: message.role,
      content: String(message.content || ''),
      timestamp: String(message.timestamp || '') || null,
    }));
    const promptCandidates = params.candidates.map(candidate => ({
      candidateId: candidate.candidateId,
      type: candidate.type,
      content: candidate.content,
      keywords: candidate.keywords,
      evidenceMessageIds: candidate.evidenceMessageIds.map(id => String(id)),
    }));
    const promptOldMemories = params.oldMemories.map(memory => ({
      memoryId: memory.id,
      type: memory.type,
      content: memory.content,
      keywords: memory.keywords,
      strengthScore: memory.strengthScore || DEFAULT_STRENGTH_SCORE,
    }));

    return `new_messages:
${JSON.stringify(promptMessages, null, 2)}

candidate_preferences:
${JSON.stringify(promptCandidates, null, 2)}

old_preference_memories:
${JSON.stringify(promptOldMemories, null, 2)}`;
  }

  private getPreferenceReconcileSystemPrompt(): string {
    return `你是用户偏好记忆对账器。你的任务是根据当前 batch 的新消息、候选偏好和已有偏好记忆，输出最小化保留决策。

规则：
1. action 只能是 new 或 cover
2. 如果候选与旧记忆语义核心相同，即使表达不同，也优先 cover
3. 如果只是重复确认、表达更完整或关键词更清晰，优先 cover
4. 只有当候选是独立的新偏好且无法并入任意旧记忆时，才输出 new
5. sourceMemoryId 在 action=new 时必须为 null
6. sourceMemoryId 在 action=cover 时必须引用 old_preference_memories 中的一条 memoryId
7. assistant 消息只能帮助理解上下文，不能单独作为事实来源
8. 最终判断必须由 user 消息直接支持
9. 不要输出 discard，系统会自动忽略未返回的 candidate

输出必须是纯 JSON：
{
  "results": [
    {
      "candidateId": "cand_1",
      "sourceMemoryId": "memory_id_or_null",
      "action": "new|cover"
    }
  ]
}`;
  }

  private async callQwenJson(
    systemPrompt: string,
    userPrompt: string,
    options: QwenCallOptions = {}
  ): Promise<any> {
    const text = await this.callQwen(systemPrompt, userPrompt, options);
    const parsed = this.extractJson(text);
    if (parsed === null) {
      throw new Error('Failed to parse JSON from model response');
    }
    return parsed;
  }

  private async callQwen(
    systemPrompt: string,
    userPrompt: string,
    options: QwenCallOptions = {}
  ): Promise<string> {
    const apiKey = this.configService.get<string>('dashscope.apiKey')!;
    const qwenUrl = this.configService.get<string>('dashscope.qwenUrl')!;
    const isOldApi = qwenUrl.includes('/api/v1/services/');

    return isOldApi
      ? this.callOldApi(qwenUrl, apiKey, systemPrompt, userPrompt, options)
      : this.callOpenAICompatible(
          qwenUrl,
          apiKey,
          systemPrompt,
          userPrompt,
          options
        );
  }

  private async callOldApi(
    url: string,
    apiKey: string,
    systemPrompt: string,
    userPrompt: string,
    options: QwenCallOptions = {}
  ): Promise<string> {
    const response = await axios.post(
      url,
      {
        model: this.configService.get<string>('dashscope.qwenModel'),
        input: {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        },
        parameters: {
          temperature: 0.1,
          max_tokens: 2000,
          result_format: 'message',
          enable_thinking: options.enableThinking,
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    return response.data.output?.choices?.[0]?.message?.content || '';
  }

  private async callOpenAICompatible(
    url: string,
    apiKey: string,
    systemPrompt: string,
    userPrompt: string,
    options: QwenCallOptions = {}
  ): Promise<string> {
    const enableThinkingRaw = this.configService.get<string>(
      'dashscope.enableThinking'
    );
    const enableThinking =
      options.enableThinking !== undefined
        ? options.enableThinking
        : enableThinkingRaw === undefined
          ? true
          : !['false', '0', 'off'].includes(
              String(enableThinkingRaw).toLowerCase()
            );

    const response = await axios.post(
      url,
      {
        model: this.configService.get<string>('dashscope.qwenModel'),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 2000,
        enable_thinking: enableThinking,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    return response.data.choices?.[0]?.message?.content || '';
  }

  private extractJson(text: string): any | null {
    if (!text) {
      return null;
    }

    const cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (!match) {
        return null;
      }

      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
  }

  private getQdrantUrl(): string {
    return this.configService.get<string>('qdrant.url')!;
  }

  private getProfileCollectionName(): string {
    return this.configService.get<string>('qdrant.profileCollectionName')!;
  }

  private getBackendInternalUrl(): string {
    return this.configService.get<string>('backend.internalUrl')!;
  }

  private getBackendHeaders(): Record<string, string> {
    return {
      'x-api-key': this.configService.get<string>('backend.internalApiKey')!,
    };
  }
}
