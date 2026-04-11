import { ChatContextService } from './chat-context.service';
import { ImpressionRecord } from '../impressions/impressions.service';

function createImpressionRecord(overrides: Partial<ImpressionRecord> = {}): ImpressionRecord {
  return {
    id: overrides.id || 'impression-1',
    scene: overrides.scene || '默认场景',
    points: overrides.points || ['默认记忆点'],
    entities: overrides.entities || [],
    retrievalText: overrides.retrievalText || '默认检索文本',
    content: overrides.content || '默认内容',
    score: overrides.score || 0,
    sessionId: overrides.sessionId || null,
    createdAt: overrides.createdAt || '2026-04-10T10:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-04-10T10:00:00.000Z',
    memoryDate: overrides.memoryDate || '2026-04-10',
    date: overrides.date || '2026-04-10',
    salienceScore: overrides.salienceScore ?? 2,
    lastActivatedAt: overrides.lastActivatedAt || '2026-04-10T10:00:00.000Z',
    originType: overrides.originType || 'standalone',
    sourceImpressionId: overrides.sourceImpressionId ?? null,
    rootImpressionId: overrides.rootImpressionId || overrides.id || 'impression-1',
  };
}

describe('ChatContextService', () => {
  it('builds truncated window/latest queries and ranks latest recall highest', async () => {
    const longText = 'A'.repeat(120);
    const chatMessageService = {
      getLatestMessages: jest.fn().mockResolvedValue([
        { role: 'assistant', content: '上一轮 AI 回复', createdAt: new Date('2026-04-10T10:01:00.000Z') },
        { role: 'user', content: longText, createdAt: new Date('2026-04-10T10:00:00.000Z') },
      ]),
    } as any;

    const recentImpression = createImpressionRecord({
      id: 'recent-1',
      scene: '近期主线',
      lastActivatedAt: '2026-04-10T11:00:00.000Z',
      salienceScore: 1,
    });
    const windowImpression = createImpressionRecord({
      id: 'window-1',
      scene: '历史窗口命中',
      score: 0.62,
      salienceScore: 2,
    });
    const latestImpression = createImpressionRecord({
      id: 'latest-1',
      scene: '最新输入命中',
      score: 0.88,
      salienceScore: 2,
    });

    const impressionsService = {
      getRecentUserImpressions: jest.fn().mockResolvedValue([recentImpression]),
      searchUserImpressions: jest.fn().mockImplementation(async (_userId: number, query: string) => {
        if (query.startsWith('最近历史对话：')) {
          return [windowImpression];
        }

        if (query.includes('当前用户新消息：')) {
          return [latestImpression];
        }

        return [];
      }),
      getImpressionsByIds: jest.fn().mockResolvedValue([]),
    } as any;

    const userProfileService = {
      getStructuredProfile: jest.fn().mockResolvedValue({ favorite_drink: '冰美式' }),
      searchPreferenceMemories: jest.fn().mockResolvedValue([
        { text: '用户喜欢冰美式。', time: '2026-04-10 18:10:00' },
      ]),
    } as any;

    const service = new ChatContextService(chatMessageService, impressionsService, userProfileService);
    const result = await service.getContext(1, '这次最新输入', 6);

    expect(result.context[0].scene).toBe('最新输入命中');
    expect(result.context[0].points).toEqual(['默认记忆点']);
    expect(result.context[0].time).toBe('2026-04-10 18:00:00');
    expect(result.context.some((item) => item.scene === '近期主线')).toBe(true);
    expect(result.userProfile).toEqual({
      structured: { favorite_drink: '冰美式' },
      preferences: [
        { text: '用户喜欢冰美式。', time: '2026-04-10 18:10:00' },
      ],
    });
  });

  it('dedupes ancestor chain and keeps the descendant impression', async () => {
    const chatMessageService = {
      getLatestMessages: jest.fn().mockResolvedValue([]),
    } as any;

    const rootImpression = createImpressionRecord({
      id: 'root',
      scene: '根印象',
      score: 0.74,
      sourceImpressionId: null,
      rootImpressionId: 'root',
    });
    const childImpression = createImpressionRecord({
      id: 'child',
      scene: '子印象',
      score: 0.79,
      sourceImpressionId: 'root',
      rootImpressionId: 'root',
    });

    const impressionsService = {
      getRecentUserImpressions: jest.fn().mockResolvedValue([]),
      searchUserImpressions: jest.fn().mockImplementation(async (_userId: number, query: string) => {
        if (query.includes('当前用户新消息：')) {
          return [rootImpression, childImpression];
        }

        return [];
      }),
      getImpressionsByIds: jest.fn().mockResolvedValue([rootImpression]),
    } as any;

    const userProfileService = {
      getStructuredProfile: jest.fn().mockResolvedValue({}),
      searchPreferenceMemories: jest.fn().mockResolvedValue([]),
    } as any;

    const service = new ChatContextService(chatMessageService, impressionsService, userProfileService);
    const result = await service.getContext(1, '继续刚才的话题', 6);

    expect(result.context).toEqual([
      {
        scene: '子印象',
        points: ['默认记忆点'],
        time: '2026-04-10 18:00:00',
      },
    ]);
    expect(result.userProfile).toEqual({
      structured: {},
      preferences: [],
    });
  });
});
