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

  it('sanitizes final impressions toward first-person and low-noise points', () => {
    const normalized = (service as any).normalizeFinalImpressions({
      impressions: [
        {
          sourceImpressionId: 'old-1',
          scene: '聊约前同事拼豆的顾虑与互动策略',
          points: [
            'assistant建议先各做各的，用户说他约对方是为了增进感情，还觉得这种说法像钢铁直男；assistant随后调整为边拼边聊，哈哈稳了。',
            '用户纠正拼豆只能自己做自己的，assistant据此调整为合作设计图案或边拼边吐槽以创造互动话题。',
            '多次祝福拼豆活动愉快。',
          ],
          entities: ['拼豆'],
          retrievalText: 'assistant建议先各做各的，用户说他约对方是为了增进感情，还觉得这种说法像钢铁直男。',
        },
      ],
    });

    expect(normalized).toHaveLength(1);
    expect(normalized[0].scene).toBe('聊约前同事拼豆');
    expect(normalized[0].points.join(' ')).toContain('增进感情');
    expect(normalized[0].points.join(' ')).toContain('不接受把这件事理解成低互动安排');
    expect(normalized[0].points.join(' ')).toContain('只能各自独立完成');
    expect(normalized[0].points.join(' ')).toContain('过程中自然聊天');
    expect(normalized[0].points.join(' ')).not.toContain('assistant');
    expect(normalized[0].points.join(' ')).not.toContain('钢铁直男');
    expect(normalized[0].points.join(' ')).not.toContain('哈哈');
    expect(normalized[0].points.join(' ')).not.toContain('边拼边吐槽');
    expect(normalized[0].points.join(' ')).not.toContain('多次祝福');
    expect(normalized[0].retrievalText).toContain('聊约前同事拼豆');
    expect(normalized[0].retrievalText).not.toContain('assistant');
    expect(normalized[0].retrievalText).not.toContain('钢铁直男');
  });

  it('prefers the most relevant carry source inside the same impression thread', () => {
    const selected = (service as any).selectCarrySource(
      {
        sourceImpressionId: 'root-1',
        scene: '聊约前同事去拼豆',
        points: [
          '用户纠正拼豆只能各自独立制作，并再次强调约前同事拼豆是为了增进感情；我据此把建议调整为更强调过程中自然互动',
        ],
        entities: ['前同事', '拼豆', '增进感情'],
        retrievalText: '聊约前同事去拼豆',
      },
      [
        {
          id: 'root-1',
          scene: '聊拼豆手工活动',
          points: ['用户计划周末体验拼豆，我解释玩法并建议从简单图案开始'],
          entities: ['拼豆', '周末'],
          retrievalText: '聊拼豆手工活动',
          content: '',
          createdAt: '2026-04-10T00:00:00.000Z',
          updatedAt: '2026-04-10T00:00:00.000Z',
        } satisfies Impression,
        {
          id: 'leaf-1',
          scene: '聊约前同事去拼豆',
          points: ['用户因担心前同事劳累及后续行程紧凑而犹豫邀约，并说明约前同事拼豆是为了增进感情'],
          entities: ['前同事', '拼豆', '增进感情', '时间顾虑'],
          retrievalText: '聊约前同事去拼豆',
          content: '',
          createdAt: '2026-04-11T00:00:00.000Z',
          updatedAt: '2026-04-11T00:00:00.000Z',
          rootImpressionId: 'root-1',
          sourceImpressionId: 'root-1',
        } satisfies Impression,
      ],
    );

    expect(selected?.id).toBe('leaf-1');
  });
});
