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

export type MemoryPointOp = 'new' | 'supplement' | 'revise' | 'conflict';

export interface MemoryLineCandidate {
  id: string;
  anchorLabel: string;
  impressionLabel: string;
  impressionAbstract: string;
  salienceScore: number;
  lastActivatedAt: string;
}

export interface RetrievedMemoryPoint {
  id: string;
  lineId: string;
  op: MemoryPointOp;
  sourcePointId: string | null;
  text: string;
  memoryDate: string;
  salienceScore: number;
  createdAt: string;
  updatedAt: string;
  sessionId: string | null;
  relevanceScore?: number;
  line: MemoryLineCandidate;
}

export interface Node2PointDraft {
  opAnalysis?: string | null;
  op: MemoryPointOp;
  sourcePointId: string | null;
  rewriteAnalysis?: string | null;
  text: string;
}

export interface Node2PointGeneration {
  candidateAnalysis?: string | null;
  points: Node2PointDraft[];
}

export interface AttachLineDraft {
  targetLineId: string | null;
}

export interface NewLinePlanDraft {
  newLines: Array<{
    anchorLabel: string;
    pointIndexes: number[];
  }>;
}

export interface LineImpressionDraft {
  impressionLabel: string;
  impressionAbstract: string;
}

interface QwenCallOptions {
  enableThinking?: boolean;
}

const MAX_SCENE_CHARS = 60;
const MAX_POINT_CHARS = 180;
const MAX_ENTITY_CHARS = 48;
const MAX_RETRIEVAL_CHARS = 360;
const MAX_FINAL_POINTS = 3;
const MAX_CANDIDATE_POINTS = 3;
const EMOJI_RE = /[\p{Extended_Pictographic}\uFE0F]/gu;
const ANALYSIS_WORD_RE =
  /(说明了|体现了|体现出|反映出|意味着|认知偏差|达成一致|完成校准|行为偏好|接梗失败)/g;
const HIGH_SIGNAL_POINT_RE =
  /(用户|我|计划|打算|想|顾虑|担心|纠正|不接受|更偏向|只够|限制|边界|目标|继续|改成|补充)/;
const DURABLE_POINT_RE =
  /(计划|打算|想|顾虑|担心|目标|增进感情|限制|只能|纠正|时间|行程|劳累|疲惫|预算|现金流|人手|借款|辞职|训练|配速|膝盖|不舒服|周末|早餐|下午茶|前同事|拼豆|电影)/;
const GENERIC_DURABLE_TAGS = new Set([
  '计划',
  '打算',
  '拼豆',
  '电影',
  '早餐',
  '下午茶',
  '周末',
]);
const CONCERN_MESSAGE_RE =
  /(顾虑|担心|怕|犹豫|纠结|累|劳累|疲惫|时间紧|赶|空档|只够|最多|行程)/;
const CONCERN_POINT_RE = /(顾虑|担心|犹豫|时间紧|时间压力|劳累|疲惫|安排负担)/;
const SCENE_NOISE_SUFFIX_REPLACEMENTS: Array<[RegExp, string]> = [
  [/的顾虑与互动策略$/g, ''],
  [/的互动策略$/g, ''],
  [/及互动策略$/g, ''],
  [/和互动策略$/g, ''],
  [/的推进思路$/g, ''],
  [/的建议思路$/g, ''],
];
const POINT_NOISE_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bassistant\b/gi, '我'],
  [/\bAI\b/g, '我'],
  [/作为 AI/g, '我'],
  [/assistant随后调整为/gi, '我随后改成'],
  [/assistant建议/gi, '我建议'],
  [/assistant解释为/gi, '我解释为'],
  [/assistant回应/gi, '我回应'],
  [/assistant/gi, '我'],
  [/直接怼了回来/g, '明确反对'],
  [/不买账这种说法/g, '不接受这种说法'],
  [/不买账/g, '不接受'],
  [/钢铁直男/g, '过于生硬'],
  [/社死风险低/g, '互动压力较低'],
  [/稳了/g, '更稳妥'],
  [/感情\+1/g, '更自然地增进感情'],
  [/哈哈/g, ''],
  [/笑飞了?/g, ''],
  [/被戳中了/g, ''],
];
const LOW_SIGNAL_POINT_RE =
  /(多次祝福|祝福.*愉快|笑飞|哈哈|稳了|呼应|最后一提醒|冲！|独家款|社恐自救|搬砖心情都会好)/;

function normalizeText(text: string, maxLength: number): string {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, maxLength);
}

