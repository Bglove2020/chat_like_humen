import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { randomUUID } from 'crypto';
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
  confidence: number;
  strengthScore: number;
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

const SAME_SUBJECT_SCORE_THRESHOLD = 0.78;
const CHANGE_MARKER_RE =
  /(现在|不再|改成|更喜欢|以前|最近|目前|如今|转成|换成|开始不|不太|少了|减少)/;
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
      ? value.split(/[、,，]/)
      : [];

  return Array.from(
    new Set(
      rawItems
        .map((item) => normalizeText(item, 32))
        .filter(Boolean),
    ),
  ).slice(0, 6);
}

function mergeUniqueNumbers(left: number[], right: number[]): number[] {
  return Array.from(
    new Set(
      [...(left || []), ...(right || [])]
        .map((item) => Number(item))
        .filter(Number.isInteger),
    ),
  ).slice(0, 20);
}

@Injectable()
export class UserProfileMemoryService {
  constructor(
    private configService: ConfigService,
    private dashscopeService: DashscopeService,
  ) {}

  async reconcileAndPersist(
    openId: string,
    batchId: string,
    messages: FactMessageInput[],
    candidates: PreferenceMemoryCandidate[],
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
        (message) => message.role === 'user' || message.role === 'assistant',
      )
      .filter((message) => String(message.content || '').trim());
    const recalledByCandidate = await Promise.all(
      candidates.map(async (candidate) => ({
        candidate,
        existingMemories: await this.searchExistingMemories(openId, candidate),
      })),
    );
    const oldMemories = Array.from(
      new Map(
        recalledByCandidate
          .flatMap((item) => item.existingMemories)
          .map((memory) => [memory.id, memory]),
      ).values(),
    );
    const decisionList = await this.reconcileCandidates({
      messages: normalizedMessages,
      candidates,
      oldMemories,
      recalledByCandidate,
    });
    const decisionByCandidateId = new Map(
      decisionList.map((decision) => [decision.candidateId, decision]),
    );
    const oldMemoryById = new Map(
      oldMemories.map((memory) => [memory.id, memory]),
    );

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

