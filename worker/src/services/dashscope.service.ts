import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface Impression {
  id: string;
  scene: string;
  points: string[];
  entities?: string[];
  retrievalText: string;
  content: string;
  createdAt: string;
  updatedAt?: string;
  sessionId?: string | null;
  memoryDate?: string;
  relevanceScore?: number;
  effectiveScore?: number;
  sourceImpressionId?: string | null;
  rootImpressionId?: string | null;
  originType?: string;
  salienceScore?: number;
  lastActivatedAt?: string;
}

export interface ChatMessageInput {
  messageId?: number;
  role: string;
  content: string;
  timestamp: string;
  isNew?: boolean;
}

export interface RetrievalDrafts {
  historyRetrievalDraft: string;
  deltaRetrievalDraft: string;
  mergedRetrievalDraft: string;
}

export interface FinalImpressionDraft {
  sourceImpressionId: string | null;
  scene: string;
  points: string[];
  entities: string[];
  retrievalText: string;
}

export interface CandidateImpressionDraft {
  scene: string;
  points: string[];
  entities: string[];
  retrievalText: string;
  evidenceMessageIds: number[];
}

const MAX_SCENE_CHARS = 60;
const MAX_POINT_CHARS = 180;
const MAX_ENTITY_CHARS = 48;
const MAX_RETRIEVAL_CHARS = 360;

function normalizeText(text: string, maxLength: number): string {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, maxLength);
}

function normalizePoints(points: unknown): string[] {
  if (!Array.isArray(points)) {
    return [];
  }

  return Array.from(new Set(
    points
      .map((point) => normalizeText(String(point || ''), MAX_POINT_CHARS))
      .filter(Boolean),
  )).slice(0, 6);
}

function normalizeEntities(entities: unknown): string[] {
  if (!Array.isArray(entities)) {
    return [];
  }

  return Array.from(new Set(
    entities
      .map((entity) => normalizeText(String(entity || ''), MAX_ENTITY_CHARS))
      .filter(Boolean),
  )).slice(0, 8);
}

function normalizeEvidenceMessageIds(evidenceMessageIds: unknown, allowedIds?: Set<number>): number[] {
  if (!Array.isArray(evidenceMessageIds)) {
    return [];
  }

  return Array.from(new Set(
    evidenceMessageIds
      .map((item) => Number.parseInt(String(item), 10))
      .filter((item) => Number.isInteger(item) && item > 0)
      .filter((item) => !allowedIds || allowedIds.has(item)),
  )).slice(0, 8);
}

function formatPromptMessage(message: ChatMessageInput): Record<string, string | null> {
  return {
    messageId: Number.isInteger(message.messageId) ? String(message.messageId) : null,
    role: message.role === 'user' ? 'user' : 'assistant',
    content: String(message.content || ''),
  };
}

function formatPromptImpression(impression: Impression): Record<string, unknown> {
  return {
    id: impression.id,
    scene: impression.scene,
    points: impression.points,
    entities: impression.entities || [],
    retrievalText: impression.retrievalText,
    memoryDate: impression.memoryDate || 'unknown',
    sourceImpressionId: impression.sourceImpressionId || null,
    rootImpressionId: impression.rootImpressionId || impression.id,
  };
}

function formatPromptCandidate(candidate: CandidateImpressionDraft): Record<string, unknown> {
  return {
    scene: candidate.scene,
    points: candidate.points,
    entities: candidate.entities,
    retrievalText: candidate.retrievalText,
    evidenceMessageIds: candidate.evidenceMessageIds.map(String),
  };
}

