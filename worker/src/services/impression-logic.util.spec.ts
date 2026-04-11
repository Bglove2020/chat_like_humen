import {
  computeEffectiveScore,
  dedupeByAncestorChain,
  dedupeByIdKeepBest,
  shouldUpdateExistingImpression,
} from './impression-logic.util';

describe('impression-logic.util', () => {
  it('prefers fresher and more salient impressions when computing effective score', () => {
    const now = new Date('2026-04-06T12:00:00.000Z');
    const recent = computeEffectiveScore({
      id: 'recent',
      createdAt: now.toISOString(),
      relevanceScore: 0.8,
      salienceScore: 1.6,
      lastActivatedAt: '2026-04-06T11:00:00.000Z',
    }, now);
    const stale = computeEffectiveScore({
      id: 'stale',
      createdAt: now.toISOString(),
      relevanceScore: 0.8,
      salienceScore: 1.6,
      lastActivatedAt: '2026-02-01T00:00:00.000Z',
    }, now);

    expect(recent).toBeGreaterThan(stale);
  });

  it('dedupes identical impression ids by the highest similarity score', () => {
    const deduped = dedupeByIdKeepBest([
      { id: 'imp-1', createdAt: '2026-04-06T00:00:00.000Z', relevanceScore: 0.51 },
      { id: 'imp-1', createdAt: '2026-04-06T00:00:00.000Z', relevanceScore: 0.88 },
      { id: 'imp-2', createdAt: '2026-04-06T00:00:00.000Z', relevanceScore: 0.42 },
    ]);

    expect(deduped).toHaveLength(2);
    expect(deduped.find((item) => item.id === 'imp-1')?.relevanceScore).toBe(0.88);
  });

  it('removes ancestors when a descendant from the same chain is also retrieved', () => {
    const allKnown = [
      { id: 'root', createdAt: '2026-04-01T00:00:00.000Z', sourceImpressionId: null, rootImpressionId: 'root' },
      { id: 'child', createdAt: '2026-04-02T00:00:00.000Z', sourceImpressionId: 'root', rootImpressionId: 'root' },
      { id: 'leaf', createdAt: '2026-04-03T00:00:00.000Z', sourceImpressionId: 'child', rootImpressionId: 'root' },
    ];

    const deduped = dedupeByAncestorChain(
      [
        { id: 'root', createdAt: '2026-04-01T00:00:00.000Z', sourceImpressionId: null, rootImpressionId: 'root' },
        { id: 'leaf', createdAt: '2026-04-03T00:00:00.000Z', sourceImpressionId: 'child', rootImpressionId: 'root' },
      ],
      allKnown,
    );

    expect(deduped.map((item) => item.id)).toEqual(['leaf']);
  });

  it('keeps multiple leaf nodes for the same root when they are on different branches', () => {
    const allKnown = [
      { id: 'root', createdAt: '2026-04-01T00:00:00.000Z', sourceImpressionId: null, rootImpressionId: 'root' },
      { id: 'branch-a', createdAt: '2026-04-02T00:00:00.000Z', sourceImpressionId: 'root', rootImpressionId: 'root' },
      { id: 'branch-b', createdAt: '2026-04-02T00:00:00.000Z', sourceImpressionId: 'root', rootImpressionId: 'root' },
    ];

    const deduped = dedupeByAncestorChain(
      [
        { id: 'branch-a', createdAt: '2026-04-02T00:00:00.000Z', sourceImpressionId: 'root', rootImpressionId: 'root' },
        { id: 'branch-b', createdAt: '2026-04-02T00:00:00.000Z', sourceImpressionId: 'root', rootImpressionId: 'root' },
      ],
      allKnown,
    );

    expect(deduped.map((item) => item.id)).toEqual(['branch-a', 'branch-b']);
  });

  it('allows update only when the source is a leaf from the same memory date', () => {
    expect(shouldUpdateExistingImpression({ memoryDate: '2026-04-06' }, true, '2026-04-06')).toBe(true);
    expect(shouldUpdateExistingImpression({ memoryDate: '2026-04-05' }, true, '2026-04-06')).toBe(false);
    expect(shouldUpdateExistingImpression({ memoryDate: '2026-04-06' }, false, '2026-04-06')).toBe(false);
  });
});