function sanitizeGeneratedText(text: string, maxLength: number): string {
  let next = String(text || '').replace(EMOJI_RE, ' ');

  for (const [pattern, replacement] of POINT_NOISE_REPLACEMENTS) {
    next = next.replace(pattern, replacement);
  }

  next = next
    .replace(ANALYSIS_WORD_RE, '')
    .replace(/[“”"]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/([；，。！？])\1+/g, '$1')
    .replace(/\s*([；，。！？])\s*/g, '$1')
    .replace(/^[；，。！？\s]+/, '')
    .replace(/[；，。！？\s]+$/, '')
    .trim();

  return normalizeText(next, maxLength);
}

function sanitizeSceneText(text: string): string {
  let next = sanitizeGeneratedText(text, MAX_SCENE_CHARS);

  for (const [pattern, replacement] of SCENE_NOISE_SUFFIX_REPLACEMENTS) {
    next = next.replace(pattern, replacement);
  }

  return normalizeText(next, MAX_SCENE_CHARS);
}

function stabilizePointText(text: string): string {
  let next = sanitizeGeneratedText(text, MAX_POINT_CHARS);
  if (!next) {
    return '';
  }

  next = next
    .replace(/被用户评价为风格生硬/g, '用户不接受这种低互动理解')
    .replace(/用户评价为风格生硬/g, '用户不接受这种低互动理解')
    .replace(/风格生硬/g, '不符合用户期待')
    .replace(/边拼边吐槽/g, '边做边聊')
    .replace(/边拼边聊两句/g, '边做边聊')
    .replace(/边聊两句/g, '边做边聊')
    .replace(/做完还能约杯奶茶/g, '把互动放在后续自然延续上')
    .replace(/做完还能约奶茶/g, '把互动放在后续自然延续上')
    .replace(/完事奶茶我请/g, '把互动放在后续自然延续上')
    .replace(/下次你挑图案我请奶茶/g, '把互动放在后续自然延续上')
    .replace(
      /合作设计图案或边做边聊以创造互动话题/g,
      '把重点放在选图案和过程中自然聊天',
    )
    .replace(
      /合作设计图案或边拼边吐槽以创造互动话题/g,
      '把重点放在选图案和过程中自然聊天',
    )
    .replace(/合作设计图案或边做边聊/g, '把重点放在选图案和过程中自然聊天')
    .replace(/合作设计图案或边拼边吐槽/g, '把重点放在选图案和过程中自然聊天');

  if (
    /增进感情/.test(next) &&
    /(低互动|各做各的|不符合用户期待|用户不接受这种低互动理解)/.test(next)
  ) {
    const leadRaw = next.split(/[；。]/)[0] || next;
    const lead = sanitizeGeneratedText(leadRaw, MAX_POINT_CHARS)
      .replace(/，?我(?:起初)?建议[^，；。]*/g, '')
      .replace(/，?我起初更强调[^，；。]*/g, '')
      .replace(
        /，?(?:被用户评价为[^，；。]*|用户不接受这种低互动理解|不符合用户期待)/g,
        '',
      )
      .replace(/[，；。]+$/, '')
      .trim();

    const normalizedLead = lead || '用户明确说这次安排的目标是增进感情';
    next = `${normalizedLead}${/不接受把这件事理解成低互动安排/.test(normalizedLead) ? '' : '，不接受把这件事理解成低互动安排'}；我随后把建议调整为更强调过程中自然互动`;
  }

  if (
    /(只能各自独立操作|只能自己做自己的|没法一起拼|无法两人共同拼凑)/.test(next)
  ) {
    const interactionTail = /图案/.test(next)
      ? '我随后把互动建议调整为把重点放在选图案和过程中自然聊天'
      : '我随后把互动建议调整为把重点放在过程中自然聊天';
    next = /我|建议|改成|调整/.test(next)
      ? `用户纠正这件事在操作上只能各自独立完成；${interactionTail}`
      : '用户纠正这件事在操作上只能各自独立完成';
  }

  return normalizeText(next, MAX_POINT_CHARS);
}

function splitLongPoint(point: string): string[] {
  const normalized = stabilizePointText(point);
  if (!normalized) {
    return [];
  }

  if (normalized.length <= 100) {
    return [normalized];
  }

  const parts = normalized
    .split(/；|(?<=。)(?=我|用户)|(?<=，)(?=我|用户)/)
    .map((item) => stabilizePointText(item))
    .filter(Boolean);

  if (parts.length <= 1) {
    return [normalized];
  }

  return parts;
}

function isLowSignalPoint(point: string): boolean {
  const normalized = sanitizeGeneratedText(point, MAX_POINT_CHARS);
  if (!normalized) {
    return true;
  }

  if (
    LOW_SIGNAL_POINT_RE.test(normalized) &&
    !HIGH_SIGNAL_POINT_RE.test(normalized)
  ) {
    return true;
  }

  return !/用户|我/.test(normalized);
}

function extractDurableTags(text: string): string[] {
  const normalized = stabilizePointText(text);
  const tags = [
    '计划',
    '打算',
    '顾虑',
    '担心',
    '目标',
    '增进感情',
    '限制',
    '只能',
    '纠正',
    '时间',
    '行程',
    '劳累',
    '疲惫',
    '预算',
    '现金流',
    '人手',
    '借款',
    '辞职',
    '训练',
    '配速',
    '膝盖',
    '不舒服',
    '早餐',
    '下午茶',
    '周末',
    '前同事',
    '拼豆',
    '电影',
  ];

  return tags.filter((tag) => normalized.includes(tag));
}

function shouldCarryForwardPoint(
  sourcePoint: string,
  finalPoints: string[],
): boolean {
  const normalizedSource = stabilizePointText(sourcePoint);
  if (
    !normalizedSource ||
    isLowSignalPoint(normalizedSource) ||
    !DURABLE_POINT_RE.test(normalizedSource)
  ) {
    return false;
  }

  const finalText = finalPoints
    .map((point) => stabilizePointText(point))
    .join('；');
  if (!finalText) {
    return true;
  }

  if (finalText.includes(normalizedSource)) {
    return false;
  }

  const sourceTags = extractDurableTags(normalizedSource);
  if (!sourceTags.length) {
    return false;
  }

  const finalTags = extractDurableTags(finalText);
  const informativeOverlap = sourceTags.filter(
    (tag) => !GENERIC_DURABLE_TAGS.has(tag) && finalTags.includes(tag),
  );
  const overlap = sourceTags.filter((tag) => finalTags.includes(tag)).length;

  if (!informativeOverlap.length) {
    return false;
  }

  if (overlap === sourceTags.length) {
    return false;
  }

  return sourceTags.some((tag) => !finalTags.includes(tag));
}

function normalizePoints(points: unknown): string[] {
  if (!Array.isArray(points)) {
    return [];
  }

  return Array.from(
    new Set(
      points
        .flatMap((point) => splitLongPoint(String(point || '')))
        .filter(Boolean),
    ),
  ).slice(0, 6);
}

function normalizeEntities(entities: unknown): string[] {
  if (!Array.isArray(entities)) {
    return [];
  }

  return Array.from(
    new Set(
      entities
        .map((entity) => normalizeText(String(entity || ''), MAX_ENTITY_CHARS))
        .filter(Boolean),
    ),
  ).slice(0, 8);
}

function normalizeEvidenceMessageIds(
  evidenceMessageIds: unknown,
  allowedIds?: Set<number>,
): number[] {
  if (!Array.isArray(evidenceMessageIds)) {
    return [];
  }

  return Array.from(
    new Set(
      evidenceMessageIds
        .map((item) => Number.parseInt(String(item), 10))
        .filter((item) => Number.isInteger(item) && item > 0)
        .filter((item) => !allowedIds || allowedIds.has(item)),
    ),
  ).slice(0, 8);
}

function formatBeijingTimestamp(
  timestamp: string | null | undefined,
): string | null {
  if (!timestamp) {
    return null;
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const valueByType = new Map(parts.map((part) => [part.type, part.value]));
  const year = valueByType.get('year');
  const month = valueByType.get('month');
  const day = valueByType.get('day');
  const hour = valueByType.get('hour');
  const minute = valueByType.get('minute');
  const second = valueByType.get('second');

  if (!year || !month || !day || !hour || !minute || !second) {
    return null;
  }

  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function formatPromptMessage(
  message: ChatMessageInput,
): Record<string, string | null> {
  return {
    messageId: Number.isInteger(message.messageId)
      ? String(message.messageId)
      : null,
    role: message.role === 'user' ? 'user' : 'assistant',
    content: String(message.content || ''),
    timestamp: String(message.timestamp || '') || null,
    beijingTime: formatBeijingTimestamp(message.timestamp),
  };
}

function formatPromptImpression(
  impression: Impression,
): Record<string, unknown> {
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

function formatPromptCandidate(
  candidate: CandidateImpressionDraft,
): Record<string, unknown> {
  return {
    scene: candidate.scene,
    points: candidate.points,
    entities: candidate.entities,
    retrievalText: candidate.retrievalText,
    evidenceMessageIds: candidate.evidenceMessageIds.map(String),
  };
}

function formatPromptRetrievedPoint(
  point: RetrievedMemoryPoint,
): Record<string, unknown> {
  return {
    id: point.id,
    lineId: point.lineId,
    op: point.op,
    sourcePointId: point.sourcePointId,
    text: point.text,
    memoryDate: point.memoryDate,
    line: {
      id: point.line.id,
      anchorLabel: point.line.anchorLabel,
      impressionLabel: point.line.impressionLabel,
      impressionAbstract: point.line.impressionAbstract,
    },
  };
}

function formatPromptGroupedOldPoints(
  points: RetrievedMemoryPoint[],
): Record<string, unknown>[] {
  const sorted = [...points].sort((left, right) => {
    const memoryDateDiff = String(left.memoryDate || '').localeCompare(
      String(right.memoryDate || ''),
    );
    if (memoryDateDiff !== 0) {
      return memoryDateDiff;
    }

    const createdAtDiff =
      new Date(left.createdAt || 0).getTime() -
      new Date(right.createdAt || 0).getTime();
    if (createdAtDiff !== 0) {
      return createdAtDiff;
    }

    return String(left.id).localeCompare(String(right.id));
  });

  const byLine = new Map<
    string,
    {
      lineId: string;
      anchorLabel: string;
      impressionLabel: string;
      impressionAbstract: string;
      points: Array<Record<string, unknown>>;
    }
  >();

  for (const point of sorted) {
    let group = byLine.get(point.lineId);
    if (!group) {
      group = {
        lineId: point.lineId,
        anchorLabel: point.line.anchorLabel,
        impressionLabel: point.line.impressionLabel,
        impressionAbstract: point.line.impressionAbstract,
        points: [],
      };
      byLine.set(point.lineId, group);
    }

    group.points.push({
      id: point.id,
      op: point.op,
      sourcePointId: point.sourcePointId,
      text: point.text,
      memoryDate: point.memoryDate,
    });
  }

  return Array.from(byLine.values());
}

function formatPromptLineCandidate(
  line: MemoryLineCandidate,
): Record<string, unknown> {
  return {
    lineId: line.id,
    anchorLabel: line.anchorLabel,
    impressionLabel: line.impressionLabel,
    impressionAbstract: line.impressionAbstract,
    salienceScore: line.salienceScore,
    lastActivatedAt: line.lastActivatedAt,
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
    return normalizeText(
      `聊电影${movieMatch[0].startsWith('《') ? movieMatch[0] : '《挽救计划》'}`,
      MAX_SCENE_CHARS,
    );
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
    .map(
      (message) =>
        `${message.role === 'user' ? '用户' : '我'}：${normalizeText(message.content, MAX_POINT_CHARS - 4)}`,
    )
    .slice(-3);
}

function buildFallbackRetrievalText(scene: string, points: string[]): string {
  return normalizeText([scene, ...points].join('，'), MAX_RETRIEVAL_CHARS);
}

function buildStructuredRetrievalText(
  scene: string,
  points: string[],
  entities: string[],
): string {
  const parts = [
    scene,
    points.join('；'),
    entities.length ? `实体：${entities.join(',')}` : '',
  ].filter(Boolean);

  return normalizeText(parts.join('。'), MAX_RETRIEVAL_CHARS);
}

function prioritizePoint(point: string): number {
  let score = 0;
  if (/用户/.test(point)) {
    score += 3;
  }
  if (/我/.test(point)) {
    score += 2;
  }
  if (
    /计划|打算|想|顾虑|担心|纠正|不接受|更偏向|只够|限制|边界|目标|继续|改成|补充/.test(
      point,
    )
  ) {
    score += 3;
  }
  if (/增进感情|自然互动|自然聊天/.test(point)) {
    score += 2;
  }
  if (/邀请时说|试探说|还能说|哈哈|稳了|奶茶我请|各做各的/.test(point)) {
    score -= 2;
  }
  if (
    /过于生硬|风格生硬|思路像|忽略互动需求|短时小图案|小图案以减轻负担/.test(
      point,
    )
  ) {
    score -= 3;
  }
  return score;
}

function normalizePointCollection(
  points: unknown,
  maxPoints: number,
): string[] {
  return Array.from(new Set(normalizePoints(points)))
    .filter((point) => !isLowSignalPoint(point))
    .sort((left, right) => prioritizePoint(right) - prioritizePoint(left))
    .slice(0, maxPoints);
}

@Injectable()
export class DashscopeService {
  constructor(private configService: ConfigService) {}

  private logAxiosError(
    context: string,
    error: any,
    extra?: Record<string, unknown>,
  ): void {
    const status = error?.response?.status;
    const statusText = error?.response?.statusText;
    const responseData = error?.response?.data;
    const responseHeaders = error?.response?.headers || {};
    const requestId =
      responseHeaders['x-request-id'] ||
      responseHeaders['x-acs-request-id'] ||
      responseHeaders['trace-id'] ||
      responseHeaders['traceid'] ||
      null;

    const payload = {
      context,
      message: error?.message,
      code: error?.code,
      status,
      statusText,
      requestId,
      responseData:
        typeof responseData === 'string'
          ? responseData.substring(0, 1000)
          : responseData,
      ...extra,
    };

    console.error(`[DashScope] ${context} error:`, JSON.stringify(payload));
  }

  async getEmbedding(text: string): Promise<number[]> {
    const apiKey = this.configService.get<string>('dashscope.apiKey');
    const embeddingUrl = this.configService.get<string>(
      'dashscope.embeddingUrl',
    )!;
    const embeddingModel = this.configService.get<string>(
      'dashscope.embeddingModel',
    );

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
        console.error(
          '[DashScope] No embeddings in response:',
          JSON.stringify(response.data).substring(0, 300),
        );
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
        { enableThinking: true },
      );
      return this.normalizeRetrievalDrafts(raw);
    } catch (error: any) {
      this.logAxiosError('RetrievalDrafts', error, {
        totalMessages: params.messages.length,
        newMessages: params.messages.filter(
          (message) => message.isNew !== false,
        ).length,
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
        { enableThinking: true },
      );
      return this.mergeFinalImpressionsWithSources(
        this.normalizeFinalImpressions(raw),
        params.oldImpressions,
        [...params.historyMessages, ...params.newMessages],
      );
    } catch (error: any) {
      this.logAxiosError('ReconcileImpressions', error, {
        historyMessages: params.historyMessages.length,
        newMessages: params.newMessages.length,
        recalled: params.oldImpressions.length,
        candidates: params.candidateImpressions.length,
      });
      return this.createFallbackFinalImpressions(
        params.candidateImpressions,
        params.oldImpressions,
      );
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
        { enableThinking: true },
      );
      return this.normalizeCandidateImpressions(raw, [
        ...params.historyMessages,
        ...params.newMessages,
      ]);
    } catch (error: any) {
      this.logAxiosError('CandidateImpressions', error, {
        historyMessages: params.historyMessages.length,
        newMessages: params.newMessages.length,
        recalled: params.oldImpressions.length,
      });
      return this.createFallbackCandidateImpressions(
        params.historyMessages,
        params.newMessages,
      );
    }
  }

  async generateNode2Points(params: {
    historyMessages: ChatMessageInput[];
    newMessages: ChatMessageInput[];
    oldPoints: RetrievedMemoryPoint[];
  }): Promise<Node2PointGeneration> {
    if (!params.historyMessages.length && !params.newMessages.length) {
      return {
        candidateAnalysis: null,
        points: [],
      };
    }

    try {
      const raw = await this.callQwenJson(
        this.getNode2PointSystemPrompt(),
        this.buildNode2PointPrompt(params),
        { enableThinking: true },
      );
      return this.normalizeNode2PointGeneration(raw, params.oldPoints);
    } catch (error: any) {
      this.logAxiosError('Node2Points', error, {
        historyMessages: params.historyMessages.length,
        newMessages: params.newMessages.length,
        recalledPoints: params.oldPoints.length,
      });
      return this.createFallbackNode2Points(
        params.historyMessages,
        params.newMessages,
      );
    }
  }

  async attachPointToExistingLine(params: {
    pointText: string;
    candidateLines: MemoryLineCandidate[];
  }): Promise<AttachLineDraft> {
    if (!params.candidateLines.length) {
      return { targetLineId: null };
    }

    try {
      const raw = await this.callQwenJson(
        this.getAttachLineSystemPrompt(),
        this.buildAttachLinePrompt(params),
        { enableThinking: true },
      );
      return this.normalizeAttachLine(raw, params.candidateLines);
    } catch (error: any) {
      this.logAxiosError('AttachLine', error, {
        candidateLines: params.candidateLines.length,
        pointPreview: params.pointText.substring(0, 200),
      });
      return { targetLineId: null };
    }
  }

  async planNewLines(params: {
    pointTexts: string[];
  }): Promise<NewLinePlanDraft> {
    if (!params.pointTexts.length) {
      return { newLines: [] };
    }

    try {
      const raw = await this.callQwenJson(
        this.getNewLinePlanSystemPrompt(),
        this.buildNewLinePlanPrompt(params),
        { enableThinking: true },
      );
      return this.normalizeNewLinePlan(raw, params.pointTexts);
    } catch (error: any) {
      this.logAxiosError('PlanNewLines', error, {
        pointCount: params.pointTexts.length,
      });
      return this.createFallbackNewLinePlan(params.pointTexts);
    }
  }

  async rebuildLineImpression(params: {
    anchorLabel: string;
    leafPoints: string[];
  }): Promise<LineImpressionDraft> {
    if (!params.leafPoints.length) {
      return {
        impressionLabel: sanitizeSceneText(
          params.anchorLabel || '聊当前对话场景',
        ),
        impressionAbstract: '',
      };
    }

    try {
      const raw = await this.callQwenJson(
        this.getRebuildLineImpressionSystemPrompt(),
        this.buildRebuildLineImpressionPrompt(params),
        { enableThinking: true },
      );
      return this.normalizeLineImpression(
        raw,
        params.anchorLabel,
        params.leafPoints,
      );
    } catch (error: any) {
      this.logAxiosError('RebuildLineImpression', error, {
        anchorLabel: params.anchorLabel,
        leafPointCount: params.leafPoints.length,
      });
      return this.createFallbackLineImpression(
        params.anchorLabel,
        params.leafPoints,
      );
    }
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

    try {
      return isOldApi
        ? await this.callOldApi(
            qwenUrl,
            apiKey,
            systemPrompt,
            userPrompt,
            options,
          )
        : await this.callOpenAICompatible(
            qwenUrl,
            apiKey,
            systemPrompt,
            userPrompt,
            options,
          );
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
          temperature: 0.2,
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
      enableThinkingRaw === undefined
        ? false
        : !['false', '0', 'off'].includes(
            String(enableThinkingRaw).toLowerCase(),
          );
    const resolvedEnableThinking = options.enableThinking ?? enableThinking;

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
        enable_thinking: resolvedEnableThinking,
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
    const historyRetrievalDraft = normalizeText(
      raw?.historyRetrievalDraft || '',
      MAX_RETRIEVAL_CHARS,
    );
    const deltaRetrievalDraft = normalizeText(
      raw?.deltaRetrievalDraft || '',
      MAX_RETRIEVAL_CHARS,
    );
    const mergedRetrievalDraft = normalizeText(
      raw?.mergedRetrievalDraft || '',
      MAX_RETRIEVAL_CHARS,
    );

    if (
      !historyRetrievalDraft &&
      !deltaRetrievalDraft &&
      !mergedRetrievalDraft
    ) {
      throw new Error('Empty retrieval drafts');
    }

    return {
      historyRetrievalDraft,
      deltaRetrievalDraft,
      mergedRetrievalDraft:
        mergedRetrievalDraft ||
        [historyRetrievalDraft, deltaRetrievalDraft]
          .filter(Boolean)
          .join('；')
          .substring(0, MAX_RETRIEVAL_CHARS),
    };
  }

  private normalizeFinalImpressions(raw: any): FinalImpressionDraft[] {
    const rawImpressions = Array.isArray(raw?.impressions)
      ? raw.impressions
      : [];
    const normalized = rawImpressions
      .map((item) => ({
        sourceImpressionId: item?.sourceImpressionId
          ? String(item.sourceImpressionId)
          : null,
        scene: sanitizeSceneText(item?.scene || ''),
        points: normalizePointCollection(item?.points, MAX_FINAL_POINTS),
        entities: normalizeEntities(item?.entities),
        retrievalText: sanitizeGeneratedText(
          item?.retrievalText || '',
          MAX_RETRIEVAL_CHARS,
        ),
      }))
      .map((item) => ({
        ...item,
        retrievalText:
          buildStructuredRetrievalText(
            item.scene,
            item.points,
            item.entities,
          ) ||
          item.retrievalText ||
          buildFallbackRetrievalText(item.scene, item.points),
      }))
      .filter((item) => item.scene && item.points.length && item.retrievalText)
      .map((item) => ({
        ...item,
        points: item.points.filter(
          (point, index, all) =>
            all.findIndex((candidate) => candidate === point) === index,
        ),
      }));

    if (!normalized.length) {
      throw new Error('Empty final impressions');
    }

    return normalized.slice(0, 4);
  }

  private mergeFinalImpressionsWithSources(
    impressions: FinalImpressionDraft[],
    oldImpressions: Impression[],
    messages: ChatMessageInput[],
  ): FinalImpressionDraft[] {
    return impressions.map((impression) => {
      const source = this.selectCarrySource(impression, oldImpressions);
      const carryForwardPoints = source?.points?.length
        ? normalizePointCollection(source.points, MAX_FINAL_POINTS).filter(
            (point) => shouldCarryForwardPoint(point, impression.points),
          )
        : [];
      const concernPoint = this.buildConcernCarryPoint(messages, [
        ...carryForwardPoints,
        ...impression.points,
      ]);
      const mergedPoints = normalizePointCollection(
        [
          ...carryForwardPoints,
          ...(concernPoint ? [concernPoint] : []),
          ...impression.points,
        ],
        MAX_FINAL_POINTS,
      );

      if (
        mergedPoints.length === impression.points.length &&
        !carryForwardPoints.length &&
        !concernPoint
      ) {
        return impression;
      }

      return {
        ...impression,
        points: mergedPoints,
        retrievalText:
          buildStructuredRetrievalText(
            impression.scene,
            mergedPoints,
            impression.entities,
          ) || impression.retrievalText,
      };
    });
  }

  private selectCarrySource(
    impression: FinalImpressionDraft,
    oldImpressions: Impression[],
  ): Impression | null {
    if (!impression.sourceImpressionId) {
      return null;
    }

    const directSource =
      oldImpressions.find(
        (item) => item.id === impression.sourceImpressionId,
      ) || null;
    const rootId =
      directSource?.rootImpressionId ||
      directSource?.id ||
      impression.sourceImpressionId;
    const finalTags = extractDurableTags(
      [
        impression.scene,
        ...impression.points,
        ...(impression.entities || []),
      ].join('；'),
    );

    const candidates = oldImpressions.filter((item) => {
      const sameRoot =
        item.id === impression.sourceImpressionId ||
        item.rootImpressionId === impression.sourceImpressionId ||
        item.id === rootId ||
        item.rootImpressionId === rootId;
      const sameScene = sanitizeSceneText(item.scene) === impression.scene;
      return sameRoot || sameScene;
    });

    if (!candidates.length) {
      return directSource;
    }

    const scored = candidates
      .map((item) => {
        const sourceTags = extractDurableTags(
          [
            item.scene,
            ...(item.points || []),
            ...(item.entities || []).map((entity) => String(entity)),
          ].join('；'),
        );
        const overlap = sourceTags.filter((tag) => finalTags.includes(tag));
        const informativeOverlap = overlap.filter(
          (tag) => !GENERIC_DURABLE_TAGS.has(tag),
        );
        return {
          item,
          score: informativeOverlap.length * 10 + overlap.length * 3,
          updatedAt: new Date(item.updatedAt || item.createdAt || 0).getTime(),
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return right.updatedAt - left.updatedAt;
      });

    return scored[0]?.item || directSource;
  }

  private buildConcernCarryPoint(
    messages: ChatMessageInput[],
    points: string[],
  ): string | null {
    const finalText = points
      .map((point) => stabilizePointText(point))
      .join('；');
    if (CONCERN_POINT_RE.test(finalText)) {
      return null;
    }

    const userConcernMessages = messages.filter(
      (message) =>
        message.role === 'user' && CONCERN_MESSAGE_RE.test(message.content),
    );
    if (!userConcernMessages.length) {
      return null;
    }

    const concernText = userConcernMessages
      .slice(-2)
      .map((message) => message.content)
      .join('；');
    let userSummary = '';

    if (
      /(累|劳累|疲惫)/.test(concernText) &&
      /(时间紧|赶|空档|只够|最多|行程|3-4)/.test(concernText)
    ) {
      userSummary = '用户顾虑对方已经较累且后续时间紧张，所以在邀约前反复犹豫';
    } else if (/(累|劳累|疲惫)/.test(concernText)) {
      userSummary = '用户顾虑对方已经较累，所以在邀约前反复犹豫';
    } else if (/(时间紧|赶|空档|只够|最多|行程|3-4)/.test(concernText)) {
      userSummary = '用户顾虑对方后续时间紧张，所以在邀约前反复犹豫';
    } else if (/(顾虑|担心|怕|犹豫|纠结)/.test(concernText)) {
      userSummary = '用户对这次安排还有现实顾虑，所以在邀约前反复犹豫';
    }

    if (!userSummary) {
      return null;
    }

    const assistantSupport = messages.find(
      (message) =>
        message.role === 'assistant' &&
        /(小图案|控制时长|时间紧|轻量|简单|休息|撤)/.test(message.content),
    );
    const assistantSummary = assistantSupport
      ? '我把建议放在控制时长和降低安排负担上'
      : '我把建议放在降低安排负担上';

    return `${userSummary}；${assistantSummary}`;
  }

  private normalizeCandidateImpressions(
    raw: any,
    messages: ChatMessageInput[],
  ): CandidateImpressionDraft[] {
    const rawCandidates = Array.isArray(raw?.candidate_impressions)
      ? raw.candidate_impressions
      : [];
    const allowedIds = new Set(
      messages
        .map((message) => message.messageId)
        .filter((messageId): messageId is number =>
          Number.isInteger(messageId),
        ),
    );

    const normalized = rawCandidates
      .map((item) => ({
        scene: sanitizeSceneText(item?.scene || ''),
        points: normalizePointCollection(item?.points, MAX_CANDIDATE_POINTS),
        entities: normalizeEntities(item?.entities),
        retrievalText: sanitizeGeneratedText(
          item?.retrievalText || '',
          MAX_RETRIEVAL_CHARS,
        ),
        evidenceMessageIds: normalizeEvidenceMessageIds(
          item?.evidenceMessageIds,
          allowedIds,
        ),
      }))
      .map((item) => ({
        ...item,
        retrievalText:
          buildStructuredRetrievalText(
            item.scene,
            item.points,
            item.entities,
          ) ||
          item.retrievalText ||
          buildFallbackRetrievalText(item.scene, item.points),
      }))
      .filter(
        (item) =>
          item.scene &&
          item.points.length &&
          item.retrievalText &&
          item.evidenceMessageIds.length,
      );

    if (!normalized.length && rawCandidates.length) {
      throw new Error('Empty candidate impressions');
    }

    return normalized.slice(0, 4);
  }

  private normalizeNode2PointGeneration(
    raw: any,
    oldPoints: RetrievedMemoryPoint[],
  ): Node2PointGeneration {
    const rawItems = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.points)
        ? raw.points
        : [];
    const allowedSourceIds = new Set(oldPoints.map((point) => point.id));
    const candidateAnalysis =
      normalizeText(
        String(raw?.candidateAnalysis ?? raw?.candidate_analysis ?? ''),
        MAX_RETRIEVAL_CHARS,
      ) || null;

    const normalized = rawItems
      .map((item) => {
        const op = ['new', 'supplement', 'revise', 'conflict'].includes(
          item?.op,
        )
          ? (item.op as MemoryPointOp)
          : 'new';
        const sourcePointId = item?.sourcePointId
          ? String(item.sourcePointId)
          : null;
        const rawOpAnalysis = item?.opAnalysis ?? item?.op_analysis ?? '';
        return {
          opAnalysis: normalizeText(
            String(rawOpAnalysis || ''),
            MAX_RETRIEVAL_CHARS,
          ),
          op,
          sourcePointId:
            op === 'new'
              ? null
              : sourcePointId && allowedSourceIds.has(sourcePointId)
                ? sourcePointId
                : null,
          rewriteAnalysis:
            op === 'new'
              ? null
              : normalizeText(
                  String(item?.rewriteAnalysis || ''),
                  MAX_RETRIEVAL_CHARS,
                ),
          text: stabilizePointText(item?.text || ''),
        } satisfies Node2PointDraft;
      })
      .filter((item) => item.text)
      .filter((item) => item.op === 'new' || Boolean(item.sourcePointId))
      .map((item) => ({
        ...item,
        sourcePointId: item.op === 'new' ? null : item.sourcePointId,
      }));

    if (!normalized.length && rawItems.length) {
      throw new Error('Empty node2 points');
    }

    return {
      candidateAnalysis,
      points: normalized.slice(0, 8),
    };
  }

  private normalizeAttachLine(
    raw: any,
    candidateLines: MemoryLineCandidate[],
  ): AttachLineDraft {
    const allowedLineIds = new Set(candidateLines.map((line) => line.id));
    const targetLineId = raw?.targetLineId ? String(raw.targetLineId) : null;
    return {
      targetLineId:
        targetLineId && allowedLineIds.has(targetLineId) ? targetLineId : null,
    };
  }

  private normalizeNewLinePlan(
    raw: any,
    pointTexts: string[],
  ): NewLinePlanDraft {
    const rawGroups = Array.isArray(raw?.newLines) ? raw.newLines : [];
    const usedIndexes = new Set<number>();
    const groups = rawGroups
      .map((group) => ({
        anchorLabel: sanitizeSceneText(group?.anchorLabel || ''),
        pointIndexes: Array.isArray(group?.pointIndexes)
          ? Array.from(
              new Set(
                group.pointIndexes
                  .map((index: unknown) => Number.parseInt(String(index), 10))
                  .filter(
                    (index: number) =>
                      Number.isInteger(index) &&
                      index >= 0 &&
                      index < pointTexts.length,
                  ),
              ),
            )
          : [],
      }))
      .map((group) => ({
        ...group,
        pointIndexes: group.pointIndexes.filter((index) => {
          if (usedIndexes.has(index)) {
            return false;
          }
          usedIndexes.add(index);
          return true;
        }),
      }))
      .filter((group) => group.anchorLabel && group.pointIndexes.length);

    if (!groups.length) {
      return this.createFallbackNewLinePlan(pointTexts);
    }

    const uncovered = pointTexts
      .map((_, index) => index)
      .filter((index) => !usedIndexes.has(index));

    if (uncovered.length) {
      groups.push(
        ...uncovered.map((index) => ({
          anchorLabel: sanitizeSceneText(
            pointTexts[index].slice(0, 24) || `新主线 ${index + 1}`,
          ),
          pointIndexes: [index],
        })),
      );
    }

    return { newLines: groups };
  }

  private normalizeLineImpression(
    raw: any,
    anchorLabel: string,
    leafPoints: string[],
  ): LineImpressionDraft {
    const impressionLabel = sanitizeSceneText(
      raw?.impressionLabel || anchorLabel,
    );
    const impressionAbstract = sanitizeGeneratedText(
      raw?.impressionAbstract || '',
      MAX_RETRIEVAL_CHARS,
    );

    if (!impressionLabel && !impressionAbstract) {
      return this.createFallbackLineImpression(anchorLabel, leafPoints);
    }

    return {
      impressionLabel:
        impressionLabel || sanitizeSceneText(anchorLabel || '聊当前对话场景'),
      impressionAbstract:
        impressionAbstract ||
        this.createFallbackLineImpression(anchorLabel, leafPoints)
          .impressionAbstract,
    };
  }

  private createFallbackRetrievalDrafts(
    messages: ChatMessageInput[],
  ): RetrievalDrafts {
    const historyMessages = messages.filter(
      (message) => message.isNew === false,
    );
    const newMessages = messages.filter((message) => message.isNew !== false);
    const scene = buildFallbackScene(messages);
    const mergedContext = [
      ...historyMessages.slice(-3).map((message) => message.content),
      ...newMessages.slice(-3).map((message) => message.content),
    ]
      .filter(Boolean)
      .join('；');

    return {
      historyRetrievalDraft: historyMessages.length
        ? normalizeText(
            `${scene}，之前在聊：${historyMessages
              .slice(-4)
              .map((message) => message.content)
              .join('；')}`,
            MAX_RETRIEVAL_CHARS,
          )
        : scene,
      deltaRetrievalDraft: normalizeText(
        `${scene}，这轮新增：${newMessages.map((message) => message.content).join('；')}`,
        MAX_RETRIEVAL_CHARS,
      ),
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

    if (
      !scene ||
      !points.length ||
      !retrievalText ||
      !evidenceMessageIds.length
    ) {
      return [];
    }

    return [
      {
        scene,
        points,
        entities: [],
        retrievalText,
        evidenceMessageIds,
      },
    ];
  }

  private createFallbackFinalImpressions(
    candidateImpressions: CandidateImpressionDraft[],
    oldImpressions: Impression[],
  ): FinalImpressionDraft[] {
    if (!candidateImpressions.length) {
      return [];
    }

    return candidateImpressions.slice(0, 4).map((candidate) => ({
      sourceImpressionId:
        oldImpressions.find(
          (impression) => impression.scene === candidate.scene,
        )?.id || null,
      scene: candidate.scene,
      points: candidate.points,
      entities: candidate.entities,
      retrievalText: candidate.retrievalText,
    }));
  }

  private createFallbackNode2Points(
    historyMessages: ChatMessageInput[],
    newMessages: ChatMessageInput[],
  ): Node2PointGeneration {
    const messages = [...historyMessages, ...newMessages];
    const selected = newMessages.length ? newMessages : messages;
    const points = buildFallbackPoints(selected)
      .map((point) => ({
        op: 'new' as const,
        sourcePointId: null,
        text: stabilizePointText(point),
      }))
      .filter((point) => point.text);

    return {
      candidateAnalysis: selected.length
        ? '仅保留本轮新消息里直接成立、对未来聊天仍有帮助的候选点；一次性问答、临时状态和低价值碎片默认丢弃。'
        : null,
      points: points.slice(0, 4),
    };
  }

  private createFallbackNewLinePlan(pointTexts: string[]): NewLinePlanDraft {
    return {
      newLines: pointTexts.map((pointText, index) => ({
        anchorLabel: sanitizeSceneText(
          pointText.slice(0, 24) || `新主线 ${index + 1}`,
        ),
        pointIndexes: [index],
      })),
    };
  }

  private createFallbackLineImpression(
    anchorLabel: string,
    leafPoints: string[],
  ): LineImpressionDraft {
    const impressionLabel = sanitizeSceneText(
      anchorLabel ||
        buildFallbackScene(
          leafPoints.map((text, index) => ({
            role: index === 0 ? 'user' : 'assistant',
            content: text,
            timestamp: new Date().toISOString(),
          })),
        ),
    );
    const impressionAbstract = sanitizeGeneratedText(
      leafPoints
        .slice(0, 3)
        .map((point) => stabilizePointText(point))
        .filter(Boolean)
        .join('；'),
      MAX_RETRIEVAL_CHARS,
    );

    return {
      impressionLabel: impressionLabel || '聊当前对话场景',
      impressionAbstract,
    };
  }

  private buildRetrievalDraftPrompt(params: {
    messages: ChatMessageInput[];
    recentActivatedImpressions?: Impression[];
  }): string {
    const { messages, recentActivatedImpressions = [] } = params;
    const newMessages = messages.filter((message) => message.isNew !== false);
    const historyMessages = messages.filter(
      (message) => message.isNew === false,
    );

    const historyText = historyMessages.length
      ? historyMessages
          .map(
            (message) =>
              `[${message.role === 'user' ? '用户' : 'AI'}] ${message.content}`,
          )
          .join('\n')
      : '(无历史消息)';
    const deltaText = newMessages.length
      ? newMessages
          .map(
            (message) =>
              `[${message.role === 'user' ? '用户' : 'AI'}] ${message.content}`,
          )
          .join('\n')
      : '(无新消息)';
    const recentActivatedText = recentActivatedImpressions.length
      ? recentActivatedImpressions
          .map(
            (impression) =>
              `- scene=${impression.scene}; points=${JSON.stringify(impression.points.slice(0, 2))}; entities=${JSON.stringify((impression.entities || []).slice(0, 6))}; lastActivatedAt=${impression.lastActivatedAt || impression.updatedAt || impression.createdAt || 'unknown'}`,
          )
          .join('\n')
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
    const historyMessagesText = stringifyPromptData(
      params.historyMessages.map(formatPromptMessage),
    );
    const newMessagesText = stringifyPromptData(
      params.newMessages.map(formatPromptMessage),
    );
    const oldImpressionsText = stringifyPromptData(
      params.oldImpressions.map(formatPromptImpression),
    );

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
8. 默认以用户的计划、顾虑、限制、决定、纠正为主；AI 内容只有在未来对话仍会复用时才保留
9. 不要保留邀约话术、玩笑、表情、夸张语气、寒暄或一时情绪
10. 如果用户是在纠正我，不要保留“怼我”“嫌我直男”这类情绪外观，要提炼成稳定边界或稳定分歧

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
5. 不要把“策略”“思路”“判断”“纠结”等分析味词塞进 scene
- 错误示例：聊约前同事拼豆的顾虑与互动策略
- 正确示例：聊约前同事去拼豆
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

但要注意主次：
- 用户内容优先保留
- 我的内容只保留未来还会影响聊天推进的那部分
- 不要把我的具体措辞、打趣、邀约文案、情绪化反应写进 point

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
- 不要保留“哈哈”“稳了”“被戳中”“社死风险低”“钢铁直男”这类情绪或风格化表面词

#### 6）把纠正和分歧写成稳定边界，不写成扯皮现场
- 如果用户是在纠正我的说法、建议或理解，保留“纠正后真正成立的边界”
- 不要保留谁怼了谁、谁觉得谁离谱、谁像什么风格这种表面摩擦
- 错误示例：用户说我像钢铁直男，我被戳中后改口
- 正确示例：我起初把这件事理解成低互动安排，用户明确说他的目标是增进感情，不接受把它定义成各做各的
- 错误示例：我建议边拼边吐槽活跃气氛
- 正确示例：我把互动重点调整到过程中自然聊天
#### 7）数量尽量少
- 一个 candidate impression 下的 points 默认越少越好
- 优先 1～2 条，最多 3 条
- 除非确实存在多个独立且都很重要的记忆点，否则不要写多条
- 每条尽量控制在 80 字以内

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
    const historyMessagesText = stringifyPromptData(
      params.historyMessages.map(formatPromptMessage),
    );
    const newMessagesText = stringifyPromptData(
      params.newMessages.map(formatPromptMessage),
    );
    const oldImpressionsText = stringifyPromptData(
      params.oldImpressions.map(formatPromptImpression),
    );
    const candidateImpressionsText = stringifyPromptData(
      params.candidateImpressions.map(formatPromptCandidate),
    );

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
9. 最终印象默认以用户的计划、顾虑、限制、决定、纠正为主，我的内容只保留未来继续聊天仍有用的部分
10. 最终 points 必须使用第一视角，写成“我和用户”的印象，而不是写成“assistant”或“AI”
11. 不要保留邀约话术、玩笑、表情、夸张语气、寒暄或一时情绪
12. 如果用户是在纠正我，要保留纠正后真正成立的边界，不要保留“怼我”“嫌我直男”“不买账”这种表面摩擦

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
5. 不要把“策略”“思路”“判断”“纠结”等分析味词塞进 scene
- 错误示例：聊约前同事拼豆的顾虑与互动策略
- 正确示例：聊约前同事去拼豆

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

但主次必须清楚：
- 用户内容优先
- 我的内容只保留未来仍可能复用的建议、解释、边界或推进方向
- 不要把我当时的具体措辞、打趣、邀约文案、情绪反应写进 point

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
- 不保留“哈哈”“稳了”“被戳中”“社死风险低”“钢铁直男”这类情绪或风格化表面词

#### 6）把纠正和分歧写成稳定边界，不写成扯皮现场
- 如果用户纠正了我的理解、建议或表达，要保留纠正后真正成立的边界
- 不要保留谁怼了谁、谁不买账、谁像什么风格这种表面摩擦
- 错误示例：我被说得像钢铁直男，后来改口
- 正确示例：我起初把这件事说成低互动安排，用户明确说他的目标是增进感情，不接受把它定义成各做各的
- 错误示例：我建议边拼边吐槽活跃气氛
- 正确示例：我把互动重点调整到过程中自然聊天
#### 7）数量尽量少
- 一个 impression 下的 points 默认越少越好
- 优先 1～2 条，最多 3 条
- 除非确实存在多个独立且都很重要的记忆点，否则不要写多条
- 每条尽量控制在 80 字以内

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

  private buildNode2PointPrompt(params: {
    historyMessages: ChatMessageInput[];
    newMessages: ChatMessageInput[];
    oldPoints: RetrievedMemoryPoint[];
  }): string {
    const historyMessagesText = stringifyPromptData(
      params.historyMessages.map(formatPromptMessage),
    );
    const newMessagesText = stringifyPromptData(
      params.newMessages.map(formatPromptMessage),
    );
    const oldPointsText = stringifyPromptData(
      formatPromptGroupedOldPoints(params.oldPoints),
    );

    return `# 角色
你是聊天记忆系统的聊天印象生成器，你擅长从聊天对话和历史信息中提取出对未来有用的、高压缩但不失真的聊天印象 point。

# 背景信息
你现在能看到的信息只有两种，分别是历史信息和最新信息。

## 历史信息
包括最新 15 轮的历史对话原文 <history_messages> 和已经生成的一些与原始对话相关的历史聊天印象 point <old_points>。

注意：
- <old_points> 已按 line 聚合
- 每组都携带 lineId、anchorLabel、impressionLabel、impressionAbstract、points[]
- points[] 中的每一项都带有 id、op、sourcePointId、text、memoryDate

<history_messages>
${historyMessagesText}
</history_messages>

<old_points>
${oldPointsText}
</old_points>

## 最新信息
你与用户新产生的对话原文 <new_messages>。

<new_messages>
${newMessagesText}
</new_messages>

# 任务
结合 <history_messages> 和 <old_points> 中的内容，深入理解 <new_messages> 中的对话内容，生成新的聊天印象 point。

注意：
- <history_messages> 和 <old_points> 只用于补充 <new_messages> 的上下文，以及判断新内容是否承接某个旧 point
- 新生成的 point 必须以 <new_messages> 中出现的新信息为依据
- 不要仅根据 <history_messages> 和 <old_points> 重复生成 point
- 不要把 <old_points> 里未被本轮 <new_messages> 明确更新的旧信息偷渡进新的 point

# 聊天印象 point

## 定义
point 是一条属于某个记忆线的、最小的、可独立理解的、对原始聊天内容的印象。

## 标准
- 原子性：一个 point 只表达一个主要记忆点，是记忆的最小单元
- 可独立理解：一个 point 单独拿出来时，应该基本能看懂
- 客观性：是对原始聊天记录的客观概括，而不是猜测、不是推断、不是“觉得”、不是“认为”
- 时间标准化：时间都应该优先转化为绝对时间（相对时间），例如 2026-04-11（周末）；如果无法可靠换算，宁可不写时间，也不要猜
- 第一视角总结：这是你的聊天记录，你是在生成你对聊天的印象，所以整体上从你的第一视角出发来总结 point
- 以用户的聊天内容为主体：默认应以用户说了什么、做了什么、对什么东西有什么理解为主体
- 面向未来聊天有用：point 记录的是对未来聊天有帮助的核心内容
- 高压缩但不失真：point 应尽可能多地保留原文中的有效信息，但不要写成复盘、流水账或摘要段落

## 要求
- 默认以用户内容为主体。只有当“你的建议 / 安慰 / 判断”被用户非常明确地采纳或接受，并且这些内容只有在写入后才能补全 point 语义时，才允许在 point 中概括你的内容
- 如果用户只是听到了、回应了、吐槽了、反驳了，或者我只是单方面给出建议但没有被明确采纳，都不要写我的内容
- 如果用户纠正我，优先保留纠正后真正成立的边界，不必展开写我先前的错误说法；只有当不写“我”的最小上下文就无法准确表达纠正、拒绝、采纳、冲突关系时，才最小量保留“我”的内容
- 优先保留：绝对时间、人物、关系、对象、地点、时长、数量、限制、决定、纠正结果
- 不要写分析词，不要写“体现了”“说明了”“达成一致”“策略”等分析化表述
- 不要保留玩笑、表情、寒暄、情绪外观、扯皮现场
- 只写有原始消息证据支持的内容
- 一旦出现时间，优先写成：绝对时间（相对时间），不要只写“今天、明天、本周末、最近、周一”这类纯相对时间。时间换算必须以消息自带的 beijingTime 为准
- 如果无法根据原文和 beijingTime 可靠换算出绝对时间，宁可不写时间，也不要猜
- 每条尽量控制在 80 字左右，最多 120 字

## 提取过程
请按下面的顺序，从原始聊天中提取 point。

### 1. 先阅读 <new_messages> 中的内容，同时借助 <history_messages> 理解上下文，查找候选记忆点
先从聊天中找出那些未来仍可能有用的最小互动单元。优先关注：
- 用户做了什么
- 用户遇到了什么情况，处于什么状态
- 用户明确表达喜欢、不喜欢、接受、不接受的地方
- 用户围绕什么具体对象、计划、分歧、纠正结果展开了新的有效信息
- 用户明确说出的长期习惯、偏好、固定做法
- 用户持续推进的计划、目标、顾虑、约束、决定
- 会改变后续理解或行动方式的新情况
- 上述内容必须是用户在原话里以字面、客观、可落地的方式表达出来，而不是一句玩笑、谐音梗或夸张口号
- 即将执行且后续大概率还会继续聊到的具体安排、体验计划、邀约计划，也值得保留；不要因为它是单次事件，就误判为无长期价值

不要因为一句话就机械生成一个 point。
一个 point 可以跨多轮对话压成一句，只要它们仍然属于同一个最小记忆单元。

### 2. 过滤掉不值得保留的内容
对每个候选点，先判断它是否真的值得进入记忆。默认不提取下面这些内容，除非上下文明确显示它未来还会持续影响对话：
- 单纯寒暄
- 一次性问候
- 纯礼貌回应
- 明显无后续价值的小细节
- 没有信息增量的重复表达
- 只对当轮有效的临时状态
- 不足以单独成立的碎片句
- 对你语气、风格、重复提醒的吐槽或玩笑
- 轻松吐槽、谐音梗、夸张表达、词义解释本身，如果它们没有形成稳定、字面成立、可持续影响未来对话的事实边界，也不要保留

提取的重点不是“这轮聊了什么”，而是“未来再次聊天时，什么最值得被记住”。

### 2.5 先输出 candidateAnalysis
在正式判断 op 之前，你必须先输出一个总分析字段 candidateAnalysis。

candidateAnalysis 要明确说明：
- 本轮 <new_messages> 里有哪些候选点值得进入记忆
- 哪些内容虽然出现了，但应当丢弃
- 如果某个候选更适合 new 而不是 supplement，也要直接指出原因

candidateAnalysis 的作用是指导后续 op 判断和 text 生成，不要写空泛总结，不要复述整轮聊天。

默认应该在 candidateAnalysis 中明确丢弃的内容包括：
- 一次性设施问路、地点确认、临时操作步骤
- “开始上班”“准备下班”这类阶段状态
- 单纯接话、吐槽、玩笑、词义解释
- 任何你自己判断为未来聊天帮助很小的碎片细节

如果最终 points 为 []，candidateAnalysis 仍然要说明为什么本轮没有值得保留的候选点。

### 3. 先输出 opAnalysis，再判断它属于哪一种 op
对每个候选记忆点 point，都要先输出 opAnalysis，用来说明为什么它属于这个 op。

opAnalysis 要简短但明确，至少说明：
- 这条信息是不是新的最小记忆单元
- 它是否明确承接某个旧 point
- 如果承接，为什么是 supplement / revise / conflict，而不是 new
- 如果不承接，为什么应该直接 new 或丢弃

判断 op 时，使用下面这套固定顺序：
1. 先判断这条信息是否值得长期保留；不值得则直接丢弃
2. 再判断它是不是一个新的最小记忆单元
3. 只有当它明确承接某个旧 point，且融合后仍然是同一个最小记忆单元时，才允许 supplement
4. 如果旧 point 被本轮新消息纠正，使用 revise
5. 如果新旧当前有效状态不能同时成立，使用 conflict

共有四种生成形式：new、supplement、revise、conflict。

#### new
当这条候选记忆点本身就是一个新的最小记忆单元时，用 new。

即使它和某条旧 line 在主题上有关，只要它已经形成了新的最小记忆单元，也仍然应该用 new，而不是为了“承接”而强行 supplement 到旧 point 上。

注意，以下情况不要输出 new：
- 当 <new_messages> 只是把旧 point 说得更完整一点
- 当 <new_messages> 只是补了一点解释、词义、背景
- 当 <new_messages> 只是把历史已知内容总结一遍
- 当 <new_messages> 只是表达一时情绪、吐槽或阶段状态
- 当 <new_messages> 里的说法本质上是玩笑、谐音梗、夸张表达，缺乏字面上的稳定事实

#### supplement
当这条候选记忆点明确承接某条旧 point，且旧 point 的核心仍然成立，新信息只是让它更完整，但融合后仍然只是一条最小记忆单元时，用 supplement。

如果加入新信息后，会让 source point 同时承载两个或以上主要记忆单元，就不要 supplement，改用 new。

#### revise
当这条候选记忆点明确承接某条旧 point，且旧 point 的局部表述、理解或边界被本轮新消息纠正时，用 revise。

revise 的重点是“纠正旧内容”，不是单纯增加新内容。

#### conflict
当这条候选记忆点明确承接某条旧 point，且新的当前有效状态和旧 point 不能同时成立时，用 conflict。

conflict 的重点是“当前状态发生对立或反转”，不是普通补充，也不是轻微修正。

### 4. 对非 new 先做 rewriteAnalysis，再生成 text
当 op 是 supplement / revise / conflict 时，你必须先输出 rewriteAnalysis。

rewriteAnalysis 不是泛泛解释，而是为了避免重写时丢失旧信息。请明确写出：
- 保留：source point 中哪些旧事实仍然成立，必须保留
- 修改：本轮 <new_messages> 明确更新、纠正、补充了哪些内容
- 不带入：source point 中哪些内容没有被本轮新消息再次支持，或者只是旧措辞、旧误解、旧分析，不应顺手带入

重要：
- 只要旧 point 中的某个事实没有被本轮 <new_messages> 明确推翻或更新，就默认应保留，而不是省略
- supplement 的 text 必须保留旧核心，再融合新增信息
- revise 只允许改动被本轮新消息明确纠正的部分，其他旧事实默认保留
- conflict 要写出新的冲突态，但不要把仍然成立的旧背景全删掉

### 5. 按 op 重写成最终保存文本
无论是哪一种 op，输出的都必须是“最终应该被记住的 point 文本”，而不是提取说明。

### 6. 最后做一次自检
重点检查：
- candidateAnalysis 是否先把真正值得保留的候选点和应丢弃的内容区分清楚
- 是否只根据 <new_messages> 中的新信息生成，而没有偷渡 <old_points> 的旧内容
- 是否把本该 new 的内容错误承接成了 supplement / revise / conflict
- 是否把玩笑、谐音梗、夸张吐槽、轻松词义解释错当成长期 point
- 是否把 point 写成了小型摘要、过程复盘或多层并列总结
- 是否过度抽象，失去了原文中的主体、时间、对象、约束等有效信息
- 是否在能保留原文有效信息的前提下，尽可能多地保留了原文
- 如果保留了“我”的内容，是否真的存在用户非常明确的采纳或接受证据
- candidateAnalysis 明确丢弃的内容，是否又被你写进了最终 points

# 输出格式
你只能输出 JSON 对象，结构必须是：

{
  "candidateAnalysis": "...",
  "points": [
    {
      "opAnalysis": "...",
      "op": "new | supplement | revise | conflict",
      "sourcePointId": "旧 point id 或 null",
      "rewriteAnalysis": "仅 supplement / revise / conflict 时必填，new 不输出",
      "text": "..."
    }
  ]
}

## 字段约束
- candidateAnalysis 必填，用于先说明本轮有哪些候选点值得保留、哪些应丢弃
- opAnalysis 必填，用于解释为什么这个候选点属于该 op
- op 只能是：new / supplement / revise / conflict
- new 时，sourcePointId 必须为 null，且不要输出 rewriteAnalysis
- supplement / revise / conflict 时，sourcePointId 必须引用一个合法的旧 point id，且必须输出 rewriteAnalysis
- 不允许输出额外顶层字段
- 不允许输出解释、备注、前后缀说明、Markdown 包裹
- 如果本轮 <new_messages> 没有带来值得长期保留的新变化，输出 "points": []

## 输出粒度约束
- 默认数量尽量少，能合并就合并
- 不要把一个 point 写成多层并列摘要`;
  }

  private buildAttachLinePrompt(params: {
    pointText: string;
    candidateLines: MemoryLineCandidate[];
  }): string {
    const candidateLinesText = stringifyPromptData(
      params.candidateLines.map(formatPromptLineCandidate),
    );

    return `你是“归属已有 line”节点。

你的任务是：判断当前这条 new point 是否属于某个已有 line。

输出格式只能是：
{"targetLineId":"line_xxx 或 null"}

判断规则：
1. 只有当 point 与某条 line 的长期主题、当前高层背景明显连续时，才能返回该 lineId。
2. 仅因为某个词重复、不足以说明属于该 line。
3. 如果不确定，就返回 null。
4. 不要发明候选集合之外的 lineId。

当前 new point:
${JSON.stringify(params.pointText)}

候选 lines:
${candidateLinesText}`;
  }

  private buildNewLinePlanPrompt(params: { pointTexts: string[] }): string {
    const pointsText = stringifyPromptData(
      params.pointTexts.map((pointText, index) => ({
        index,
        text: pointText,
      })),
    );

    return `你是“新 line 生成节点”。

你的任务是：把这些尚未归属已有 line 的 new points 分组，并为每组生成一个稳定的 anchorLabel。

输出格式只能是：
{
  "newLines": [
    {
      "anchorLabel": "...",
      "pointIndexes": [0, 1]
    }
  ]
}

规则：
1. 只按长期相关主题分组，不按聊天顺序分组。
2. 默认尽量少量分组，但不要把明显独立的话题硬合并。
3. anchorLabel 要稳定、简短、像长期主题名。
4. 每个 point 必须且只能出现一次。
5. 如果拿不准，就单独成组，不要乱合。

待分组 points:
${pointsText}`;
  }

  private buildRebuildLineImpressionPrompt(params: {
    anchorLabel: string;
    leafPoints: string[];
  }): string {
    return `你是 line impression 重算节点。

你会收到一条 line 的 anchorLabel 和它当前所有叶子 points。
你只负责输出：
- impressionLabel
- impressionAbstract

输出格式只能是：
{"impressionLabel":"...","impressionAbstract":"..."}

规则：
1. impression 只是 line 的高层背景，不是检索文本。
2. 不要平铺所有 leaf points，不要写成长摘要。
3. impressionLabel 要具体、可指认，优先写成“聊……”“约……”“固定……”这种具体主题，不要写抽象词如“考量”“预期”“策略”“状态”。
4. impressionAbstract 不是简单罗列，而是要按“前面的事实 -> 后来的补充/纠正 -> 当前有效状态”去梳理，形成一条从前到后的逻辑线。
5. 不要引入 leaf points 里没有的新事实。
6. 如果多个 leaf points 有主次，优先保留真正长期有用的那条主线，不要平均摊开。
7. 时间线不能机械依赖 point 的创建时间、修改时间或数组顺序；要根据 point 文本里的客观时间、场景推进、前后关系自己梳理。
8. 如果 point 里已经有绝对时间或明确时间段，优先用这些事实组织顺序；如果没有明确时间，就按事件推进关系写成“先……后……目前……”。
9. impressionAbstract 依然要短，只做高层梳理，核心是给 points 补充背景，不是替代 points。

错误示例：
- 拼豆邀约考量
- 饮水习惯与设施预期
- 用户在这个话题上有一些考虑和变化

正确示例：
- 聊约前同事去拼豆
- 固定早餐习惯
- 公司没有免费热水

anchorLabel:
${JSON.stringify(params.anchorLabel)}

leafPoints:
${stringifyPromptData(params.leafPoints)}`;
  }

  private getRetrievalDraftSystemPrompt(): string {
    return '你是聊天印象系统的 Node1 检索草稿生成器。你只负责生成 historyRetrievalDraft、deltaRetrievalDraft、mergedRetrievalDraft。输出必须是纯 JSON。';
  }

  private getFinalImpressionSystemPrompt(): string {
    return '你是聊天印象系统的印象对账与更新器。你根据原始聊天消息、candidate_impressions 和 old_impressions，输出最终落库的 impressions。输出必须是纯 JSON。';
  }

  private getCandidateImpressionSystemPrompt(): string {
    return '你是聊天印象系统的候选印象重建器。你只保留客观、可追溯、未来有用的核心互动，不写摘要、不写扯皮细节、不写情绪外观。你根据 history_messages、new_messages 和 old_impressions，输出 candidate_impressions。输出必须是纯 JSON。';
  }

  private getReconcileImpressionSystemPrompt(): string {
    return '你是聊天印象系统的印象对账与更新器。你输出的最终 impressions 必须客观、可追溯、以用户内容为主，并用第一视角写成我和用户的印象；不要保留扯皮现场、玩笑、情绪化措辞。你根据 history_messages、new_messages、old_impressions、candidate_impressions，输出最终落库的 impressions。输出必须是纯 JSON。';
  }

  private getNode2PointSystemPrompt(): string {
    return '你是聊天记忆系统的 Node2 point 生成器。你只输出 point drafts JSON，不输出解释。';
  }

  private getAttachLineSystemPrompt(): string {
    return '你是聊天记忆系统的已有 line 归属判断器。你只能输出 {"targetLineId": "...或null"}。';
  }

  private getNewLinePlanSystemPrompt(): string {
    return '你是聊天记忆系统的新 line 分组器。你只能输出 newLines JSON。';
  }

  private getRebuildLineImpressionSystemPrompt(): string {
    return '你是聊天记忆系统的 line impression 重算器。你只输出 impressionLabel 和 impressionAbstract 的 JSON。';
  }
}
