import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface FactMessageInput {
  messageId?: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export type StructuredProfileFields = Record<string, string>;

export type ProfileMemoryType =
  | 'preference'
  | 'habit'
  | 'constraint'
  | 'goal';

export interface PreferenceMemoryCandidate {
  candidateId: string;
  type: ProfileMemoryType;
  content: string;
  keywords: string[];
  evidenceMessageIds: number[];
}

export interface FactExtractionResult {
  structuredProfile: StructuredProfileFields;
  preferenceMemories: PreferenceMemoryCandidate[];
}

interface QwenCallOptions {
  enableThinking?: boolean;
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

const STRUCTURED_PROFILE_FIELD_DEFINITIONS: Record<
  (typeof PROFILE_FIELDS)[number],
  {
    meaning: string;
    type: string;
    allowArray: boolean;
  }
> = {
  name: {
    meaning: '用户明确提到的姓名或自称名字',
    type: 'string | null',
    allowArray: false,
  },
  nickname: {
    meaning: '用户常用昵称、网名或希望被如何称呼',
    type: 'string | null',
    allowArray: false,
  },
  age_range: {
    meaning: '用户明确提到的年龄段或年龄描述，如“20多岁”“95后”“30岁左右”',
    type: 'string | null',
    allowArray: false,
  },
  gender: {
    meaning: '用户明确提到的性别认同或性别描述',
    type: 'string | null',
    allowArray: false,
  },
  birthday: {
    meaning: '用户明确提到的生日或出生日期',
    type: 'string | null',
    allowArray: false,
  },
  zodiac: {
    meaning: '用户明确提到的星座',
    type: 'string | null',
    allowArray: false,
  },
  location: {
    meaning: '用户当前常住地、所在城市或所在地区',
    type: 'string | null',
    allowArray: false,
  },
  hometown: {
    meaning: '用户家乡、老家、籍贯或成长地',
    type: 'string | null',
    allowArray: false,
  },
  ethnicity: {
    meaning: '用户明确提到的民族或族裔信息',
    type: 'string | null',
    allowArray: false,
  },
  education: {
    meaning: '用户当前或最高学历，如本科、硕士',
    type: 'string | null',
    allowArray: false,
  },
  major: {
    meaning: '用户明确提到的专业方向',
    type: 'string | null',
    allowArray: false,
  },
  school: {
    meaning: '用户明确提到的学校名称',
    type: 'string | null',
    allowArray: false,
  },
  occupation: {
    meaning: '用户当前职业、岗位或主要工作身份',
    type: 'string | null',
    allowArray: false,
  },
  work_years: {
    meaning: '用户明确提到的工作年限或从业时长',
    type: 'string | null',
    allowArray: false,
  },
  marital_status: {
    meaning: '用户婚恋状态，如单身、已婚、恋爱中',
    type: 'string | null',
    allowArray: false,
  },
  has_children: {
    meaning: '用户是否有孩子或对子女情况的简要描述',
    type: 'string | null',
    allowArray: false,
  },
  pet: {
    meaning: '用户养宠情况、宠物种类或宠物名称',
    type: 'string[] | string | null',
    allowArray: true,
  },
  family_structure: {
    meaning: '用户家庭成员结构的简要描述，如独居、和父母同住、三口之家',
    type: 'string | null',
    allowArray: false,
  },
  diet: {
    meaning: '用户饮食习惯或饮食限制，如素食、少糖、清淡',
    type: 'string | null',
    allowArray: false,
  },
  exercise: {
    meaning: '用户运动习惯、频率或主要运动方式',
    type: 'string | null',
    allowArray: false,
  },
  sleep_schedule: {
    meaning: '用户作息习惯、睡眠时间段或昼夜型描述',
    type: 'string | null',
    allowArray: false,
  },
  smoking: {
    meaning: '用户是否吸烟及相关习惯',
    type: 'string | null',
    allowArray: false,
  },
  drinking: {
    meaning: '用户是否饮酒及相关习惯',
    type: 'string | null',
    allowArray: false,
  },
  cooking: {
    meaning: '用户是否做饭、做饭频率或烹饪习惯',
    type: 'string | null',
    allowArray: false,
  },
  hobbies: {
    meaning: '用户明确提到的长期兴趣爱好',
    type: 'string[] | string | null',
    allowArray: true,
  },
  favorite_food: {
    meaning: '用户明确提到的喜欢吃的食物、菜系或口味',
    type: 'string[] | string | null',
    allowArray: true,
  },
  favorite_drink: {
    meaning: '用户明确提到的喜欢喝的饮品',
    type: 'string[] | string | null',
    allowArray: true,
  },
  favorite_music: {
    meaning: '用户明确提到的喜欢的音乐类型、歌手、乐队或歌曲方向',
    type: 'string[] | string | null',
    allowArray: true,
  },
  favorite_sport: {
    meaning: '用户明确提到的喜欢的运动项目或球队方向',
    type: 'string[] | string | null',
    allowArray: true,
  },
  favorite_books: {
    meaning: '用户明确提到的喜欢的书籍、作者或阅读类型',
    type: 'string[] | string | null',
    allowArray: true,
  },
  favorite_movies: {
    meaning: '用户明确提到的喜欢的电影、导演或影视类型',
    type: 'string[] | string | null',
    allowArray: true,
  },
  favorite_travel: {
    meaning: '用户明确提到的喜欢的旅行地、旅行方式或旅行类型',
    type: 'string[] | string | null',
    allowArray: true,
  },
};

const PROFILE_FIELD_SET = new Set<string>(PROFILE_FIELDS);
const MEMORY_TYPES = new Set<ProfileMemoryType>([
  'preference',
  'habit',
  'constraint',
  'goal',
]);
const QUESTION_RE = /(吗|么|能不能|可以吗|怎么|如何|为什么|？|\?)/;
const STABLE_MARKER_RE =
  /(平时|一般|通常|基本都|一直|最近常|经常|通常会|我不吃|我喜欢|喜欢|我讨厌|讨厌|我习惯|习惯|现在不|不再|改成|更喜欢|偏好|常常|尽量不)/;
const GENERIC_KEYWORD_RE = /^(偏好|习惯|生活|技术|工具|内容|方式|表达)$/;

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
        .filter(Boolean)
        .filter((item) => !GENERIC_KEYWORD_RE.test(item)),
    ),
  ).slice(0, 4);
}

