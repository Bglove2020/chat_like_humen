import { Injectable } from '@nestjs/common';
import { ChatMessageService } from './chat_message.service';
import { ChatMessage } from './chat_message.entity';
import { ImpressionRecord, ImpressionsService } from '../impressions/impressions.service';

type ContextSource = 'recent' | 'window' | 'latest';

interface ContextCandidate extends ImpressionRecord {
  sources: Set<ContextSource>;
  windowScore: number;
  latestScore: number;
  recentBoost: number;
  normalizedSalienceScore: number;
  finalScore: number;
}

export interface ChatContextResponse {
  context: Array<{
    scene: string;
    points: string[];
    time: string;
  }>;
}

const DEFAULT_CONTEXT_LIMIT = 6;
const RECENT_IMPRESSION_LIMIT = 5;
const WINDOW_MESSAGE_LIMIT = 20;
const LATEST_ROUND_MESSAGE_LIMIT = 8;
const SEARCH_LIMIT = 8;
const MESSAGE_TRUNCATE_CHARS = 100;
const MAX_SALIENCE_SCORE = 5;
const BEIJING_TIME_FORMATTER = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

@Injectable()
export class ChatContextService {
  constructor(
    private chatMessageService: ChatMessageService,
    private impressionsService: ImpressionsService,
  ) {}

  async getContext(userId: number, message: string, limit = DEFAULT_CONTEXT_LIMIT): Promise<ChatContextResponse> {
    const historyDesc = await this.chatMessageService.getLatestMessages(userId, WINDOW_MESSAGE_LIMIT);
    const historyMessages = [...historyDesc].reverse();
    const latestHistoryMessages = historyMessages.slice(-LATEST_ROUND_MESSAGE_LIMIT);
    const windowQuery = this.buildWindowQuery(historyMessages);
    const latestQuery = this.buildLatestQuery(latestHistoryMessages, message);

    const [recentImpressions, windowRecall, latestRecall] = await Promise.all([
      this.impressionsService.getRecentUserImpressions(userId, RECENT_IMPRESSION_LIMIT, 7),
      windowQuery
        ? this.impressionsService.searchUserImpressions(userId, windowQuery, SEARCH_LIMIT)
        : Promise.resolve([]),
      latestQuery
        ? this.impressionsService.searchUserImpressions(userId, latestQuery, SEARCH_LIMIT)
        : Promise.resolve([]),
    ]);

    const rankedContext = await this.mergeAndRankCandidates(
      recentImpressions,
      windowRecall,
      latestRecall,
      Math.min(Math.max(limit || DEFAULT_CONTEXT_LIMIT, 1), 10),
    );

    return {
      context: rankedContext.map((item) => ({
        scene: item.scene,
        points: item.points,
        time: this.formatBeijingTime(item),
      })),
    };
  }

  private truncateMessage(content: string): string {
    return String(content || '').trim().slice(0, MESSAGE_TRUNCATE_CHARS);
  }

  private formatMessage(message: Pick<ChatMessage, 'role' | 'content'>): string {
    return `[${message.role === 'user' ? '用户' : 'AI'}] ${this.truncateMessage(message.content)}`;
  }

  private buildWindowQuery(messages: ChatMessage[]): string {
    if (!messages.length) {
      return '';
    }

    return [
      '最近历史对话：',
      ...messages.map((message) => this.formatMessage(message)),
    ].join('\n');
  }

  private buildLatestQuery(messages: ChatMessage[], currentMessage: string): string {
    const parts: string[] = ['最近4轮对话：'];

    if (messages.length) {
      parts.push(...messages.map((message) => this.formatMessage(message)));
    }

    parts.push('');
    parts.push('当前用户新消息：');
    parts.push(`[用户] ${this.truncateMessage(currentMessage)}`);

    return parts.join('\n').trim();
  }

  private normalizeSalienceScore(record: ImpressionRecord): number {
    return clampScore(Number(record.salienceScore || 0) / MAX_SALIENCE_SCORE);
  }

  private formatBeijingTime(record: Pick<ImpressionRecord, 'updatedAt' | 'createdAt'>): string {
    const source = record.updatedAt || record.createdAt || '';
    if (!source) {
      return '';
    }

    const date = new Date(source);
    if (Number.isNaN(date.getTime())) {
      return '';
    }

    return BEIJING_TIME_FORMATTER.format(date).replace(',', '');
  }

  private getRecencyTimestamp(record: ImpressionRecord): number {
    return new Date(record.lastActivatedAt || record.updatedAt || record.createdAt).getTime();
  }

  private computeRecentBoost(record: ImpressionRecord): number {
    const ageMs = Date.now() - this.getRecencyTimestamp(record);
    const ageDays = ageMs / (24 * 60 * 60 * 1000);

    if (ageDays <= 1) {
      return 1;
    }

    if (ageDays <= 3) {
      return 0.7;
    }

    if (ageDays <= 7) {
      return 0.4;
    }

    return 0;
  }

