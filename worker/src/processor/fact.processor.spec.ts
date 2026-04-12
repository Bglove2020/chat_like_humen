import axios from 'axios';
import { FactProcessor } from './fact.processor';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('FactProcessor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('upserts structured profile and reconciles memories using openId', async () => {
    mockedAxios.post.mockResolvedValue({ data: { skipped: false } });

    const factExtractionService = {
      extract: jest.fn().mockResolvedValue({
        structuredProfile: {
          nickname: 'Maple',
          favorite_music: 'jazz',
        },
        preferenceMemories: [
          {
            candidateId: 'cand_1',
            type: 'preference',
            content: 'User likes pour-over coffee.',
            keywords: ['coffee', 'pour-over'],
            confidence: 0.88,
            evidenceMessageIds: [11],
            retrievalText: 'User likes pour-over coffee.',
          },
        ],
      }),
    };
    const userProfileMemoryService = {
      reconcileAndPersist: jest.fn().mockResolvedValue({
        candidates: 1,
        created: 1,
        covered: 0,
        discarded: 0,
      }),
    };
    const configService = {
      get: jest.fn((key: string) => {
        const values: Record<string, string> = {
          'backend.internalUrl': 'http://backend.test:7001',
          'backend.internalApiKey': 'test-internal-key',
        };
        return values[key];
      }),
    };

    const processor = new FactProcessor(
      factExtractionService as any,
      userProfileMemoryService as any,
      configService as any
    );

    await processor.process({
      id: 'job-1',
      data: {
        openId: 'open-id-1',
        batchId: 'batch-1',
        messages: [
          {
            messageId: 11,
            role: 'user',
            content: 'I have been listening to more jazz lately.',
            timestamp: '2026-04-13T09:00:00.000Z',
          },
          {
            messageId: 12,
            role: 'assistant',
            content: 'Then I can recommend some albums.',
            timestamp: '2026-04-13T09:01:00.000Z',
          },
        ],
      },
    } as any);

    expect(factExtractionService.extract).toHaveBeenCalledTimes(1);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://backend.test:7001/internal/user-profiles/upsert',
      {
        openId: 'open-id-1',
        batchId: 'batch-1',
        fields: {
          nickname: 'Maple',
          favorite_music: 'jazz',
        },
      },
      {
        headers: {
          'x-api-key': 'test-internal-key',
        },
      }
    );
    expect(userProfileMemoryService.reconcileAndPersist).toHaveBeenCalledWith(
      'open-id-1',
      'batch-1',
      [
        {
          messageId: 11,
          role: 'user',
          content: 'I have been listening to more jazz lately.',
          timestamp: '2026-04-13T09:00:00.000Z',
        },
        {
          messageId: 12,
          role: 'assistant',
          content: 'Then I can recommend some albums.',
          timestamp: '2026-04-13T09:01:00.000Z',
        },
      ],
      [
        {
          candidateId: 'cand_1',
          type: 'preference',
          content: 'User likes pour-over coffee.',
          keywords: ['coffee', 'pour-over'],
          confidence: 0.88,
          evidenceMessageIds: [11],
          retrievalText: 'User likes pour-over coffee.',
        },
      ]
    );
  });
});
