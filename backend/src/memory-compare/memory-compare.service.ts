import { Injectable } from '@nestjs/common';
import { ImpressionsService } from '../impressions/impressions.service';
import { UserProfileService } from '../users/user-profile.service';

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 20;
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

@Injectable()
export class MemoryCompareService {
  constructor(
    private impressionsService: ImpressionsService,
    private userProfileService: UserProfileService,
  ) {}

  private normalizeLimit(limit?: number): number {
    if (!Number.isInteger(limit)) {
      return DEFAULT_LIMIT;
    }

    return Math.min(Math.max(limit || DEFAULT_LIMIT, 1), MAX_LIMIT);
  }

  private formatBeijingTime(value: string): string {
    if (!value) {
      return '';
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '';
    }

    return BEIJING_TIME_FORMATTER.format(date).replace(',', '');
  }

  async search(userId: number, query: string, limit?: number) {
    const normalizedLimit = this.normalizeLimit(limit);
    const [customResult, profileResult] = await Promise.allSettled([
      this.impressionsService.searchUserImpressions(userId, query, normalizedLimit),
      this.userProfileService.searchPreferenceMemories(userId, query, normalizedLimit),
    ]);
    const customImpressions = customResult.status === 'fulfilled' ? customResult.value : [];
    const profileMemories = profileResult.status === 'fulfilled' ? profileResult.value : [];

    if (customResult.status === 'rejected') {
      console.error('[MemoryCompare] Custom search error:', customResult.reason?.message || customResult.reason);
    }

    if (profileResult.status === 'rejected') {
      console.error('[MemoryCompare] User profile search error:', profileResult.reason?.message || profileResult.reason);
    }

    return {
      custom: {
        context: customImpressions.map((item) => ({
          scene: item.scene,
          points: item.points,
          time: this.formatBeijingTime(item.updatedAt || item.createdAt),
          score: item.score,
        })),
      },
      profile: {
        preferences: profileMemories,
      },
    };
  }
}
