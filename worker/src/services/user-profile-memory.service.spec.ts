import { UserProfileMemoryService, UserProfileMemoryRecord } from './user-profile-memory.service';
import { PreferenceMemoryCandidate } from './fact-extraction.service';

function createCandidate(overrides: Partial<PreferenceMemoryCandidate> = {}): PreferenceMemoryCandidate {
  return {
    type: 'preference',
    category: 'drink',
    subject: '冰美式',
    preference: '用户喜欢喝冰美式',
    condition: null,
    reason: null,
    polarity: 'like',
    confidence: 0.9,
    evidenceMessageIds: [101],
    retrievalText: '用户喜欢喝冰美式；类别：drink；对象：冰美式；倾向：like',
    ...overrides,
  };
}

function createMemory(overrides: Partial<UserProfileMemoryRecord> = {}): UserProfileMemoryRecord {
  return {
    id: 'memory-1',
    score: 0.9,
    userId: 1,
    type: 'preference',
    category: 'drink',
    subject: '冰美式',
    preference: '用户喜欢喝冰美式',
    condition: null,
    reason: null,
    polarity: 'like',
    confidence: 0.8,
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
  const service = new UserProfileMemoryService({ get: jest.fn() } as any, { getEmbedding: jest.fn() } as any);

  it('discards duplicate same-subject memories', () => {
    const decision = (service as any).decideAction(
      createCandidate(),
      [createMemory()],
    );

    expect(decision.action).toBe('discard');
  });

  it('updates same-subject memories when the new candidate adds detail', () => {
    const decision = (service as any).decideAction(
      createCandidate({
        preference: '用户喜欢喝冰美式，偏好少冰不加糖',
        condition: '少冰不加糖',
      }),
      [createMemory()],
    );

    expect(decision.action).toBe('update');
  });

  it('supersedes active memories when the same subject conflicts', () => {
    const decision = (service as any).decideAction(
      createCandidate({
        preference: '用户现在不太喝冰美式了',
        polarity: 'avoid',
      }),
      [createMemory()],
    );

    expect(decision.action).toBe('supersede');
  });
});