        const covered = await this.upsertMemory({
          openId,
          batchId,
          candidate,
          action: 'update',
          existing,
        });
        if (covered) {
          oldMemoryById.set(covered.id, covered);
          stats.covered += 1;
        } else {
          stats.discarded += 1;
        }
        continue;
      }

      const created = await this.upsertMemory({
        openId,
        batchId,
        candidate,
        action: 'create',
      });
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
        { enableThinking: true },
      );
      return this.normalizeReconcileDecisions(
        raw,
        params.candidates,
        params.oldMemories,
      );
    } catch (error: any) {
      console.error(
        '[ProfileMemory] Preference reconcile error:',
        error?.message || error,
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
    existingMemories: UserProfileMemoryRecord[],
  ): {
    action: 'create' | 'update' | 'supersede' | 'discard';
    existing?: UserProfileMemoryRecord;
  } {
    const sameCore = existingMemories.find((memory) =>
      this.isSameSemanticCore(candidate, memory),
    );

    if (sameCore) {
      if (this.isDuplicate(candidate, sameCore)) {
        return { action: 'discard', existing: sameCore };
      }

      if (this.hasChangeMarker(candidate)) {
        return { action: 'supersede', existing: sameCore };
      }

      return { action: 'update', existing: sameCore };
    }

    const related = existingMemories.find(
      (memory) =>
        this.hasKeywordOverlap(candidate.keywords, memory.keywords) &&
        memory.score >= SAME_SUBJECT_SCORE_THRESHOLD,
    );

    if (related && this.hasChangeMarker(candidate)) {
      return { action: 'supersede', existing: related };
    }

    return { action: 'create' };
  }

  private isSameSemanticCore(
    candidate: PreferenceMemoryCandidate,
    memory: UserProfileMemoryRecord,
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
    memory: UserProfileMemoryRecord,
  ): boolean {
    const candidateText = normalizeKey(candidate.content);
    const memoryText = normalizeKey(memory.content);

    return (
      candidateText === memoryText ||
      (this.keywordOverlapScore(candidate.keywords, memory.keywords) >= 0.85 &&
        (memoryText.includes(candidateText) || candidateText.includes(memoryText)))
    );
  }

  private hasChangeMarker(candidate: PreferenceMemoryCandidate): boolean {
    return CHANGE_MARKER_RE.test([candidate.content, ...candidate.keywords].join(' '));
  }

  private hasKeywordOverlap(left: string[], right: string[]): boolean {
    return this.keywordOverlapScore(left, right) > 0;
  }

  private keywordOverlapScore(left: string[], right: string[]): number {
    const leftSet = new Set(left.map((item) => normalizeKey(item)).filter(Boolean));
    const rightSet = new Set(right.map((item) => normalizeKey(item)).filter(Boolean));

    if (!leftSet.size || !rightSet.size) {
      return 0;
    }

    const intersection = Array.from(leftSet).filter((item) => rightSet.has(item)).length;
    return intersection / Math.max(leftSet.size, rightSet.size);
  }

  private async searchExistingMemories(
    openId: string,
    candidate: PreferenceMemoryCandidate,
  ): Promise<UserProfileMemoryRecord[]> {
    try {
      const embedding = await this.dashscopeService.getEmbedding(
        candidate.retrievalText,
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
        .filter(
          (
            memory: UserProfileMemoryRecord | null,
          ): memory is UserProfileMemoryRecord => Boolean(memory),
        );
    } catch (error: any) {
      console.error('[Qdrant] Profile memory search error:', error?.message);
      return [];
    }
  }

  private mapPointToMemory(point: any): UserProfileMemoryRecord | null {
    const payload = point.payload || {};
    const content = normalizeText(payload.content || payload.preference, 200);
    const keywords = normalizeKeywords(
      payload.keywords || [payload.subject, payload.category].filter(Boolean),
    );

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
      confidence: Number(payload.confidence || 0),
      strengthScore: Number(payload.strengthScore || DEFAULT_STRENGTH_SCORE),
      status: payload.status || 'active',
      sourceMessageIds: Array.isArray(payload.sourceMessageIds)
        ? payload.sourceMessageIds
            .map((item: unknown) => Number(item))
            .filter(Number.isInteger)
        : [],
      batchId: payload.batchId || '',
      retrievalText: payload.retrievalText || content,
      createdAt: payload.createdAt || '',
      updatedAt: payload.updatedAt || '',
      lastActivatedAt:
        payload.lastActivatedAt || payload.updatedAt || payload.createdAt || '',
      supersededById: payload.supersededById || null,
    };
  }

  private async upsertMemory(params: {
    openId: string;
    batchId: string;
    candidate: PreferenceMemoryCandidate;
    action: 'create' | 'update';
    existing?: UserProfileMemoryRecord;
  }): Promise<UserProfileMemoryRecord | null> {
    const now = new Date().toISOString();
    const id = params.action === 'create' ? randomUUID() : params.existing!.id;
    const payload = this.buildPayload({
      openId: params.openId,
      batchId: params.batchId,
      candidate: params.candidate,
      existing: params.existing,
      now,
    });
    const vector = await this.dashscopeService.getEmbedding(
      payload.retrievalText,
    );

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

      console.log(
        `[Qdrant] ${params.action === 'create' ? 'Created' : 'Updated'} profile memory: ${id}`,
      );
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
    openId: string;
    batchId: string;
    candidate: PreferenceMemoryCandidate;
    existing?: UserProfileMemoryRecord;
    now: string;
  }): UserProfileMemoryPayload {
    const { openId, batchId, candidate, existing, now } = params;
    const keywords = normalizeKeywords(
      candidate.keywords.length ? candidate.keywords : existing?.keywords || [],
    );
    const retrievalText = this.buildRetrievalText({
      type: candidate.type || existing?.type || 'preference',
      content: candidate.content || existing?.content || '',
      keywords,
    });

    return {
      openId,
      type: candidate.type || existing?.type || 'preference',
      content: normalizeText(candidate.content || existing?.content, 200),
      keywords,
      confidence: Math.max(
        candidate.confidence || 0,
        existing?.confidence || 0,
      ),
      strengthScore: this.computeStrengthScore(candidate, existing),
      status: 'active',
      sourceMessageIds: mergeUniqueNumbers(
        existing?.sourceMessageIds || [],
        candidate.evidenceMessageIds,
      ),
      batchId,
      retrievalText,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      lastActivatedAt: now,
      supersededById: null,
    };
  }

  private computeStrengthScore(
    candidate: PreferenceMemoryCandidate,
    existing?: UserProfileMemoryRecord,
  ): number {
    if (!existing) {
      return DEFAULT_STRENGTH_SCORE;
    }

    if (this.isDuplicate(candidate, existing)) {
      return Math.min(
        MAX_STRENGTH_SCORE,
        Number((existing.strengthScore || DEFAULT_STRENGTH_SCORE) + 1),
      );
    }

    if (
      this.isSameSemanticCore(candidate, existing) &&
      !this.hasChangeMarker(candidate)
    ) {
      return Math.min(
        MAX_STRENGTH_SCORE,
        Number(
          ((existing.strengthScore || DEFAULT_STRENGTH_SCORE) + 0.5).toFixed(2),
        ),
      );
    }

    return DEFAULT_STRENGTH_SCORE;
  }

  private buildRetrievalText(
    candidate: Pick<
      PreferenceMemoryCandidate,
      | 'type'
      | 'content'
      | 'keywords'
    >,
  ): string {
    return [
      normalizeText(candidate.content, 200),
      `类型：${candidate.type}`,
      candidate.keywords.length
        ? `关键词：${candidate.keywords
            .map((item) => normalizeText(item, 32))
            .join('、')}`
        : '',
    ]
      .filter(Boolean)
      .join('；')
      .substring(0, 360);
  }

  private buildFallbackDecisions(
    params: Array<{
      candidate: PreferenceMemoryCandidate;
      existingMemories: UserProfileMemoryRecord[];
    }>,
  ): PreferenceMemoryDecision[] {
    return params.flatMap<PreferenceMemoryDecision>(
      ({ candidate, existingMemories }) => {
        const decision = this.decideAction(candidate, existingMemories);
        if (decision.action === 'discard') {
          return [];
        }

        if (
          (decision.action === 'update' || decision.action === 'supersede') &&
          decision.existing
        ) {
          return [
            {
              candidateId: candidate.candidateId,
              sourceMemoryId: decision.existing.id,
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
      },
    );
  }

  private normalizeReconcileDecisions(
    raw: any,
    candidates: PreferenceMemoryCandidate[],
    oldMemories: UserProfileMemoryRecord[],
  ): PreferenceMemoryDecision[] {
    const allowedCandidateIds = new Set(
      candidates.map((candidate) => candidate.candidateId),
    );
    const allowedMemoryIds = new Set(oldMemories.map((memory) => memory.id));
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
        (
          item: PreferenceMemoryDecision | null,
        ): item is PreferenceMemoryDecision => Boolean(item),
      );
  }

  private buildPreferenceReconcilePrompt(params: {
    messages: FactMessageInput[];
    candidates: PreferenceMemoryCandidate[];
    oldMemories: UserProfileMemoryRecord[];
  }): string {
    const promptMessages = params.messages.map((message) => ({
      messageId: Number.isInteger(message.messageId)
        ? String(message.messageId)
        : null,
      role: message.role,
      content: String(message.content || ''),
      timestamp: String(message.timestamp || '') || null,
    }));
    const promptCandidates = params.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      type: candidate.type,
      content: candidate.content,
      keywords: candidate.keywords,
      evidenceMessageIds: candidate.evidenceMessageIds.map((id) => String(id)),
    }));
    const promptOldMemories = params.oldMemories.map((memory) => ({
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
    return `你是用户偏好记忆对账器。你的任务是根据当前 batch 的新消息、候选偏好和已有偏好记忆，输出最小化的保留决策。

你的目标是：
- 只保留当前有效、值得保留的偏好
- 尽量避免重复新建
- 对同一语义核心的候选做归并
- 用户偏好只保留当前有效版本，不保留旧版本历史

输入说明：
1. new_messages 中会同时出现 assistant 和 user
2. assistant 消息只用于帮助理解上下文，不能单独作为事实来源
3. 最终结论必须由 user 消息直接支持
4. candidate_preferences 是候选偏好列表
5. old_preference_memories 是当前已有偏好记忆列表

候选只允许属于以下 4 类：
- preference：稳定偏好、厌恶、表达倾向、回复偏好、工具偏好
- habit：稳定习惯、常用做法、重复性行为模式
- constraint：限制、禁忌、规避项、不能接受或尽量避免的事
- goal：持续目标、长期打算、想推进的方向

决策规则：
1. 如果候选不成立、证据不足、只是问句、只是临时状态、无长期价值，直接不要输出该 candidate
2. 如果候选与某条旧记忆在语义上是同一件事，即使 wording 不同，也优先输出 action="cover"
3. 以下情况通常应判为 cover：
   - 对已有偏好的重复确认
   - 更准确的改写
   - 更完整的表达
   - 补充了更清晰的关键词
   - 用户当前说法表明旧版本应该被新版本替换
   - keywords 高度重合，且 content 语义核心一致
4. 只有当候选代表一个新的、独立的、当前有效偏好，且不应并入任何旧记忆时，才输出 action="new"
5. action="cover" 时，sourceMemoryId 必须引用 old_preference_memories 中最相关的一条 memoryId
6. action="new" 时，sourceMemoryId 必须为 null
7. 不要因为 wording 不同就新建；优先看语义核心是否相同
8. type 相同不代表一定是同一偏好；必须结合 content 和 keywords 判断
9. 如果候选与旧记忆存在明显冲突，但用户当前表达的是新的当前有效版本，仍然输出 action="cover"，表示用新版本覆盖旧版本
10. 如果一个候选可匹配多条旧记忆，选择语义最接近、最应被替换的那一条
11. 如果多个 candidate 实际上在说同一个语义核心，只保留信息更完整、表达更明确的一条
12. 如果多个 candidate 都应覆盖同一条旧记忆，只保留最完整、最明确的一条

过滤规则：
以下候选应直接丢弃，不输出结果：
1. 证据不足
2. 脱离上下文后不成立
3. 只是当前任务里的临时偏好，不像长期记忆
4. 只是对 assistant 话术的顺势附和
5. 与已有记忆几乎完全重复，且没有带来任何有效更新

输出要求：
1. 输出必须是纯 JSON
2. 不要输出解释
3. 不要输出 markdown
4. 只输出需要保留的 candidate
5. 如果没有需要保留的候选，返回 {"results":[]}

输出 JSON 结构必须为：
{
  "results": [
    {
      "candidateId": "cand_1",
      "sourceMemoryId": "memory_id_or_null",
      "action": "new|cover"
    }
  ]
}

补充要求：
1. action 只能是 new 或 cover
2. sourceMemoryId 在 action="new" 时必须为 null
3. sourceMemoryId 在 action="cover" 时必须引用 old_preference_memories 中的一条 memoryId
4. 决策应尽量保守，避免重复 new
5. 在“可 new 可 cover”之间优先选择 cover，前提是语义核心确实相同。`;
  }

  private async callQwenJson(
    systemPrompt: string,
    userPrompt: string,
    options: QwenCallOptions = {},
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
    options: QwenCallOptions = {},
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
          options,
        );
  }

  private async callOldApi(
    url: string,
    apiKey: string,
    systemPrompt: string,
    userPrompt: string,
    options: QwenCallOptions = {},
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
      },
    );

    return response.data.output?.choices?.[0]?.message?.content || '';
  }

  private async callOpenAICompatible(
    url: string,
    apiKey: string,
    systemPrompt: string,
    userPrompt: string,
    options: QwenCallOptions = {},
  ): Promise<string> {
    const enableThinkingRaw = this.configService.get<string>(
      'dashscope.enableThinking',
    );
    const enableThinking =
      options.enableThinking !== undefined
        ? options.enableThinking
        : enableThinkingRaw === undefined
          ? true
          : !['false', '0', 'off'].includes(
              String(enableThinkingRaw).toLowerCase(),
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
      },
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
}