function formatPromptMessage(
  message: FactMessageInput,
): Record<string, string | null> {
  return {
    messageId: Number.isInteger(message.messageId)
      ? String(message.messageId)
      : null,
    role: message.role,
    content: String(message.content || ''),
  };
}

function buildStructuredFieldDefinitionText(): string {
  return PROFILE_FIELDS.map((field) => {
    const definition = STRUCTURED_PROFILE_FIELD_DEFINITIONS[field];
    return `- ${field}: 含义=${definition.meaning}；类型=${definition.type}；可为数组=${definition.allowArray ? '是' : '否'}`;
  }).join('\n');
}

@Injectable()
export class FactExtractionService {
  constructor(private configService: ConfigService) {}

  async extract(messages: FactMessageInput[]): Promise<FactExtractionResult> {
    const normalizedMessages = messages
      .filter(
        (message) => message.role === 'user' || message.role === 'assistant',
      )
      .filter((message) => String(message.content || '').trim());
    const userMessages = normalizedMessages
      .filter((message) => message.role === 'user')
      .filter((message) => String(message.content || '').trim());
    if (!normalizedMessages.length || !userMessages.length) {
      return { structuredProfile: {}, preferenceMemories: [] };
    }

    const allowedMessageIds = this.buildAllowedMessageIds(userMessages);
    const [structuredResult, preferenceResult] = await Promise.allSettled([
      this.callQwenJson(
        this.getStructuredProfileSystemPrompt(),
        this.buildStructuredProfilePrompt(userMessages),
        { enableThinking: true },
      ),
      this.callQwenJson(
        this.getPreferenceMemoriesSystemPrompt(),
        this.buildPreferenceMemoriesPrompt(normalizedMessages),
        { enableThinking: true },
      ),
    ]);

    const structuredProfile =
      structuredResult.status === 'fulfilled'
        ? this.normalizeStructuredProfile(
            structuredResult.value?.structuredProfile ||
              structuredResult.value ||
              {},
          )
        : {};
    const preferenceMemories =
      preferenceResult.status === 'fulfilled'
        ? this.normalizePreferenceMemories(
            preferenceResult.value?.preferenceMemories ||
              preferenceResult.value ||
              [],
            allowedMessageIds,
          )
        : [];

    if (structuredResult.status === 'rejected') {
      const error = structuredResult.reason;
      console.error(
        '[FactExtraction] Structured profile extraction error:',
        error?.message || error,
      );
    }

    if (preferenceResult.status === 'rejected') {
      const error = preferenceResult.reason;
      console.error(
        '[FactExtraction] Preference memory extraction error:',
        error?.message || error,
      );
    }

    return {
      structuredProfile,
      preferenceMemories,
    };
  }