  private upsertCandidate(
    bucket: Map<string, ContextCandidate>,
    record: ImpressionRecord,
    source: ContextSource,
    rawScore: number,
  ): void {
    const existing = bucket.get(record.id);
    const normalizedScore = clampScore(rawScore);
    const recentBoost = source === 'recent'
      ? this.computeRecentBoost(record)
      : (existing?.recentBoost || 0);

    if (existing) {
      existing.sources.add(source);
      if (source === 'window') {
        existing.windowScore = Math.max(existing.windowScore, normalizedScore);
      } else if (source === 'latest') {
        existing.latestScore = Math.max(existing.latestScore, normalizedScore);
      }
      existing.recentBoost = Math.max(existing.recentBoost, recentBoost);
      existing.normalizedSalienceScore = Math.max(
        existing.normalizedSalienceScore,
        this.normalizeSalienceScore(record),
      );
      existing.finalScore = this.computeFinalScore(existing);
      return;
    }

    const candidate: ContextCandidate = {
      ...record,
      sources: new Set([source]),
      windowScore: source === 'window' ? normalizedScore : 0,
      latestScore: source === 'latest' ? normalizedScore : 0,
      recentBoost,
      normalizedSalienceScore: this.normalizeSalienceScore(record),
      finalScore: 0,
    };
    candidate.finalScore = this.computeFinalScore(candidate);
    bucket.set(record.id, candidate);
  }

  private computeFinalScore(candidate: Pick<
    ContextCandidate,
    'latestScore' | 'windowScore' | 'recentBoost' | 'normalizedSalienceScore'
  >): number {
    return Number((
      candidate.latestScore * 0.5 +
      candidate.windowScore * 0.3 +
      candidate.recentBoost * 0.15 +
      candidate.normalizedSalienceScore * 0.05
    ).toFixed(6));
  }

  private async hydrateAncestors(candidates: ContextCandidate[]): Promise<ImpressionRecord[]> {
    const knownById = new Map(candidates.map((candidate) => [candidate.id, candidate as ImpressionRecord]));
    let frontier = candidates
      .map((candidate) => candidate.sourceImpressionId)
      .filter((id): id is string => Boolean(id && !knownById.has(id)));

    while (frontier.length) {
      const ancestors = await this.impressionsService.getImpressionsByIds(frontier);
      if (!ancestors.length) {
        break;
      }

      for (const ancestor of ancestors) {
        if (!knownById.has(ancestor.id)) {
          knownById.set(ancestor.id, ancestor);
        }
      }

      frontier = ancestors
        .map((ancestor) => ancestor.sourceImpressionId)
        .filter((id): id is string => Boolean(id && !knownById.has(id)));
    }

    return Array.from(knownById.values());
  }

  private collectAncestorIds(
    impressionId: string,
    allKnownImpressions: Map<string, Pick<ImpressionRecord, 'id' | 'sourceImpressionId'>>,
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

  private dedupeByAncestorChain(
    candidates: ContextCandidate[],
    allKnownImpressions: ImpressionRecord[],
  ): ContextCandidate[] {
    const knownById = new Map(allKnownImpressions.map((record) => [record.id, record]));
    const removedIds = new Set<string>();

    for (const candidate of candidates) {
      const ancestorIds = this.collectAncestorIds(candidate.id, knownById);
      for (const ancestorId of ancestorIds) {
        if (candidates.some((item) => item.id === ancestorId)) {
          removedIds.add(ancestorId);
        }
      }
    }

    return candidates.filter((candidate) => !removedIds.has(candidate.id));
  }

  private async mergeAndRankCandidates(
    recentImpressions: ImpressionRecord[],
    windowRecall: ImpressionRecord[],
    latestRecall: ImpressionRecord[],
    limit: number,
  ): Promise<Array<{ scene: string; points: string[] } & ContextCandidate>> {
    const candidateMap = new Map<string, ContextCandidate>();

    for (const record of recentImpressions) {
      this.upsertCandidate(candidateMap, record, 'recent', 0);
    }

    for (const record of windowRecall) {
      this.upsertCandidate(candidateMap, record, 'window', record.score || 0);
    }

    for (const record of latestRecall) {
      this.upsertCandidate(candidateMap, record, 'latest', record.score || 0);
    }

    const candidates = Array.from(candidateMap.values())
      .sort((left, right) => {
        if (right.finalScore !== left.finalScore) {
          return right.finalScore - left.finalScore;
        }

        return this.getRecencyTimestamp(right) - this.getRecencyTimestamp(left);
      });

    if (!candidates.length) {
      return [];
    }

    const withAncestors = await this.hydrateAncestors(candidates);
    const deduped = this.dedupeByAncestorChain(candidates, withAncestors)
      .sort((left, right) => {
        if (right.finalScore !== left.finalScore) {
          return right.finalScore - left.finalScore;
        }

        return this.getRecencyTimestamp(right) - this.getRecencyTimestamp(left);
      })
      .slice(0, limit);

    return deduped.map((candidate) => ({
      ...candidate,
    }));
  }
}
