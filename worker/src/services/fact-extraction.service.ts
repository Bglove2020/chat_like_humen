import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface FactMessageInput {
  messageId?: number;
  role: 'user';
  content: string;
  timestamp: string;
}

export type StructuredProfileFields = Record<string, string>;

export type ProfileMemoryType = 'preference' | 'habit' | 'constraint' | 'goal' | 'dislike' | 'style';
export type ProfileMemoryPolarity = 'like' | 'dislike' | 'neutral' | 'avoid' | 'prefer';

export interface PreferenceMemoryCandidate {
  type: ProfileMemoryType;
  category: string;
  subject: string;
  preference: string;
  condition?: string | null;
  reason?: string | null;
  polarity: ProfileMemoryPolarity;
  confidence: number;
  evidenceMessageIds: number[];
  retrievalText: string;
}

export interface FactExtractionResult {
  structuredProfile: StructuredProfileFields;
  preferenceMemories: PreferenceMemoryCandidate[];
}

const PROFILE_FIELDS = [
  'name',
  'nickname',
  'age_range',
  'gender',
  'birthday',
  'zodiac',
  'location',
  'hometown',
  'ethnicity',
  'education',
  'major',
  'school',
  'occupation',
  'work_years',
  'marital_status',
  'has_children',
  'pet',
  'family_structure',
  'diet',
  'exercise',
  'sleep_schedule',
  'smoking',
  'drinking',
  'cooking',
  'hobbies',
  'favorite_food',
  'favorite_drink',
  'favorite_music',
  'favorite_sport',
  'favorite_books',
  'favorite_movies',
  'favorite_travel',
] as const;

const PROFILE_FIELD_SET = new Set<string>(PROFILE_FIELDS);
const MEMORY_TYPES = new Set<ProfileMemoryType>([
  'preference',
  'habit',
  'constraint',
  'goal',
  'dislike',
  'style',
]);
const POLARITIES = new Set<ProfileMemoryPolarity>([
  'like',
  'dislike',
  'neutral',
  'avoid',
  'prefer',
]);
const QUESTION_RE = /(吗|么|能不能|可以吗|怎么|如何|为什么|？|\?)/;
const STABLE_MARKER_RE = /(平时|一直|最近常|经常|通常|我不吃|我喜欢|喜欢|我讨厌|讨厌|我习惯|习惯|现在不|不再|改成|更喜欢|偏好|常常)/;

function normalizeText(value: unknown, maxLength: number): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .join('、')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, maxLength);
  }

  return String(value).replace(/\s+/g, ' ').trim().substring(0, maxLength);
}

function normalizeConfidence(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.max(0, Math.min(1, Number(parsed.toFixed(3))));
}

function formatPromptMessage(message: FactMessageInput): Record<string, string | null> {
  return {
    messageId: Number.isInteger(message.messageId) ? String(message.messageId) : null,
    role: 'user',
    content: String(message.content || ''),
  };
}

@Injectable()
export class FactExtractionService {
  constructor(private configService: ConfigService) {}

  async extract(messages: FactMessageInput[]): Promise<FactExtractionResult> {
    const userMessages = messages.filter((message) => String(message.content || '').trim());
    if (!userMessages.length) {
      return { structuredProfile: {}, preferenceMemories: [] };
    }

    try {
      const raw = await this.callQwenJson(
        this.getSystemPrompt(),
        this.buildExtractionPrompt(userMessages),
      );
      return this.normalizeExtraction(raw, userMessages);
    } catch (error: any) {
      console.error('[FactExtraction] Extraction error:', error?.message);
      return { structuredProfile: {}, preferenceMemories: [] };
    }
  }

  normalizeExtraction(raw: any, messages: FactMessageInput[]): FactExtractionResult {
    const allowedMessageIds = new Set(
      messages
        .map((message) => message.messageId)
        .filter((messageId): messageId is number => Number.isInteger(messageId)),
    );

    return {
      structuredProfile: this.normalizeStructuredProfile(raw?.structuredProfile || {}),
      preferenceMemories: this.normalizePreferenceMemories(raw?.preferenceMemories || [], allowedMessageIds),
    };
  }

  private normalizeStructuredProfile(rawProfile: Record<string, unknown>): StructuredProfileFields {
    const normalized: StructuredProfileFields = {};

    for (const [key, value] of Object.entries(rawProfile || {})) {
      if (!PROFILE_FIELD_SET.has(key)) {
        continue;
      }

      const text = normalizeText(value, 256);
      if (text) {
        normalized[key] = text;
      }
    }

    return normalized;
  }

