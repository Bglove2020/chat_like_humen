import { FactExtractionService } from './fact-extraction.service';

describe('FactExtractionService', () => {
  const service = new FactExtractionService({ get: jest.fn() } as any);
  const messages = [
    {
      messageId: 100,
      role: 'assistant' as const,
      content: '你喜欢喝拿铁还是美式？',
      timestamp: '2026-04-11T00:00:00.000Z',
    },
    {
      messageId: 101,
      role: 'user' as const,
      content: '我喜欢冰美式，但晚上不太敢喝，怕睡不着',
      timestamp: '2026-04-11T00:00:00.000Z',
    },
  ];

  it('normalizes structured fields and explicit preference candidates', () => {
    const result = service.normalizeExtraction(
      {
        structuredProfile: {
          nickname: ' 小张 ',
          favorite_food: ['火锅', '寿司'],
          unknown: 'ignored',
          gender: null,
        },
        preferenceMemories: [
          {
            type: 'preference',
            content: '用户喜欢冰美式，晚上通常不喝。',
            keywords: ['冰美式', '晚上不喝'],
            evidenceMessageIds: ['101'],
          },
        ],
      },
      messages,
    );

    expect(result.structuredProfile).toEqual({
      nickname: '小张',
      favorite_food: '火锅、寿司',
    });
    expect(result.preferenceMemories).toHaveLength(1);
    expect(result.preferenceMemories[0]).toMatchObject({
      type: 'preference',
      content: '用户喜欢冰美式，晚上通常不喝。',
      keywords: ['冰美式', '晚上不喝'],
      evidenceMessageIds: [101],
    });
    expect(result.preferenceMemories[0].retrievalText).toContain(
      '用户喜欢冰美式，晚上通常不喝。',
    );
  });

  it('drops question-like candidates and candidates without evidence', () => {
    const result = service.normalizeExtraction(
      {
        structuredProfile: {},
        preferenceMemories: [
          {
            content: '用户可以不吃香菜吗',
            keywords: ['香菜'],
            confidence: 0.8,
            evidenceMessageIds: [201],
          },
          {
            content: '用户喜欢拿铁',
            keywords: ['拿铁'],
            confidence: 0.8,
            evidenceMessageIds: [],
          },
        ],
      },
      [
        {
          messageId: 201,
          role: 'user',
          content: '我可以不吃香菜吗？',
          timestamp: '2026-04-11T00:00:00.000Z',
        },
      ],
    );

    expect(result.preferenceMemories).toEqual([]);
  });

  it('uses separate llm calls for structured fields and preference memories', async () => {
    const spy = jest
      .spyOn(service as any, 'callQwenJson')
      .mockResolvedValueOnce({
        structuredProfile: {
          favorite_drink: '冰美式',
        },
      })
      .mockResolvedValueOnce({
        preferenceMemories: [
          {
            type: 'preference',
            content: '用户喜欢冰美式，晚上通常不喝。',
            keywords: ['冰美式', '晚上不喝'],
            evidenceMessageIds: ['101'],
          },
        ],
      });

    const result = await service.extract(messages);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toContain('固定字段提取器');
    expect(spy.mock.calls[1][0]).toContain('偏好记忆提取器');
    expect(spy.mock.calls[0][2]).toEqual({ enableThinking: true });
    expect(spy.mock.calls[1][2]).toEqual({ enableThinking: true });
    expect(result.structuredProfile).toEqual({ favorite_drink: '冰美式' });
    expect(result.preferenceMemories).toHaveLength(1);
    expect(result.preferenceMemories[0]).toMatchObject({
      content: '用户喜欢冰美式，晚上通常不喝。',
      keywords: ['冰美式', '晚上不喝'],
      evidenceMessageIds: [101],
    });

    spy.mockRestore();
  });

  it('documents structured field meanings, types, and array allowance in prompt', () => {
    const prompt = (service as any).buildStructuredProfilePrompt(
      messages.filter((message) => message.role === 'user'),
    );

    expect(prompt).toContain('字段说明与类型约束：');
    expect(prompt).toContain('- name: 含义=');
    expect(prompt).toContain('- favorite_food: 含义=');
    expect(prompt).toContain('类型=string | null；可为数组=否');
    expect(prompt).toContain('类型=string[] | string | null；可为数组=是');
    expect(prompt).toContain('数组规则：');
  });

  it('uses assistant messages only as preference extraction context', () => {
    const prompt = (service as any).buildPreferenceMemoriesPrompt(messages);
    const systemPrompt = (service as any).getPreferenceMemoriesSystemPrompt();

    expect(prompt).toContain('"role": "assistant"');
    expect(prompt).toContain('messages:');
    expect(systemPrompt).toContain('assistant 消息只用于帮助理解上下文');
    expect(systemPrompt).toContain(
      'evidenceMessageIds 必须只引用支持该候选的 user 消息 messageId',
    );
    expect(systemPrompt).toContain('不要输出 candidateId');
  });

  it('keeps structured extraction when preference extraction fails', async () => {
    const spy = jest
      .spyOn(service as any, 'callQwenJson')
      .mockResolvedValueOnce({
        structuredProfile: {
          favorite_drink: '冰美式',
        },
      })
      .mockRejectedValueOnce(new Error('preference failed'));
    const consoleSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const result = await service.extract(messages);

    expect(result.structuredProfile).toEqual({ favorite_drink: '冰美式' });
    expect(result.preferenceMemories).toEqual([]);
    expect(consoleSpy).toHaveBeenCalledWith(
      '[FactExtraction] Preference memory extraction error:',
      'preference failed',
    );

    consoleSpy.mockRestore();
    spy.mockRestore();
  });
});
