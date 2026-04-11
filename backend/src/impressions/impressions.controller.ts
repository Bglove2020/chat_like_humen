import { Controller, Post, Get, Param, Body } from '@nestjs/common';
import {
  ImpressionMessageRecord,
  ImpressionRecord,
  ImpressionsService,
} from './impressions.service';
import { SearchDto } from './dto/search.dto';

@Controller('api')
export class ImpressionsController {
  constructor(private impressionsService: ImpressionsService) {}

  @Post('retrieve')
  async search(@Body() dto: SearchDto) {
    return this.impressionsService.search(dto.query, dto.limit);
  }

  @Get('impressions/:userId')
  async getUserImpressions(@Param('userId') userId: string): Promise<{ impressions: ImpressionRecord[], total: number }> {
    const impressions = await this.impressionsService.getUserImpressions(parseInt(userId, 10));
    return { impressions, total: impressions.length };
  }

  @Get('impression-sources/:impressionId')
  async getImpressionSources(@Param('impressionId') impressionId: string) {
    const sources = await this.impressionsService.getImpressionSources(impressionId);
    return { impressionId, sources, total: sources.length };
  }

  @Get('impression-messages/:impressionId')
  async getImpressionMessages(
    @Param('impressionId') impressionId: string,
  ): Promise<{ impressionId: string; messages: ImpressionMessageRecord[]; total: number }> {
    const messages = await this.impressionsService.getImpressionMessages(impressionId);
    return { impressionId, messages, total: messages.length };
  }

  @Post('internal/impression-edges')
  async createImpressionEdge(
    @Body()
    dto: {
      userId: number;
      fromImpressionId: string;
      toImpressionId: string;
      relationType?: string;
      batchId: string;
    },
  ) {
    return this.impressionsService.recordImpressionEdge(dto);
  }

  @Post('internal/impression-message-links')
  async createImpressionMessageLinks(
    @Body()
    dto: {
      impressionId: string;
      messageIds: number[];
      batchId: string;
    },
  ) {
    return this.impressionsService.recordImpressionMessageLinks(dto);
  }
}