  private normalizePreferenceMemories(rawMemories: unknown, allowedMessageIds: Set<number>): PreferenceMemoryCandidate[] {
    if (!Array.isArray(rawMemories)) {
      return [];
    }

    const seen = new Set<string>();
    const candidates: PreferenceMemoryCandidate[] = [];

    for (const raw of rawMemories) {
      const type = MEMORY_TYPES.has(raw?.type) ? raw.type : 'preference';
      const category = normalizeText(raw?.category, 48);
      const subject = normalizeText(raw?.subject, 80);
      const preference = normalizeText(raw?.preference, 180);
      const condition = normalizeText(raw?.condition, 120) || null;
      const reason = normalizeText(raw?.reason, 120) || null;
      const polarity = POLARITIES.has(raw?.polarity) ? raw.polarity : 'neutral';
      const confidence = normalizeConfidence(raw?.confidence);
      const evidenceMessageIds = this.normalizeEvidenceMessageIds(raw?.evidenceMessageIds, allowedMessageIds);

      if (
        !category
        || !subject
        || !preference
        || confidence < 0.55
        || !evidenceMessageIds.length
        || this.looksLikeQuestionWithoutStableSignal([subject, preference, condition || '', reason || ''].join(' '))
      ) {
        continue;
      }

      const retrievalText = this.buildRetrievalText({
        type,
        category,
        subject,
        preference,
        condition,
        reason,
        polarity,
        confidence,
        evidenceMessageIds,
        retrievalText: '',
      });
      const dedupeKey = [
        type,
        category,
        subject,
        polarity,
        preference,
        condition || '',
        reason || '',
      ].join('|');

      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      candidates.push({
        type,
        category,
        subject,
        preference,
        condition,
        reason,
        polarity,
        confidence,
        evidenceMessageIds,
        retrievalText,
      });
    }

    return candidates.slice(0, 8);
  }

  private normalizeEvidenceMessageIds(rawIds: unknown, allowedMessageIds: Set<number>): number[] {
    if (!Array.isArray(rawIds)) {
      return [];
    }

    return Array.from(new Set(
      rawIds
        .map((item) => Number.parseInt(String(item), 10))
        .filter((item) => Number.isInteger(item) && item > 0)
        .filter((item) => !allowedMessageIds.size || allowedMessageIds.has(item)),
    )).slice(0, 8);
  }

  private buildRetrievalText(candidate: PreferenceMemoryCandidate): string {
    return [
      candidate.preference,
      candidate.condition ? `条件：${candidate.condition}` : '',
      candidate.reason ? `原因：${candidate.reason}` : '',
      `类别：${candidate.category}`,
      `对象：${candidate.subject}`,
      `倾向：${candidate.polarity}`,
    ].filter(Boolean).join('；').substring(0, 360);
  }

  private looksLikeQuestionWithoutStableSignal(text: string): boolean {
    return QUESTION_RE.test(text) && !STABLE_MARKER_RE.test(text);
  }

  private buildExtractionPrompt(messages: FactMessageInput[]): string {
    const promptMessages = messages.map(formatPromptMessage);

    return `请从以下当前 batch 的用户新消息中提取用户画像。

只允许使用这些用户原话，不要使用 AI 回复，不要结合常识推测。

固定字段只填用户直接明确说出的值；未提到的字段必须为 null。
开放式偏好只提取长期偏好、习惯、约束、目标、风格，不要把问句、一次临时选择、建议请求当成偏好。
如果用户表达了“平时、一直、最近常、我不吃、我喜欢、我讨厌、我习惯、现在不、不再、改成、更喜欢”等稳定含义，可以提取开放式偏好。
evidenceMessageIds 必须来自下面消息的 messageId。

输出 JSON 结构必须为：
{
  "structuredProfile": {
    ${PROFILE_FIELDS.map((field) => `"${field}": null`).join(',\n    ')}
  },
  "preferenceMemories": [
    {
      "type": "preference|habit|constraint|goal|dislike|style",
      "category": "drink",
      "subject": "冰美式",
      "preference": "用户喜欢喝冰美式",
      "condition": "晚上不太敢喝",
      "reason": "怕睡不着",
      "polarity": "like|dislike|neutral|avoid|prefer",
      "confidence": 0.9,
      "evidenceMessageIds": ["123"]
    }
  ]
}

messages:
${JSON.stringify(promptMessages, null, 2)}`;
  }

  private getSystemPrompt(): string {
    return '你是用户画像事实提取器。你只提取用户直接说出的个人事实、长期偏好、习惯、约束、目标和风格。输出必须是纯 JSON。';
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

    return isOldApi
      ? this.callOldApi(qwenUrl, apiKey, systemPrompt, userPrompt)
      : this.callOpenAICompatible(qwenUrl, apiKey, systemPrompt, userPrompt);
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
          temperature: 0.1,
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
}
