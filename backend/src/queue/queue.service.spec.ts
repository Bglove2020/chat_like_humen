import { QueueService } from './queue.service';

describe('QueueService', () => {
  it('caps the payload at 15 messages and computes memoryDate from the latest message', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const service = new QueueService({ add } as any, { add: jest.fn() } as any);
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

  it('enqueues fact jobs with user messages only', async () => {
    const factAdd = jest.fn().mockResolvedValue(undefined);
    const service = new QueueService({ add: jest.fn() } as any, { add: factAdd } as any);

    await service.enqueueFactBatch(7, 'batch-1', [
      {
        messageId: 1,
        role: 'user',
        content: '我喜欢冰美式',
        timestamp: '2026-04-05T10:00:00.000Z',
      },
      {
        messageId: 2,
        role: 'user',
        content: '   ',
        timestamp: '2026-04-05T10:01:00.000Z',
      },
    ]);

    expect(factAdd).toHaveBeenCalledTimes(1);
    expect(factAdd.mock.calls[0][0]).toBe('fact');
    expect(factAdd.mock.calls[0][1]).toEqual({
      userId: 7,
      batchId: 'batch-1',
      messages: [
        {
          messageId: 1,
          role: 'user',
          content: '我喜欢冰美式',
          timestamp: '2026-04-05T10:00:00.000Z',
        },
      ],
    });
  });

  it('does not enqueue Mem0 batches when MEM0_ENABLED is false', async () => {
    const summaryAdd = jest.fn().mockResolvedValue(undefined);
    const factAdd = jest.fn().mockResolvedValue(undefined);
    const mem0Add = jest.fn().mockResolvedValue(undefined);
    const config = { get: jest.fn().mockReturnValue(false) };
    const service = new QueueService(
      { add: summaryAdd } as any,
      { add: factAdd } as any,
      { add: mem0Add } as any,
      config as any,
    );

    const result = await service.enqueueMem0Batch(7, 'session-1', [{
      messageId: 1,
      role: 'user',
      content: 'hello',
      timestamp: '2026-04-05T10:00:00.000Z',
      isNew: true,
    }], 'batch-1', '2026-04-05');

    expect(result).toBeNull();
    expect(mem0Add).not.toHaveBeenCalled();
  });

  it('enqueues only new messages to Mem0 with the provided batch metadata', async () => {
    const summaryAdd = jest.fn().mockResolvedValue(undefined);
    const factAdd = jest.fn().mockResolvedValue(undefined);
    const mem0Add = jest.fn().mockResolvedValue(undefined);
    const config = { get: jest.fn().mockImplementation((key: string) => key === 'mem0.enabled') };
    const service = new QueueService(
      { add: summaryAdd } as any,
      { add: factAdd } as any,
      { add: mem0Add } as any,
      config as any,
    );

    const result = await service.enqueueMem0Batch(7, 'session-1', [
      {
        messageId: 1,
        role: 'user',
        content: 'old',
        timestamp: '2026-04-05T10:00:00.000Z',
        isNew: false,
      },
      {
        messageId: 2,
        role: 'assistant',
        content: 'new',
        timestamp: '2026-04-05T10:01:00.000Z',
        isNew: true,
      },
    ], 'batch-1', '2026-04-05');

    expect(result?.batchId).toBe('batch-1');
    expect(result?.date).toBe('2026-04-05');
    expect(result?.messages).toHaveLength(1);
    expect(result?.messages[0].messageId).toBe(2);
    expect(mem0Add).toHaveBeenCalledTimes(1);
    expect(mem0Add.mock.calls[0][0]).toBe('mem0');
    expect(mem0Add.mock.calls[0][1].batchId).toBe('batch-1');
    expect(mem0Add.mock.calls[0][1].messages).toHaveLength(1);
  });
});
