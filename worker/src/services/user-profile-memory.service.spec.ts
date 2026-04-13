import {
  UserProfileMemoryService,
  UserProfileMemoryRecord,
} from './user-profile-memory.service';
import { PreferenceMemoryCandidate } from './fact-extraction.service';

function createCandidate(
  overrides: Partial<PreferenceMemoryCandidate> = {}
): PreferenceMemoryCandidate {
  return {
    candidateId: 'cand_1',
    type: 'preference',
    content: 'User likes iced Americano.',
    keywords: ['americano', 'coffee'],
    evidenceMessageIds: [101],
    ...overrides,
  };
}

function createMemory(
  overrides: Partial<UserProfileMemoryRecord> = {}
): UserProfileMemoryRecord {
  return {
    id: 'memory-1',
    score: 0.9,
    openId: 'open-id-1',
    type: 'preference',
    content: 'User likes iced Americano.',
    keywords: ['americano', 'coffee'],
    strengthScore: 2,
    createdAt: '2026-04-10T00:00:00.000Z',
    updatedAt: '2026-04-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('UserProfileMemoryService reconcile decisions', () => {
  const service = new UserProfileMemoryService(
    { get: jest.fn() } as any,
    { getEmbedding: jest.fn() } as any
  );

  it('discards duplicate same-subject memories', () => {
    const decision = (service as any).decideAction(createCandidate(), [
      createMemory(),
    ]);

    expect(decision).toBe('discard');
  });

  it('covers same-subject memories when the new candidate adds detail', () => {
    const decision = (service as any).decideAction(
      createCandidate({
        content: 'User likes iced Americano and usually asks for less ice.',
        keywords: ['americano', 'coffee', 'less ice'],
      }),
      [createMemory()]
    );

    expect(decision).toBe('cover');
  });

  it('covers active memories when the same subject conflicts', () => {
    const decision = (service as any).decideAction(
      createCandidate({
        content: 'User does not drink iced Americano anymore and now prefers latte.',
        keywords: ['americano', 'coffee', 'latte'],
      }),
      [createMemory()]
    );

    expect(decision).toBe('cover');
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
          content: 'User prefers latte now.',
          keywords: ['latte', 'coffee'],
        }),
      ],
      [createMemory()]
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
    const score = (service as any).computeStrengthScore(
      createCandidate(),
      createMemory({ strengthScore: 2 })
    );

    expect(score).toBe(3);
  });

  it('builds qdrant payload without legacy fields', () => {
    const payload = (service as any).buildPayload(createMemory());

    expect(payload).toEqual({
      openId: 'open-id-1',
      type: 'preference',
      content: 'User likes iced Americano.',
      keywords: ['americano', 'coffee'],
      strengthScore: 2,
      createdAt: '2026-04-10T00:00:00.000Z',
      updatedAt: '2026-04-10T00:00:00.000Z',
    });
    expect((payload as any).status).toBeUndefined();
    expect((payload as any).retrievalText).toBeUndefined();
    expect((payload as any).sourceMessageIds).toBeUndefined();
    expect((payload as any).batchId).toBeUndefined();
    expect((payload as any).lastActivatedAt).toBeUndefined();
  });
});