function stringifyPromptData(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function buildFallbackScene(messages: ChatMessageInput[]): string {
  const userText = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join(' ');

  const movieMatch = userText.match(/《[^》]+》|挽救计划|电影/);
  if (movieMatch) {
    return normalizeText(`聊电影${movieMatch[0].startsWith('《') ? movieMatch[0] : '《挽救计划》'}`, MAX_SCENE_CHARS);
  }

  if (/面包店|烘焙|早餐|下午茶|铺面|辞职/.test(userText)) {
    return '聊开面包店计划';
  }

  if (/马拉松|膝盖|跑步|配速|训练/.test(userText)) {
    return '聊马拉松训练和膝盖问题';
  }

  return '聊当前对话场景';
}

function buildFallbackPoints(messages: ChatMessageInput[]): string[] {
  const newMessages = messages.filter((message) => message.isNew !== false);
  const selected = newMessages.length ? newMessages : messages;

  return selected
    .map((message) => `${message.role === 'user' ? '用户' : '我'}：${normalizeText(message.content, MAX_POINT_CHARS - 4)}`)
    .slice(-3);
}

function buildFallbackRetrievalText(scene: string, points: string[]): string {
  return normalizeText([scene, ...points].join('，'), MAX_RETRIEVAL_CHARS);
}

@Injectable()
export class DashscopeService {
  constructor(private configService: ConfigService) {}

  private logAxiosError(context: string, error: any, extra?: Record<string, unknown>): void {
    const status = error?.response?.status;
    const statusText = error?.response?.statusText;
    const responseData = error?.response?.data;
    const responseHeaders = error?.response?.headers || {};
    const requestId =
      responseHeaders['x-request-id']
      || responseHeaders['x-acs-request-id']
      || responseHeaders['trace-id']
      || responseHeaders['traceid']
      || null;

    const payload = {
      context,
      message: error?.message,
      code: error?.code,
      status,
      statusText,
      requestId,
      responseData: typeof responseData === 'string'
        ? responseData.substring(0, 1000)
        : responseData,
      ...extra,
    };

    console.error(`[DashScope] ${context} error:`, JSON.stringify(payload));
  }

  async getEmbedding(text: string): Promise<number[]> {
    const apiKey = this.configService.get<string>('dashscope.apiKey');
    const embeddingUrl = this.configService.get<string>('dashscope.embeddingUrl')!;
    const embeddingModel = this.configService.get<string>('dashscope.embeddingModel');

    try {
      const response = await axios.post(
        embeddingUrl,
        {
          model: embeddingModel,
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
      this.logAxiosError('Embedding', error, {
        url: embeddingUrl,
        model: embeddingModel,
        textLength: text.length,
        textPreview: text.substring(0, 300),
      });
      throw error;
    }
  }

  async generateRetrievalDrafts(params: {
    messages: ChatMessageInput[];
    recentActivatedImpressions?: Impression[];
  }): Promise<RetrievalDrafts> {
    if (!params.messages.length) {
      return {
        historyRetrievalDraft: '',
        deltaRetrievalDraft: '',
        mergedRetrievalDraft: '',
      };
    }

    try {
      const raw = await this.callQwenJson(
        this.getRetrievalDraftSystemPrompt(),
        this.buildRetrievalDraftPrompt(params),
      );
      return this.normalizeRetrievalDrafts(raw);
    } catch (error: any) {
      this.logAxiosError('RetrievalDrafts', error, {
        totalMessages: params.messages.length,
        newMessages: params.messages.filter((message) => message.isNew !== false).length,
      });
      return this.createFallbackRetrievalDrafts(params.messages);
    }
  }

  async generateFinalImpressions(params: {
    historyMessages: ChatMessageInput[];
    newMessages: ChatMessageInput[];
    oldImpressions: Impression[];
    candidateImpressions: CandidateImpressionDraft[];
  }): Promise<FinalImpressionDraft[]> {
    if (!params.historyMessages.length && !params.newMessages.length) {
      return [];
    }

    try {
      const raw = await this.callQwenJson(
        this.getReconcileImpressionSystemPrompt(),
        this.buildReconcileImpressionPrompt(params),
      );
      return this.normalizeFinalImpressions(raw);
    } catch (error: any) {
      this.logAxiosError('ReconcileImpressions', error, {
        historyMessages: params.historyMessages.length,
        newMessages: params.newMessages.length,
        recalled: params.oldImpressions.length,
        candidates: params.candidateImpressions.length,
      });
      return this.createFallbackFinalImpressions(params.candidateImpressions, params.oldImpressions);
    }
  }

  async generateCandidateImpressions(params: {
    historyMessages: ChatMessageInput[];
    newMessages: ChatMessageInput[];
    oldImpressions: Impression[];
  }): Promise<CandidateImpressionDraft[]> {
    if (!params.historyMessages.length && !params.newMessages.length) {
      return [];
    }

    try {
      const raw = await this.callQwenJson(
        this.getCandidateImpressionSystemPrompt(),
        this.buildCandidateImpressionPrompt(params),
      );
      return this.normalizeCandidateImpressions(raw, [...params.historyMessages, ...params.newMessages]);
    } catch (error: any) {
      this.logAxiosError('CandidateImpressions', error, {
        historyMessages: params.historyMessages.length,
        newMessages: params.newMessages.length,
        recalled: params.oldImpressions.length,
      });
      return this.createFallbackCandidateImpressions(params.historyMessages, params.newMessages);
    }
  }

  private async callQwenJson(systemPrompt: string, userPrompt: string): Promise<any> {
    const text = await this.callQwen(systemPrompt, userPrompt);
    const parsed = this.extractJson(text);
    if (parsed === null) {
      throw new Error('Failed to parse JSON from model response');
    }
    return parsed;
  }

  private async callQwen(systemPrompt: string, userPrompt: string): Promise<string> {
    const apiKey = this.configService.get<string>('dashscope.apiKey')!;
    const qwenUrl = this.configService.get<string>('dashscope.qwenUrl')!;
    const isOldApi = qwenUrl.includes('/api/v1/services/');

    try {
      return isOldApi
        ? await this.callOldApi(qwenUrl, apiKey, systemPrompt, userPrompt)
        : await this.callOpenAICompatible(qwenUrl, apiKey, systemPrompt, userPrompt);
    } catch (error: any) {
      this.logAxiosError('Qwen', error, {
        url: qwenUrl,
        model: this.configService.get<string>('dashscope.qwenModel'),
        promptLength: userPrompt.length,
        promptPreview: userPrompt.substring(0, 1500),
      });
      throw error;
    }
  }

  private async callOldApi(
    url: string,
    apiKey: string,
    systemPrompt: string,
    userPrompt: string,
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
          temperature: 0.2,
          max_tokens: 2000,
          result_format: 'message',
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
  ): Promise<string> {
    const enableThinkingRaw = this.configService.get<string>('dashscope.enableThinking');
    const enableThinking = enableThinkingRaw === undefined
      ? true
      : !['false', '0', 'off'].includes(String(enableThinkingRaw).toLowerCase());

    const response = await axios.post(
      url,
      {
        model: this.configService.get<string>('dashscope.qwenModel'),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
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

    const choice = response.data.choices?.[0];
    if (!choice) {
      return '';
    }

    const reasoningContent = choice.message?.reasoning_content || '';
    const content = choice.message?.content || '';

    if (reasoningContent) {
      console.log('[Qwen] Thinking:', reasoningContent.substring(0, 200));
    }

    return content;
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

  private normalizeRetrievalDrafts(raw: any): RetrievalDrafts {
    const historyRetrievalDraft = normalizeText(raw?.historyRetrievalDraft || '', MAX_RETRIEVAL_CHARS);
    const deltaRetrievalDraft = normalizeText(raw?.deltaRetrievalDraft || '', MAX_RETRIEVAL_CHARS);
    const mergedRetrievalDraft = normalizeText(raw?.mergedRetrievalDraft || '', MAX_RETRIEVAL_CHARS);

    if (!historyRetrievalDraft && !deltaRetrievalDraft && !mergedRetrievalDraft) {
      throw new Error('Empty retrieval drafts');
    }

    return {
      historyRetrievalDraft,
      deltaRetrievalDraft,
      mergedRetrievalDraft: mergedRetrievalDraft || [historyRetrievalDraft, deltaRetrievalDraft]
        .filter(Boolean)
        .join('；')
        .substring(0, MAX_RETRIEVAL_CHARS),
    };
  }

  private normalizeFinalImpressions(raw: any): FinalImpressionDraft[] {
    const rawImpressions = Array.isArray(raw?.impressions) ? raw.impressions : [];
    const normalized = rawImpressions
      .map((item) => ({
        sourceImpressionId: item?.sourceImpressionId ? String(item.sourceImpressionId) : null,
        scene: normalizeText(item?.scene || '', MAX_SCENE_CHARS),
        points: normalizePoints(item?.points),
        entities: normalizeEntities(item?.entities),
        retrievalText: normalizeText(item?.retrievalText || '', MAX_RETRIEVAL_CHARS),
      }))
      .filter((item) => item.scene && item.points.length && item.retrievalText);

    if (!normalized.length) {
      throw new Error('Empty final impressions');
    }

    return normalized.slice(0, 4);
  }

  private normalizeCandidateImpressions(
    raw: any,
    messages: ChatMessageInput[],
  ): CandidateImpressionDraft[] {
    const rawCandidates = Array.isArray(raw?.candidate_impressions) ? raw.candidate_impressions : [];
    const allowedIds = new Set(
      messages
        .map((message) => message.messageId)
        .filter((messageId): messageId is number => Number.isInteger(messageId)),
    );

    const normalized = rawCandidates
      .map((item) => ({
        scene: normalizeText(item?.scene || '', MAX_SCENE_CHARS),
        points: normalizePoints(item?.points),
        entities: normalizeEntities(item?.entities),
        retrievalText: normalizeText(item?.retrievalText || '', MAX_RETRIEVAL_CHARS),
        evidenceMessageIds: normalizeEvidenceMessageIds(item?.evidenceMessageIds, allowedIds),
      }))
      .filter((item) => item.scene && item.points.length && item.retrievalText && item.evidenceMessageIds.length);

    if (!normalized.length && rawCandidates.length) {
      throw new Error('Empty candidate impressions');
    }

    return normalized.slice(0, 4);
  }

  private createFallbackRetrievalDrafts(messages: ChatMessageInput[]): RetrievalDrafts {
    const historyMessages = messages.filter((message) => message.isNew === false);
    const newMessages = messages.filter((message) => message.isNew !== false);
    const scene = buildFallbackScene(messages);
    const mergedContext = [
      ...historyMessages.slice(-3).map((message) => message.content),
      ...newMessages.slice(-3).map((message) => message.content),
    ].filter(Boolean).join('；');

    return {
      historyRetrievalDraft: historyMessages.length
        ? normalizeText(`${scene}，之前在聊：${historyMessages.slice(-4).map((message) => message.content).join('；')}`, MAX_RETRIEVAL_CHARS)
        : scene,
      deltaRetrievalDraft: normalizeText(`${scene}，这轮新增：${newMessages.map((message) => message.content).join('；')}`, MAX_RETRIEVAL_CHARS),
      mergedRetrievalDraft: normalizeText(
        mergedContext ? `${scene}，当前整体在聊：${mergedContext}` : scene,
        MAX_RETRIEVAL_CHARS,
      ),
    };
  }

  private createFallbackCandidateImpressions(
    historyMessages: ChatMessageInput[],
    newMessages: ChatMessageInput[],
  ): CandidateImpressionDraft[] {
    const messages = [...historyMessages, ...newMessages];
    const selectedMessages = newMessages.length ? newMessages : messages;
    const scene = buildFallbackScene(messages);
    const points = buildFallbackPoints(selectedMessages);
    const retrievalText = buildFallbackRetrievalText(scene, points);
    const evidenceMessageIds = selectedMessages
      .map((message) => message.messageId)
      .filter((messageId): messageId is number => Number.isInteger(messageId))
      .slice(-4);

    if (!scene || !points.length || !retrievalText || !evidenceMessageIds.length) {
      return [];
    }

    return [{
      scene,
      points,
      entities: [],
      retrievalText,
      evidenceMessageIds,
    }];
  }

  private createFallbackFinalImpressions(
    candidateImpressions: CandidateImpressionDraft[],
    oldImpressions: Impression[],
  ): FinalImpressionDraft[] {
    if (!candidateImpressions.length) {
      return [];
    }

    return candidateImpressions.slice(0, 4).map((candidate) => ({
      sourceImpressionId: oldImpressions.find((impression) => impression.scene === candidate.scene)?.id || null,
      scene: candidate.scene,
      points: candidate.points,
      entities: candidate.entities,
      retrievalText: candidate.retrievalText,
    }));
  }

  private buildRetrievalDraftPrompt(params: {
    messages: ChatMessageInput[];
    recentActivatedImpressions?: Impression[];
  }): string {
    const { messages, recentActivatedImpressions = [] } = params;
    const newMessages = messages.filter((message) => message.isNew !== false);
    const historyMessages = messages.filter((message) => message.isNew === false);

    const historyText = historyMessages.length
      ? historyMessages.map((message) => `[${message.role === 'user' ? '用户' : 'AI'}] ${message.content}`).join('\n')
      : '(无历史消息)';
    const deltaText = newMessages.length
      ? newMessages.map((message) => `[${message.role === 'user' ? '用户' : 'AI'}] ${message.content}`).join('\n')
      : '(无新消息)';
    const recentActivatedText = recentActivatedImpressions.length
      ? recentActivatedImpressions.map((impression) => (
        `- scene=${impression.scene}; points=${JSON.stringify(impression.points.slice(0, 2))}; entities=${JSON.stringify((impression.entities || []).slice(0, 6))}; lastActivatedAt=${impression.lastActivatedAt || impression.updatedAt || impression.createdAt || 'unknown'}`
      )).join('\n')
      : '(无最近激活 impressions 补充)';

    return `## 历史消息
${historyText}

## 最近激活的 impressions（仅作补充）
${recentActivatedText}

## 当前 batch 新消息
${deltaText}

请输出 Node1 的三条检索草稿，只服务召回旧 impression，不生成最终落库印象。
三条检索草稿的定义：
1. historyRetrievalDraft
- 只写旧上下文里原来在聊什么。
- 不得混入这轮新增内容。
- 重点保留旧主线、旧目标、旧顾虑、旧对象。

2. deltaRetrievalDraft
- 只写这轮 batch 新增了什么。
- 不得复述旧上下文。
- 重点保留新事实、新对象、新纠正、新变化。

3. mergedRetrievalDraft
- 不再区分历史和新增，要从当前整体语境出发，概括“此刻到底在聊什么，核心张力是什么”。
- 它是整体视角下的当前主题表达，不是 history 和 delta 的说明文，也不是两者的机械拼接。

要求：
1. 默认单场景，除非真的发生独立切换。
2. 要保留当前聊天的场景锚点，不要让局部子话题漂移成新主线。
3. 如果关键印象来自“我……，用户……”，优先保留双边结构。
4. 优先保留人物、关系、对象、时间等实体锚点，不要把它们抽象掉。
5. 最近激活的 impressions 不是当前聊天原文，只是为了补充原文里可能缺失但仍可能相关的旧上下文。
6. 如果最近激活的 impressions 和当前聊天原文不一致，以当前聊天原文为准。
7. 只有当最近激活的 impressions 能帮助恢复当前话题的旧主线、旧对象、旧顾虑或旧目标时，才使用；如果无明显关系就忽略，不要强行带入。
8. 如果一个 batch 中确实出现多个话题，优先写主话题；只有次话题也明显独立且值得召回时，才用一句短语补充，不要平均展开多个话题。
9. 如果三条 draft 几乎一样，说明你没有正确区分三者职责，需要重新组织。
10. 不要写成长摘要、复盘、分析结论或策略总结。
11. 直接输出 JSON。

输出格式：
{"historyRetrievalDraft":"...","deltaRetrievalDraft":"...","mergedRetrievalDraft":"..."}`;
  }

  private buildCandidateImpressionPrompt(params: {
    historyMessages: ChatMessageInput[];
    newMessages: ChatMessageInput[];
    oldImpressions: Impression[];
  }): string {
    const historyMessagesText = stringifyPromptData(params.historyMessages.map(formatPromptMessage));
    const newMessagesText = stringifyPromptData(params.newMessages.map(formatPromptMessage));
    const oldImpressionsText = stringifyPromptData(params.oldImpressions.map(formatPromptImpression));

    return `你是 Node1：候选印象重建器。

你的任务不是总结聊天，不是复盘，不是分析，也不是做用户画像。
你的任务是：**基于当前完整聊天上下文，重建一组“此刻成立的候选聊天印象”**，供后续节点与历史 impressions 对账更新。

你输出的是候选 impression，不是最终落库结果。
你不负责判断 sourceImpressionId，也不负责决定更新哪条旧 impression。

--------------------------------
一、输入
--------------------------------
你会收到三部分输入：

1. history_messages
- 历史聊天消息
- 作用：提供上下文，帮助理解承接关系、代词、省略、话题延续

2. new_messages
- 本次新增消息
- 作用：补充当前聊天状态，帮助判断当前印象是否延续、扩展、变化

3. old_impressions
- 历史 impression
- 作用：帮助理解已有记忆主线、稳定命名、减少重复生成
- 注意：它不是新的事实来源

--------------------------------
二、三类输入的角色边界
--------------------------------
你必须严格区分三类输入的角色：

### 1）history_messages 和 new_messages
- 它们都是原始聊天证据
- 你生成的 candidate impression 必须能被这些原始消息直接支持

### 2）old_impressions
- 只能用于辅助理解、帮助稳定 scene 命名、避免机械重复
- 不能把 old_impressions 里的内容直接当作当前 candidate impression 的事实来源
- 不能因为旧 impression 里有某个内容，就把它直接写进新的 candidate impression
- 所有 candidate impression 都必须能回到原始聊天消息找到证据

一句话：
**候选印象只能由原始聊天消息支持，不能仅由旧 impressions 推出。**

--------------------------------
三、你的核心任务
--------------------------------
你要回答的问题是：

**如果基于当前完整聊天上下文重新看这段聊天，此刻应该有哪些“候选聊天印象”？**

这是一种“当前快照式重建”，不是增量更新，也不是整段摘要。

你要做的是：
- 从完整聊天消息中抽取少量、稳定、可检索的候选 impression
- 尽量保留真正值得记住的核心互动
- 为每条 candidate 绑定原始消息证据

--------------------------------
四、总体原则
--------------------------------
1. 只保留值得入库的候选印象，不做完整聊天摘要
2. 默认 impression 数量尽量少
3. 默认优先合并，不要细碎拆分
4. 只写聊天里明确出现的内容，不推测、不分析、不脑补
5. old_impressions 只能帮助稳定，不得反客为主
6. candidate impression 要尽量稳定，不要因为表达习惯反复换一种说法
7. 你的目标是“重建候选印象集合”，不是“复述聊天过程”

--------------------------------
五、处理顺序
--------------------------------
你必须按下面顺序处理，但不要输出中间过程：

### 第一步：先只基于原始聊天消息判断应该形成几个 candidate impression
- 默认只生成少量 candidate impression
- 如果多个内容只是围绕同一个主问题、同一个对象、同一种互动情境展开，即使中间有追问、解释、纠正、举例、玩梗，也仍然视为同一个 candidate impression
- 只有当聊天中出现了明确、独立、目标明显不同的话题切换时，才拆成多个 candidate impression
- 不要把补充、追问、分支误拆成多个 impression
- 也不要把多个独立主题硬合成一条巨 impression

### 第二步：为每条 candidate impression 生成结构
每条 candidate impression 需要生成：
- scene
- points
- entities
- retrievalText
- evidenceMessageIds

### 第三步：用 old_impressions 做稳定性校正
old_impressions 只能用于：
- 帮助理解当前主线是否延续
- 帮助沿用稳定、简洁的 scene 命名
- 帮助避免同一主线被你这次写得太飘、太散、太像摘要

但不能用于：
- 补充当前消息中没有证据的事实
- 把旧 impression 中的表述直接抄进 candidate impression
- 因为旧 impression 存在，就硬生成对应 candidate

--------------------------------
六、scene 生成规则
--------------------------------
scene 只写“我和用户在聊什么”，不写分析，不写结论，不写建议，不写谁对谁错，不写谁没理解谁。

### 规则
1. 如果聊天主题明确：
- 直接用明确主题命名
- 例如：聊搬砖和打工人说法 / 聊电影剧情 / 聊早餐习惯

2. 如果聊天主题不明确、内容较散、只是普通来回聊天：
- 用“时间段 + 闲聊”命名
- 时间段一般用：周几上午 / 周几下午 / 周几晚上
- 例如：周五下午闲聊

3. 不要为了概括而硬造主题
如果主题并不明确，优先用“时间段 + 闲聊”

4. 不要把分歧、纠正、误解、结论写进 scene
错误示例：
- 聊我没理解用户的梗
- 聊用户纠正我对某说法的理解
- 聊我接梗失败

正确示例：
- 聊上班相关说法
- 聊搬砖和打工人说法
- 周五下午闲聊

--------------------------------
七、points 生成规则
--------------------------------
points 是“聊天印象点”，不是摘要，不是复述，不是过程记录。

### 总要求
points 的目标是：
**用最少的字，保留最主要的主体和互动。**

### 具体规则

#### 1）只写聊天里明确出现的内容
- 只能写原始消息中直接出现或能直接对应的内容
- 不补充常识
- 不猜测动机
- 不分析情绪
- 不写隐含意义
- 不写“说明了”“体现了”“反映出”“可能是”“用户其实是在……”

#### 2）每个 point 尽量同时包含双方内容
除非该段聊天几乎只有一方持续输出，否则每个 point 都应尽量体现：
- 用户说了什么
- 我回应了什么

不要只留下单边表述。
不要把 point 写成孤立事实或单方发言。

#### 3）优先合并，不要细碎拆分
- 同一主互动下的问答、追问、解释、纠正，优先合并成一个 point
- 能用一个 point 表达清楚，就不要拆成多个
- 只有出现新的主体互动，且合并后会失焦，才新增 point

#### 4）一个 point 只保留一个主要印象
这里的“一个主要印象”不是一句单边事实，而是一个完整的核心互动单元。
例如：
- 用户问“搬砖”是什么意思，我把它解释成上班干活的说法。
这是一个 point。

不要拆成：
- 用户问“搬砖”是什么意思
- 我把它解释成上班干活的说法

#### 5）忽略小细节，不展开过程
- 不按时间线复盘
- 不保留小铺垫
- 不把过程写全
- 不为了完整而多写

#### 6）数量尽量少
- 一个 candidate impression 下的 points 默认越少越好
- 优先 1～2 条
- 除非确实存在多个独立且都很重要的记忆点，否则不要写多条

--------------------------------
八、entities 生成规则
--------------------------------
entities 只保留最关键的客观锚点，便于后续检索。

优先保留：
- 人物
- 关系身份
- 具体对象
- 地点
- 时间
- 明确提到的关键词、术语、表达

不要保留：
- 抽象评价
- 推测性标签
- 纯分析性概括
- 对检索帮助不大的空泛词

entities 要少而准，不要为了凑数乱加。

--------------------------------
九、retrievalText 生成规则
--------------------------------
retrievalText 只能基于最终生成的 scene、points、entities 来写，
不得新增它们里没有的新事实。

要求：
- 更偏向检索文本，而不是自然表达
- 多保留实体和客观事实
- 少保留分析性空话
- 表达清楚，但不要展开

--------------------------------
十、evidenceMessageIds 规则
--------------------------------
每条 candidate impression 都必须提供 evidenceMessageIds。

要求：
1. 只能填写原始消息中的 message id
2. 这些 id 必须能直接支持该条 candidate impression
3. 不要填无关消息
4. 不要只因为旧 impression 提到过，就补不存在证据的消息
5. evidenceMessageIds 应尽量精简，只保留最关键的支持消息

--------------------------------
十一、自检要求
--------------------------------
输出前必须检查：

1. candidate impression 是否真的是由原始消息支持，而不是由 old_impressions 推出
2. 是否误把一个场景拆成多个 impression
3. 是否把多个独立主题硬合成了一条 impression
4. scene 是否明确；不明确时是否改用了“时间段 + 闲聊”
5. points 是否优先合并了，而不是写成细碎流水账
6. points 是否尽量体现了双方内容，而不是只保留单边表述
7. 是否加入了聊天中没有直接证据支持的推测或分析
8. retrievalText 是否严格只基于 scene、points、entities
9. evidenceMessageIds 是否真的能支撑该条 candidate impression
10. 输出是否是候选印象集合，而不是整段聊天摘要

--------------------------------
十二、输出要求
--------------------------------
- 直接输出 JSON
- 不要输出任何解释、备注、分析过程
- 输出格式必须严格如下：

{
  "candidate_impressions": [
    {
      "scene": "...",
      "points": ["..."],
      "entities": ["..."],
      "retrievalText": "...",
      "evidenceMessageIds": ["msg_id_1", "msg_id_2"]
    }
  ]
}

如果没有值得生成的候选 impression，可以输出：

{"candidate_impressions":[]}

--------------------------------
十三、输入数据
--------------------------------
下面是输入数据：

history_messages:
${historyMessagesText}

new_messages:
${newMessagesText}

old_impressions:
${oldImpressionsText}`;
  }

  private buildReconcileImpressionPrompt(params: {
    historyMessages: ChatMessageInput[];
    newMessages: ChatMessageInput[];
    oldImpressions: Impression[];
    candidateImpressions: CandidateImpressionDraft[];
  }): string {
    const historyMessagesText = stringifyPromptData(params.historyMessages.map(formatPromptMessage));
    const newMessagesText = stringifyPromptData(params.newMessages.map(formatPromptMessage));
    const oldImpressionsText = stringifyPromptData(params.oldImpressions.map(formatPromptImpression));
    const candidateImpressionsText = stringifyPromptData(params.candidateImpressions.map(formatPromptCandidate));

    return `你是 Node2：印象对账与更新器。

你的任务不是重新总结聊天，也不是重新提取候选印象。
你的任务是：**把 Node1 生成的 candidate_impressions 与 old_impressions 进行对账，结合原始聊天消息，决定哪些需要更新、改写、补充、新建或丢弃，并输出最终要落库的 impressions。**

你输出的是最终落库结果。
你必须以原始聊天消息为最终证据源，不能只根据 candidate_impressions 或 old_impressions 自由改写。

--------------------------------
一、输入
--------------------------------
你会收到四部分输入：

1. history_messages
- 历史聊天消息
- 作用：帮助理解上下文和主线延续

2. new_messages
- 本次新增消息
- 作用：帮助确认这轮聊天是否真的带来了新的记忆变化

3. old_impressions
- 历史 impression
- 作用：提供已有记忆，用于对账和更新

4. candidate_impressions
- Node1 生成的候选 impression
- 作用：提供当前候选结果，但不是唯一事实来源

--------------------------------
二、四类输入的角色边界
--------------------------------
你必须严格区分四类输入的角色：

### 1）原始聊天消息（history_messages + new_messages）
- 它们是最终证据源
- 你输出的 final impression 必须能被原始消息支持
- 当 candidate_impressions 与原始消息不一致时，以原始消息为准

### 2）candidate_impressions
- 它们是候选结果，不是绝对真相
- 你要用它们做对账和更新的起点
- 但不能盲信，必须回到原始消息校验

### 3）old_impressions
- 它们是已有记忆
- 你要判断每条 candidate 与哪条 old impression 承接
- 但不能因为 old impression 存在，就强行更新或复写

一句话：
**你是“基于原始聊天证据的记忆对账器”，不是“基于候选结果的覆盖器”。**

--------------------------------
三、你的核心任务
--------------------------------
你要回答的问题是：

**Node1 产出的 candidate_impressions，与 old_impressions 是什么关系？哪些需要更新旧 impression，哪些需要新建，哪些应当丢弃？**

你的目标是输出：
- 本轮需要落库的新 impression
- 或本轮需要更新后的 impression

你不需要输出无变化、无需处理的 old impression。

--------------------------------
四、总体原则
--------------------------------
1. 以原始聊天消息为最终证据源
2. candidate_impressions 只是候选，不是最终事实
3. old_impressions 只是已有记忆，不是本轮自动继承内容
4. 默认优先保持记忆结构稳定，不要无意义大改
5. 默认优先补充或改写旧 points，而不是机械新增 points
6. 遇到不一致信息时，不要直接覆盖旧事实
7. points 仍然要少、短、像印象，不能越更新越臃肿
8. 输出的是本轮要落库的结果，不是全量 memory 重写结果

--------------------------------
五、处理顺序
--------------------------------
你必须按下面顺序处理，但不要输出中间过程：

### 第一步：逐条检查 candidate_impressions 是否值得保留
对每条 candidate impression：
- 回到原始聊天消息核验它是否成立
- 检查它是否有足够证据支持
- 检查它是否真的构成值得入库的印象

如果 candidate impression：
- 没有足够原始消息支持
- 明显是过度概括
- 明显只是摘要性废话
- 与原始聊天不符
- 不能形成稳定记忆点

则丢弃，不输出。

### 第二步：判断 candidate impression 与哪条 old impression 承接
只有在下列情况明显成立时，才算承接：
- 讨论对象连续
- 核心话题连续
- 互动情境连续
- 本质上属于同一主线

承接时：
- sourceImpressionId 填对应 old impression 的 id

不承接时：
- sourceImpressionId 填 null

不要为了合并而强行匹配。

### 第三步：确定更新方式
对于承接旧 impression 的 candidate impression，你必须先在内部判断更新方式，但不要输出动作类型。

允许的更新方式只有以下几类：

1. **补充旧 point**
- 当前信息属于旧 point 的自然延伸
- 优先补入旧 point，而不是新增 point

2. **改写旧 point**
- 当前信息没有改变旧 point 的核心事实，但让旧 point 的表达更准确、更像印象
- 可以改写旧 point 的文案
- 但不能引入原始消息没有支持的新含义

3. **新增 point**
- 当前信息虽然还在同一主线里，但已经形成新的主体互动
- 如果硬塞进旧 point，会导致 point 过重、过杂、失焦
- 这时才允许新增 point

4. **冲突补记**
- 当前信息与旧 impression 中已有内容不一致
- 不要删除旧事实
- 不要假装旧内容没发生过
- 应在新的 point 中明确写出“现在和之前不一致”或“现在补充了新的情况”
- 让新旧信息并存

5. **新建 impression**
- candidate impression 与任何 old impression 都不构成明显承接
- 则新建 impression，sourceImpressionId 为 null

### 第四步：生成最终要落库的 impression
对每条保留的 candidate impression，输出最终要落库的结构：
- sourceImpressionId
- scene
- points
- entities
- retrievalText

--------------------------------
六、承接旧 impression 时的具体规则
--------------------------------
当 candidate impression 与某条 old impression 明显属于同一主线时：

### 1）优先补充或修改原有 points
如果当前信息与旧 point 是同一个主体、同一个互动核心：
- 优先补充旧 point
- 或微调旧 point 的表达
- 不要为了补一点信息就新开 point

### 2）只有新的主体互动才新增 point
如果当前信息已经构成旧 points 无法自然容纳的新互动焦点，才新增 point。

“新的主体互动”通常指：
- 新的核心问答
- 新的明显纠正或错位
- 旧 points 未覆盖、但很容易被记住的新互动焦点

### 3）遇到不一致，不要覆盖旧事实
如果当前聊天与旧 impression 中已有信息不一致：
- 不要删除旧事实
- 不要整条替换掉旧 impression
- 在新 point 中明确写出“现在和之前不一致”或“现在补充了新的情况”
- 让新旧信息并存

### 4）不要机械拼接旧 points 和 candidate points
最终输出的 points 应该是：
- 基于旧 points 整理吸收 candidate 后的结果
- 更准确或更完整
- 但仍然简洁、稳定、像印象

不要出现这两类错误：
1. 原样保留旧 points，再把 candidate points 机械追加在后面
2. 完全抛开旧 points，只按 candidate 重写，失去承接关系意义

正确做法是：
**旧 points 为底，candidate 信息入内，能融就融，必要时才加。**

--------------------------------
七、scene 生成规则
--------------------------------
scene 只写“我和用户在聊什么”，不写分析，不写结论，不写建议，不写谁对谁错，不写谁没理解谁。

### 规则
1. 如果主题明确：
- 直接用明确主题命名
- 例如：聊搬砖和打工人说法 / 聊电影剧情 / 聊早餐习惯

2. 如果主题不明确、内容较散：
- 用“时间段 + 闲聊”命名
- 例如：周五下午闲聊

3. 承接旧 impression 时：
- 如果当前主线没有明显变化，优先保持 scene 稳定
- 只有在当前聊天证据明确表明主题已经变化或旧 scene 不准确时，才调整 scene

4. 不要把分歧、纠正、误解、结论写进 scene

--------------------------------
八、points 生成规则
--------------------------------
points 是“聊天印象点”，不是摘要，不是复述，不是过程记录。

### 总要求
points 的目标是：
**用最少的字，保留最主要的主体和互动。**

### 具体规则

#### 1）只写有原始消息证据支持的内容
- 只能写能回到原始消息找到支持的内容
- 不补充常识
- 不猜测动机
- 不分析情绪
- 不写隐含意义
- 不写“说明了”“体现了”“反映出”“可能是”“用户其实是在……”

#### 2）每个 point 尽量同时包含双方内容
除非该段聊天几乎只有一方持续输出，否则每个 point 都应尽量体现：
- 用户说了什么
- 我回应了什么

#### 3）优先合并，不要细碎拆分
- 同一主互动下的问答、追问、解释、纠正，优先合并成一个 point
- 能用一个 point 表达清楚，就不要拆成多个
- 只有新的主体互动出现时，才新增 point

#### 4）一个 point 只保留一个主要印象
这里的“一个主要印象”是一个完整的核心互动单元，不是一句单边事实。

#### 5）忽略小细节，不展开过程
- 不按时间线复盘
- 不保留小铺垫
- 不把过程写全
- 不为了完整而多写

#### 6）数量尽量少
- 一个 impression 下的 points 默认越少越好
- 优先 1～2 条
- 除非确实存在多个独立且都很重要的记忆点，否则不要写多条

--------------------------------
九、entities 生成规则
--------------------------------
entities 只保留最关键的客观锚点，便于后续检索。

优先保留：
- 人物
- 关系身份
- 具体对象
- 地点
- 时间
- 明确提到的关键词、术语、表达

不要保留：
- 抽象评价
- 推测性标签
- 纯分析性概括
- 对检索帮助不大的空泛词

entities 要少而准，不要为了凑数乱加。

--------------------------------
十、retrievalText 生成规则
--------------------------------
retrievalText 只能基于最终生成的 scene、points、entities 来写，
不得新增这三者里没有的新事实。

要求：
- 更偏向检索文本，而不是自然表达
- 多保留实体和客观事实
- 少保留分析性空话
- 表达清楚，但不要展开

--------------------------------
十一、丢弃 candidate 的规则
--------------------------------
以下 candidate impression 应丢弃，不输出：

1. 没有足够原始聊天证据支持
2. 只是摘要性、空泛性概括
3. 不能形成稳定记忆点
4. 与 old impression 相比没有实质新增或修正价值
5. 与原始聊天内容不符
6. 只是 wording 变化，没有实质记忆变化

--------------------------------
十二、自检要求
--------------------------------
输出前必须检查：

1. 是否以原始聊天消息为最终证据源，而不是盲信 candidate_impressions
2. 是否误把一个场景拆成多个 impression
3. 是否把多个独立主题硬合成了一条 impression
4. scene 是否明确；不明确时是否改用了“时间段 + 闲聊”
5. points 是否优先合并了，而不是写成细碎流水账
6. points 是否尽量体现了双方内容，而不是只保留单边表述
7. 是否加入了聊天中没有直接证据支持的推测或分析
8. 承接旧 impression 时，是否优先补充或修改旧 points，而不是直接重写
9. 遇到不一致信息时，是否保留了旧事实，而不是直接覆盖
10. retrievalText 是否严格只基于最终 scene、points、entities
11. 是否只输出本轮需要落库的新建或更新结果，而没有把无需变化的 old impression 也输出出来

--------------------------------
十三、输出要求
--------------------------------
- 直接输出 JSON
- 不要输出任何解释、备注、分析过程
- 输出格式必须严格如下：

{
  "impressions": [
    {
      "sourceImpressionId": "old_id_or_null",
      "scene": "...",
      "points": ["..."],
      "entities": ["..."],
      "retrievalText": "..."
    }
  ]
}

如果本轮没有任何需要落库的新建或更新结果，可以输出：

{"impressions":[]}

--------------------------------
十四、输入数据
--------------------------------
下面是输入数据：

history_messages:
${historyMessagesText}

new_messages:
${newMessagesText}

old_impressions:
${oldImpressionsText}

candidate_impressions:
${candidateImpressionsText}`;
  }

  private getRetrievalDraftSystemPrompt(): string {
    return '你是聊天印象系统的 Node1 检索草稿生成器。你只负责生成 historyRetrievalDraft、deltaRetrievalDraft、mergedRetrievalDraft。输出必须是纯 JSON。';
  }

  private getFinalImpressionSystemPrompt(): string {
    return '你是聊天印象系统的印象对账与更新器。你根据原始聊天消息、candidate_impressions 和 old_impressions，输出最终落库的 impressions。输出必须是纯 JSON。';
  }

  private getCandidateImpressionSystemPrompt(): string {
    return '你是聊天印象系统的候选印象重建器。你根据 history_messages、new_messages 和 old_impressions，输出 candidate_impressions。输出必须是纯 JSON。';
  }

  private getReconcileImpressionSystemPrompt(): string {
    return '你是聊天印象系统的印象对账与更新器。你根据 history_messages、new_messages、old_impressions、candidate_impressions，输出最终落库的 impressions。输出必须是纯 JSON。';
  }
}
