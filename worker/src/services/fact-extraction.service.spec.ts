import { FactExtractionService } from './fact-extraction.service';

describe('FactExtractionService', () => {
  const service = new FactExtractionService({ get: jest.fn() } as any);
  const messages = [
    {
      messageId: 100,
      role: 'assistant' as const,
      content: 'Do you prefer pour-over or Americano?',
      timestamp: '2026-04-11T00:00:00.000Z',
    },
    {
      messageId: 101,
      role: 'user' as const,
      content: 'I like iced Americano, but I usually avoid coffee at night.',
      timestamp: '2026-04-11T00:00:00.000Z',
    },
  ];

  it('normalizes structured fields and explicit preference candidates', () => {
    const result = service.normalizeExtraction(
      {
        structuredProfile: {
          nickname: ' Maple ',
          favorite_food: ['hotpot', 'sushi'],
          unknown: 'ignored',
          gender: null,
        },
        preferenceMemories: [
          {
            type: 'preference',
            content: 'User likes iced Americano and usually avoids coffee at night.',
            keywords: ['iced americano', 'avoid coffee at night'],
            evidenceMessageIds: ['101'],
          },
        ],
      },
      messages,
    );

    expect(result.structuredProfile).toEqual({
      nickname: 'Maple',
      favorite_food: 'hotpot、sushi',
    });
    expect(result.preferenceMemories).toEqual([
      {
        candidateId: 'cand_1',
        type: 'preference',
        content: 'User likes iced Americano and usually avoids coffee at night.',
        keywords: ['iced americano', 'avoid coffee at night'],
        evidenceMessageIds: [101],
      },
    ]);
  });

  it('drops question-like candidates and candidates without evidence', () => {
    const result = service.normalizeExtraction(
      {
        structuredProfile: {},
        preferenceMemories: [
          {
            content: 'Can I skip cilantro?',
            keywords: ['cilantro'],
            evidenceMessageIds: [201],
          },
          {
            content: 'User likes latte',
            keywords: ['latte'],
            evidenceMessageIds: [],
          },
        ],
      },
      [
        {
          messageId: 201,
          role: 'user',
          content: 'Can I skip cilantro?',
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
          favorite_drink: 'Iced Americano',
        },
      })
      .mockResolvedValueOnce({
        preferenceMemories: [
          {
            type: 'preference',
            content: 'User likes iced Americano and usually avoids coffee at night.',
            keywords: ['iced americano', 'avoid coffee at night'],
            evidenceMessageIds: ['101'],
          },
        ],
      });

    const result = await service.extract(messages);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][2]).toEqual({ enableThinking: true });
    expect(spy.mock.calls[1][2]).toEqual({ enableThinking: true });
    expect(result.structuredProfile).toEqual({ favorite_drink: 'Iced Americano' });
    expect(result.preferenceMemories).toEqual([
      {
        candidateId: 'cand_1',
        type: 'preference',
        content: 'User likes iced Americano and usually avoids coffee at night.',
        keywords: ['iced americano', 'avoid coffee at night'],
        evidenceMessageIds: [101],
      },
    ]);

    spy.mockRestore();
  });

  it('keeps structured extraction when preference extraction fails', async () => {
    const spy = jest
      .spyOn(service as any, 'callQwenJson')
      .mockResolvedValueOnce({
        structuredProfile: {
          favorite_drink: 'Iced Americano',
        },
      })
      .mockRejectedValueOnce(new Error('preference failed'));
    const consoleSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const result = await service.extract(messages);

    expect(result.structuredProfile).toEqual({ favorite_drink: 'Iced Americano' });
    expect(result.preferenceMemories).toEqual([]);
    expect(consoleSpy).toHaveBeenCalledWith(
      '[FactExtraction] Preference memory extraction error:',
      'preference failed'
    );

    consoleSpy.mockRestore();
    spy.mockRestore();
  });
});
