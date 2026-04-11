import { FactExtractionService } from './fact-extraction.service';

describe('FactExtractionService', () => {
  const service = new FactExtractionService({ get: jest.fn() } as any);

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
            category: 'drink',
            subject: '冰美式',
            preference: '用户喜欢喝冰美式',
            condition: '晚上不太敢喝',
            reason: '怕睡不着',
            polarity: 'like',
            confidence: 0.9,
            evidenceMessageIds: ['101'],
          },
        ],
      },
      [
        {
          messageId: 101,
          role: 'user',
          content: '我喜欢冰美式，但晚上不太敢喝，怕睡不着',
          timestamp: '2026-04-11T00:00:00.000Z',
        },
      ],
    );

    expect(result.structuredProfile).toEqual({
      nickname: '小张',
      favorite_food: '火锅、寿司',
    });
    expect(result.preferenceMemories).toHaveLength(1);
    expect(result.preferenceMemories[0]).toMatchObject({
      category: 'drink',
      subject: '冰美式',
      polarity: 'like',
      evidenceMessageIds: [101],
    });
    expect(result.preferenceMemories[0].retrievalText).toContain('用户喜欢喝冰美式');
  });

  it('drops question-like candidates and candidates without evidence', () => {
    const result = service.normalizeExtraction(
      {
        structuredProfile: {},
        preferenceMemories: [
          {
            category: 'food',
            subject: '香菜',
            preference: '用户可以不吃香菜吗',
            polarity: 'avoid',
            confidence: 0.8,
            evidenceMessageIds: [201],
          },
          {
            category: 'drink',
            subject: '拿铁',
            preference: '用户喜欢拿铁',
            polarity: 'like',
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
});
