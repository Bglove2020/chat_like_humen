import { ChatService } from './chat.service';

describe('ChatService buildSummaryPayload', () => {
  it('always prepends up to 15 historical messages before current new messages', async () => {
    const chatMessageService = {
      getRecentMessages: jest.fn().mockResolvedValue(
        Array.from({ length: 25 }, (_, index) => {
          const id = 25 - index;
          return {
            id,
            role: id % 2 === 0 ? 'assistant' : 'user',
            content: `message-${id}`,
            createdAt: new Date(
              `2026-04-10T10:${String(id).padStart(2, '0')}:00.000Z`,
            ),
          };
        }),
      ),
    };
    const service = new ChatService(
      {} as any,
      {} as any,
      chatMessageService as any,
      {} as any,
    );
    const newMessages = Array.from({ length: 10 }, (_, index) => {
      const id = 16 + index;
      return {
        messageId: id,
        role: id % 2 === 0 ? 'assistant' : 'user',
        content: `message-${id}`,
        timestamp: `2026-04-10T10:${String(id).padStart(2, '0')}:00.000Z`,
        isNew: true,
      };
    });

    const payload = await (service as any).buildSummaryPayload(
      7,
      'session-1',
      newMessages,
    );

    expect(chatMessageService.getRecentMessages).toHaveBeenCalledWith(
      7,
      25,
      'session-1',
    );
    expect(payload).toHaveLength(25);
    expect(payload.slice(0, 15).map((message: any) => message.messageId)).toEqual(
      Array.from({ length: 15 }, (_, index) => index + 1),
    );
    expect(payload.slice(-10).map((message: any) => message.messageId)).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 16),
    );
    expect(payload.slice(0, 15).every((message: any) => message.isNew === false)).toBe(true);
    expect(payload.slice(-10).every((message: any) => message.isNew === true)).toBe(true);
  });
});
