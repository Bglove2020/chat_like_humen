import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { UserProfileService } from './user-profile.service';

@Controller('api')
export class UserProfileController {
  constructor(private userProfileService: UserProfileService) {}

  @Post('internal/user-profiles/upsert')
  @HttpCode(HttpStatus.OK)
  async upsertProfile(
    @Body()
    dto: {
      userId: number;
      batchId?: string;
      fields: Record<string, unknown>;
    },
  ) {
    return this.userProfileService.upsertProfile(Number(dto.userId), dto.fields || {});
  }
}
