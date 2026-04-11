import { UserProfileService } from './user-profile.service';

describe('UserProfileService', () => {
  it('skips upsert when all fields are empty or unknown', async () => {
    const repository = {
      upsert: jest.fn(),
      findOne: jest.fn(),
    };
    const service = new UserProfileService(repository as any, { get: jest.fn() } as any);

    const result = await service.upsertProfile(1, {
      nickname: '',
      favorite_food: [],
      unknown: 'ignored',
    });

    expect(result).toEqual({ skipped: true, updatedFields: {} });
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it('upserts non-empty whitelisted fields by userId', async () => {
    const repository = {
      upsert: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn(),
    };
    const service = new UserProfileService(repository as any, { get: jest.fn() } as any);

    const result = await service.upsertProfile(1, {
      nickname: ' 小张 ',
      favorite_food: ['火锅', '寿司'],
      unknown: 'ignored',
    });

    expect(repository.upsert).toHaveBeenCalledWith(
      {
        userId: 1,
        nickname: '小张',
        favorite_food: '火锅、寿司',
      },
      ['userId'],
    );
    expect(result).toEqual({
      skipped: false,
      updatedFields: {
        nickname: '小张',
        favorite_food: '火锅、寿司',
      },
    });
  });
});
