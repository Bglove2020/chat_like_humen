import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import { Repository } from 'typeorm';
import { UserProfile } from './user-profile.entity';

export const USER_PROFILE_FIELDS = [
  'name',
  'nickname',
  'age_range',
  'gender',
  'birthday',
  'zodiac',
  'location',
  'hometown',
  'ethnicity',
  'education',
  'major',
  'school',
  'occupation',
  'work_years',
  'marital_status',
  'has_children',
  'pet',
  'family_structure',
  'diet',
  'exercise',
  'sleep_schedule',
  'smoking',
  'drinking',
  'cooking',
  'hobbies',
  'favorite_food',
  'favorite_drink',
  'favorite_music',
  'favorite_sport',
  'favorite_books',
  'favorite_movies',
  'favorite_travel',
] as const;

export type UserProfileField = typeof USER_PROFILE_FIELDS[number];
export type UserProfileFields = Partial<Record<UserProfileField, string>>;

export interface UserProfilePreferenceContextItem {
  text: string;
  time: string;
}

const PROFILE_FIELD_SET = new Set<string>(USER_PROFILE_FIELDS);
const PROFILE_PREFERENCE_LIMIT = 5;
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

function normalizeFieldValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .join('、')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return String(value).replace(/\s+/g, ' ').trim();
}

function formatBeijingTime(source: string): string {
  if (!source) {
    return '';
  }

  const date = new Date(source);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return BEIJING_TIME_FORMATTER.format(date).replace(',', '');
}

@Injectable()
export class UserProfileService {
  constructor(
    @InjectRepository(UserProfile)
    private userProfileRepository: Repository<UserProfile>,
    private configService: ConfigService,
  ) {}

  sanitizeFields(fields: Record<string, unknown> | null | undefined): UserProfileFields {
    const sanitized: UserProfileFields = {};

    for (const [key, rawValue] of Object.entries(fields || {})) {
      if (!PROFILE_FIELD_SET.has(key)) {
        continue;
      }

      const value = normalizeFieldValue(rawValue);
      if (!value) {
        continue;
      }

      sanitized[key as UserProfileField] = value;
    }

    return sanitized;
  }

  async upsertProfile(userId: number, fields: Record<string, unknown>): Promise<{
    skipped: boolean;
    updatedFields: UserProfileFields;
  }> {
    const sanitized = this.sanitizeFields(fields);

    if (!Object.keys(sanitized).length) {
      return { skipped: true, updatedFields: {} };
    }

    await this.userProfileRepository.upsert(
      {
        userId,
        ...sanitized,
      },
      ['userId'],
    );

    return { skipped: false, updatedFields: sanitized };
  }

  async getStructuredProfile(userId: number): Promise<UserProfileFields> {
    const profile = await this.userProfileRepository.findOne({ where: { userId } });
    if (!profile) {
      return {};
    }

    const result: UserProfileFields = {};
    for (const field of USER_PROFILE_FIELDS) {
      const value = normalizeFieldValue((profile as any)[field]);
      if (value) {
        result[field] = value;
      }
    }

    return result;
  }

  async searchPreferenceMemories(
    userId: number,
    query: string,
    limit = PROFILE_PREFERENCE_LIMIT,
  ): Promise<UserProfilePreferenceContextItem[]> {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) {
      return [];
    }

    try {
      const embedding = await this.getEmbedding(normalizedQuery);
      const qdrantUrl = this.configService.get<string>('qdrant.url')!;
      const collection = this.configService.get<string>('qdrant.profileCollectionName')!;
      const response = await axios.post(
        `${qdrantUrl}/collections/${collection}/points/search`,
        {
          vector: embedding,
          limit,
          with_payload: true,
          filter: {
            must: [
              {
                key: 'userId',
                match: { value: userId },
              },
              {
                key: 'status',
                match: { value: 'active' },
              },
            ],
          },
        },
      );

      return (response.data.result || [])
        .map((point: any) => {
          const payload = point.payload || {};
          const text = normalizeFieldValue(payload.retrievalText || payload.preference);
          return text
            ? {
              text,
              time: formatBeijingTime(payload.updatedAt || payload.createdAt || ''),
            }
            : null;
        })
        .filter(Boolean)
        .slice(0, limit);
    } catch (error: any) {
      console.error('[UserProfile] Preference search error:', error?.message);
      return [];
    }
  }

  private async getEmbedding(text: string): Promise<number[]> {
    const apiKey = this.configService.get<string>('dashscope.apiKey');
    const response = await axios.post(
      this.configService.get<string>('dashscope.embeddingUrl')!,
      {
        model: this.configService.get<string>('dashscope.embeddingModel')!,
        input: { texts: [text] },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );

    const embeddings = response.data.output?.embeddings;
    if (!embeddings || !embeddings[0]?.embedding) {
      throw new Error('Invalid embedding response');
    }

    return embeddings[0].embedding;
  }
}
