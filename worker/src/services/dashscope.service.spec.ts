import { DashscopeService, Impression } from './dashscope.service';

describe('DashscopeService prompt builders', () => {
  const service = new DashscopeService({ get: jest.fn() } as any);

  it('builds candidate prompt with explicit history/new split', () => {
    const prompt = (service as any).buildCandidateImpressionPrompt({
      historyMessages: [
        { messageId: 1, role: 'user', content: '昨天在聊早餐', timestamp: '2026-04-10T00:00:00.000Z', isNew: false },
      ],
      newMessages: [
        { messageId: 2, role: 'assistant', content: '今天继续聊热水', timestamp: '2026-04-10T00:01:00.000Z', isNew: true },
      ],
      oldImpressions: [
        {
          id: 'imp-1',
          scene: '聊早餐习惯',
          points: ['用户常吃鸡蛋和肉包子'],
          entities: ['鸡蛋', '肉包子'],
          retrievalText: '聊早餐习惯，鸡蛋，肉包子',
          content: '',
          createdAt: '2026-04-09T00:00:00.000Z',
        } satisfies Impression,
      ],
    });

    expect(prompt).toContain('history_messages:');
    expect(prompt).toContain('new_messages:');
    expect(prompt).toContain('"messageId": "1"');
    expect(prompt).toContain('"messageId": "2"');
    expect(prompt).toContain('old_impressions:');
  });

  it('builds reconcile prompt with candidate impressions section', () => {
    const prompt = (service as any).buildReconcileImpressionPrompt({
      historyMessages: [],
      newMessages: [
        { messageId: 2, role: 'assistant', content: '今天继续聊热水', timestamp: '2026-04-10T00:01:00.000Z', isNew: true },
      ],
      oldImpressions: [],
      candidateImpressions: [
        {
          scene: '聊早餐习惯',
          points: ['用户问热水，我给了回应'],
          entities: ['热水'],
          retrievalText: '聊早餐习惯 热水',
          evidenceMessageIds: [2],
        },
      ],
    });

    expect(prompt).toContain('candidate_impressions:');
    expect(prompt).toContain('"evidenceMessageIds": [');
    expect(prompt).toContain('"2"');
  });
});
