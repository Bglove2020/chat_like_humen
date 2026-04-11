export const INITIAL_SALIENCE_SCORE = 1;
export const SALIENCE_INCREMENT = 0.35;
export const MAX_SALIENCE_SCORE = 5;
export const DECAY_HALF_LIFE_DAYS = 30;

export interface ImpressionNode {
  id: string;
  createdAt: string;
  updatedAt?: string;
  memoryDate?: string;
  sourceImpressionId?: string | null;
  rootImpressionId?: string | null;
  salienceScore?: number;
  lastActivatedAt?: string;
  relevanceScore?: number;
}

export function normalizeOriginType(originType?: string): 'standalone' | 'continued' {
  return originType === 'continued_from_history' || originType === 'continued'
    ? 'continued'
    : 'standalone';
}

export function bumpSalienceScore(currentScore?: number): number {
  const baseScore = typeof currentScore === 'number' && currentScore > 0
    ? currentScore
    : INITIAL_SALIENCE_SCORE;

  return Math.min(MAX_SALIENCE_SCORE, Number((baseScore + SALIENCE_INCREMENT).toFixed(3)));
}

export function computeDecayWeight(
  salienceScore = INITIAL_SALIENCE_SCORE,
  lastActivatedAt?: string,
  now = new Date(),
): number {
  const activatedAt = lastActivatedAt ? new Date(lastActivatedAt) : now;
  const elapsedMs = Math.max(0, now.getTime() - activatedAt.getTime());
  const elapsedDays = elapsedMs / (24 * 60 * 60 * 1000);
  const decayFactor = Math.exp((-Math.log(2) * elapsedDays) / DECAY_HALF_LIFE_DAYS);
  return salienceScore * decayFactor;
}

export function computeEffectiveScore(impression: ImpressionNode, now = new Date()): number {
  const similarityScore = impression.relevanceScore || 0;
  const salienceScore = typeof impression.salienceScore === 'number'
    ? impression.salienceScore
    : INITIAL_SALIENCE_SCORE;

  return similarityScore * computeDecayWeight(salienceScore, impression.lastActivatedAt, now);
}

export function dedupeByIdKeepBest<T extends ImpressionNode>(impressions: T[]): T[] {
  const byId = new Map<string, T>();

  for (const impression of impressions) {
    const existing = byId.get(impression.id);
    if (!existing || (impression.relevanceScore || 0) > (existing.relevanceScore || 0)) {
      byId.set(impression.id, impression);
    }
  }

  return Array.from(byId.values());
}

function collectAncestorIds(
  impressionId: string,
  allKnownImpressions: Map<string, ImpressionNode>,
): Set<string> {
  const ancestorIds = new Set<string>();
  const visited = new Set<string>();
  let current = allKnownImpressions.get(impressionId);

  while (current?.sourceImpressionId && !visited.has(current.sourceImpressionId)) {
    const parentId = current.sourceImpressionId;
    ancestorIds.add(parentId);
    visited.add(parentId);
    current = allKnownImpressions.get(parentId);
  }

  return ancestorIds;
}

export function dedupeByAncestorChain<T extends ImpressionNode>(
  retrievedImpressions: T[],
  allKnownImpressions: ImpressionNode[],
): T[] {
  const knownById = new Map(allKnownImpressions.map((impression) => [impression.id, impression]));
  const removedIds = new Set<string>();

  for (const impression of retrievedImpressions) {
    const ancestorIds = collectAncestorIds(impression.id, knownById);
    for (const ancestorId of ancestorIds) {
      if (retrievedImpressions.some((candidate) => candidate.id === ancestorId)) {
        removedIds.add(ancestorId);
      }
    }
  }

  return retrievedImpressions.filter((impression) => !removedIds.has(impression.id));
}

export function shouldUpdateExistingImpression(
  sourceImpression: Pick<ImpressionNode, 'memoryDate'> | undefined,
  isLeaf: boolean,
  batchMemoryDate: string,
): boolean {
  return Boolean(
    sourceImpression
    && isLeaf
    && sourceImpression.memoryDate
    && sourceImpression.memoryDate === batchMemoryDate,
  );
}
