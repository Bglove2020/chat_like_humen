import {
  UserProfileMemoryService,
  UserProfileMemoryRecord,
} from './user-profile-memory.service';
import { PreferenceMemoryCandidate } from './fact-extraction.service';

function createCandidate(
  overrides: Partial<PreferenceMemoryCandidate> = {},
): PreferenceMemoryCandidate {
  return {
    candidateId: 'cand_1',
    type: 'preference',
    content: '用户喜欢喝冰美式',
    keywords: ['冰美式', '咖啡'],
    confidence: 0.9,
    evidenceMessageIds: [101],
    retrievalText: '用户喜欢喝冰美式；类型：preference；关键词：冰美式、咖啡',
    ...overrides,
  };
}

function createMemory(
  overrides: Partial<UserProfileMemoryRecord> = {},
): UserProfileMemoryRecord {
  return {
    id: 'memory-1',
    score: 0.9,
    openId: 'open-id-1',
    type: 'preference',
    content: '用户喜欢喝冰美式',
    keywords: ['冰美式', '咖啡'],
    confidence: 0.8,
    strengthScore: 2,
    status: 'active',
    sourceMessageIds: [1],
    batchId: 'batch-0',
    retrievalText: '用户喜欢喝冰美式',
    createdAt: '2026-04-10T00:00:00.000Z',
    updatedAt: '2026-04-10T00:00:00.000Z',
    lastActivatedAt: '2026-04-10T00:00:00.000Z',
    supersededById: null,
    ...overrides,
  };
}

describe('UserProfileMemoryService reconcile decisions', () => {
  const service = new UserProfileMemoryService(
    { get: jest.fn() } as any,
    { getEmbedding: jest.fn() } as any,
  );

  it('discards duplicate same-subject memories', () => {
    const decision = (service as any).decideAction(createCandidate(), [
      createMemory(),
    ]);

    expect(decision.action).toBe('discard');
  });

  it('updates same-subject memories when the new candidate adds detail', () => {
    const decision = (service as any).decideAction(
      createCandidate({
        content: '用户喜欢喝冰美式，通常会选少冰不加糖',
        keywords: ['冰美式', '少冰', '不加糖'],
      }),
      [createMemory()],
    );

    expect(decision.action).toBe('update');
  });

  it('supersedes active memories when the same subject conflicts', () => {
    const decision = (service as any).decideAction(
      createCandidate({
        content: '用户现在不太喝冰美式了，改喝拿铁',
        keywords: ['冰美式', '拿铁'],
      }),
      [createMemory()],
    );

    expect(decision.action).toBe('supersede');
  });

  it('normalizes reconcile results to minimal new or cover actions', () => {
    const decisions = (service as any).normalizeReconcileDecisions(
      {
        results: [
          {
            candidateId: 'cand_1',
            sourceMemoryId: 'memory-1',
            action: 'cover',
          },
          {
            candidateId: 'cand_2',
            sourceMemoryId: null,
            action: 'new',
          },
          {
            candidateId: 'cand_3',
            sourceMemoryId: null,
            action: 'discard',
          },
        ],
      },
      [
        createCandidate(),
        createCandidate({
          candidateId: 'cand_2',
          content: '用户更喜欢拿铁',
          keywords: ['拿铁', '咖啡'],
        }),
      ],
      [createMemory()],
    );

    expect(decisions).toEqual([
      {
        candidateId: 'cand_1',
        sourceMemoryId: 'memory-1',
        action: 'cover',
      },
      {
        candidateId: 'cand_2',
        sourceMemoryId: null,
        action: 'new',
      },
    ]);
  });

  it('increases strength score when the same preference is confirmed again', () => {
    const payload = (service as any).buildPayload({
      openId: 'open-id-1',
      batchId: 'batch-1',
      candidate: createCandidate(),
      existing: createMemory({ strengthScore: 2 }),
      now: '2026-04-12T00:00:00.000Z',
    });

    expect(payload.strengthScore).toBe(3);
  });

  it('resets strength score when a covered preference changes materially', () => {
    const payload = (service as any).buildPayload({
      openId: 'open-id-1',
      batchId: 'batch-1',
      candidate: createCandidate({
        content: '用户现在不太喝冰美式了，改喝拿铁',
        keywords: ['冰美式', '拿铁'],
      }),
      existing: createMemory({ strengthScore: 4 }),
      now: '2026-04-12T00:00:00.000Z',
    });

    expect(payload.strengthScore).toBe(1);
  });
});