  normalizeExtraction(
    raw: any,
    messages: FactMessageInput[],
  ): FactExtractionResult {
    const allowedMessageIds = this.buildAllowedMessageIds(messages);

    return {
      structuredProfile: this.normalizeStructuredProfile(
        raw?.structuredProfile || {},
      ),
      preferenceMemories: this.normalizePreferenceMemories(
        raw?.preferenceMemories || [],
        allowedMessageIds,
      ),
    };
  }

  private buildAllowedMessageIds(messages: FactMessageInput[]): Set<number> {
    return new Set(
      messages
        .filter((message) => message.role === 'user')
        .map((message) => message.messageId)
        .filter((messageId): messageId is number =>
          Number.isInteger(messageId),
        ),
    );
  }

  private normalizeStructuredProfile(
    rawProfile: Record<string, unknown>,
  ): StructuredProfileFields {
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

  private normalizePreferenceMemories(
    rawMemories: unknown,
    allowedMessageIds: Set<number>,
  ): PreferenceMemoryCandidate[] {
    if (!Array.isArray(rawMemories)) {
      return [];
    }

    const seen = new Set<string>();
    const candidates: PreferenceMemoryCandidate[] = [];

    for (const raw of rawMemories) {
      const type = MEMORY_TYPES.has(raw?.type) ? raw.type : 'preference';
      const content = normalizeText(raw?.content || raw?.preference, 200);
      const keywords = normalizeKeywords(raw?.keywords);
      const evidenceMessageIds = this.normalizeEvidenceMessageIds(
        raw?.evidenceMessageIds,
        allowedMessageIds,
      );

      if (
        !content ||
        !keywords.length ||
        !evidenceMessageIds.length ||
        this.looksLikeQuestionWithoutStableSignal(content)
      ) {
        continue;
      }
      const dedupeKey = [type, content, keywords.join('|')].join('|');

      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      candidates.push({
        candidateId: `cand_${candidates.length + 1}`,
        type,
        content,
        keywords,
        evidenceMessageIds,
      });
    }

    return candidates.slice(0, 8);
  }

  private normalizeEvidenceMessageIds(
    rawIds: unknown,
    allowedMessageIds: Set<number>,
  ): number[] {
    if (!Array.isArray(rawIds)) {
      return [];
    }

    return Array.from(
      new Set(
        rawIds
          .map((item) => Number.parseInt(String(item), 10))
          .filter((item) => Number.isInteger(item) && item > 0)
          .filter(
            (item) => !allowedMessageIds.size || allowedMessageIds.has(item),
          ),
      ),
    ).slice(0, 8);
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
      candidate.content,
      `类型：${candidate.type}`,
      candidate.keywords.length
        ? `关键词：${candidate.keywords.join('、')}`
        : '',
    ]
      .filter(Boolean)
      .join('；')
      .substring(0, 360);
  }

  private looksLikeQuestionWithoutStableSignal(text: string): boolean {
    return QUESTION_RE.test(text) && !STABLE_MARKER_RE.test(text);
  }

  private buildStructuredProfilePrompt(messages: FactMessageInput[]): string {
    const promptMessages = messages.map(formatPromptMessage);

    return `请从以下当前 batch 的用户新消息中提取固定用户画像字段。

只允许使用这些用户原话，不要使用 AI 回复，不要结合常识推测。

你只负责 fixed fields，不要输出开放式偏好记忆，不要生成 preferenceMemories。
字段只填用户直接明确说出的值；未提到的字段必须为 null。
如果同一字段在当前 batch 中出现多个说法，以当前 batch 中最新且更明确的说法为准。
字段说明与类型约束：
${buildStructuredFieldDefinitionText()}

数组规则：
- 可为数组=是 的字段可以返回 string[]、也可以返回单个合并后的 string。
- 可为数组=否 的字段只能返回 string 或 null，不能返回数组。
- 不要输出额外字段，不要把一句模糊描述同时塞进多个字段。

输出 JSON 结构必须为：
{
  "structuredProfile": {
    ${PROFILE_FIELDS.map((field) => `"${field}": null`).join(',\n    ')}
  }
}

messages:
${JSON.stringify(promptMessages, null, 2)}`;
  }

