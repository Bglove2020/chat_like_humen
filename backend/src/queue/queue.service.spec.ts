import { QueueService } from './queue.service';

describe('QueueService', () => {
  it('caps the payload at 15 messages and computes memoryDate from the latest message', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const service = new QueueService({ add } as any);
    const messages = Array.from({ length: 20 }, (_, index) => ({
      messageId: index + 1,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index + 1}`,
      timestamp: index === 19
        ? '2026-04-05T20:30:00.000Z'
        : `2026-04-05T10:${String(index).padStart(2, '0')}:00.000Z`,
      isNew: true,
    }));

    await service.enqueueSummaryBatch(7, 'session-1', messages);

    expect(add).toHaveBeenCalledTimes(1);

    const payload = add.mock.calls[0][1];
    expect(payload.userId).toBe(7);
    expect(payload.sessionId).toBe('session-1');
    expect(payload.date).toBe('2026-04-05');
    expect(payload.batchId).toMatch(/^7_2026-04-05_/);
    expect(payload.messages).toHaveLength(15);
    expect(payload.messages[0].messageId).toBe(6);
    expect(payload.messages[14].messageId).toBe(20);
  });
});