  private buildPreferenceMemoriesPrompt(messages: FactMessageInput[]): string {
    const promptMessages = messages.map(formatPromptMessage);

    return `messages:
${JSON.stringify(promptMessages, null, 2)}`;
  }

  private getStructuredProfileSystemPrompt(): string {
    return '你是用户画像固定字段提取器。你只提取用户直接说出的结构化个人事实字段。不要生成开放式偏好记忆。输出必须是纯 JSON。';
  }

  private getPreferenceMemoriesSystemPrompt(): string {
    return `你是用户偏好记忆提取器。你的任务是从当前 batch 的消息中提取“值得长期保留”的开放式用户偏好候选。

你的目标不是总结对话，而是识别用户直接说出的、对未来对话有复用价值的稳定信息。

messages 中可能同时包含 assistant 和 user：
- assistant 消息只用于帮助理解上下文，不能单独作为事实来源
- 最终提取出的偏好必须由 user 消息直接支持

只允许提取以下 4 类：
- preference：稳定偏好、厌恶、表达倾向、回复偏好、工具偏好
- habit：稳定习惯、常用做法、重复性行为模式
- constraint：限制、禁忌、规避项、不能接受或尽量避免的事
- goal：持续目标、长期打算、想推进的方向

分类要求：
1. 每条候选必须且只能归入以上 4 类之一
2. 不要新造类型
3. 只有明确体现“不能接受、尽量避免、禁忌、规避、限制”时才归为 constraint
4. 单纯“不喜欢、偏向、不爱看”优先归为 preference
5. 如果难以区分，按以下优先级选择：constraint > goal > habit > preference

提取规则：
1. 只提取用户消息中直接表达或直接体现出的长期、稳定、可复用信息
2. 可以提取“高概率稳定”的表达，不要求用户必须明确说“我喜欢”“我习惯”
3. 如果用户表达了“平时、一般、通常、基本都、一直、最近常、现在改成、更喜欢、不再、习惯、尽量不、通常会”等稳定含义，可以提取
4. assistant 的表述、总结、建议、猜测，只有在 user 明确认可或直接表达后，才能作为可提取内容
5. 不要结合常识脑补，不要补充用户没说过的原因、态度、条件或偏好对象
6. content 必须写成一句脱离上下文也能独立成立的话
7. keywords 必须是 1 到 4 个短词或短语，优先使用用户原话中的关键词，可做轻微归一化，但不能过度抽象，不能写整句
8. keywords 不要写“偏好”“习惯”“生活”“技术”“工具”这类过泛词
9. evidenceMessageIds 必须只引用支持该候选的 user 消息 messageId，不能引用 assistant 消息

不要提取以下内容：
1. 纯问句
2. 一次性临时选择
3. 当前瞬时状态
4. 没有未来复用价值的信息
5. 脱离上下文无法独立成立的模糊表达
6. assistant 提出但 user 没有直接确认的内容
7. 只是顺手附和、礼貌回应、无稳定含义的短句
8. 明显更像当前任务上下文，而不是用户长期偏好的内容

输出要求：
1. 输出必须是纯 JSON
2. 不要输出解释
3. 不要输出 markdown
4. 如果没有合适内容，返回 {"preferenceMemories":[]}

输出 JSON 结构必须为：
{
  "preferenceMemories": [
    {
      "type": "preference|habit|constraint|goal",
      "content": "string",
      "keywords": ["string"],
      "evidenceMessageIds": ["string"]
    }
  ]
}

补充要求：
1. content 要尽量简洁、明确，避免空泛表述
2. keywords 要有助于后续与旧记忆做相似性匹配
3. 若同一用户消息里包含两个明显独立的长期信息，可以拆成两条候选
4. 若只是同一偏好的重复表述，不要拆成多条
5. 不要输出 candidateId，系统会在解析后按顺序补充 cand_1、cand_2、cand_3。`;
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
}
