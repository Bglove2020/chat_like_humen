import { Body, Controller, Param, Patch, Post } from '@nestjs/common';
import { MemoryService } from './memory.service';

@Controller('api/internal/memory')
export class MemoryController {
  constructor(private memoryService: MemoryService) {}

  @Post('lines')
  async createLine(
    @Body()
    dto: {
      userId: number;
      sessionId?: string | null;
      anchorLabel: string;
      impressionLabel?: string;
      impressionAbstract?: string;
      salienceScore?: number;
      lastActivatedAt?: string;
    },
  ) {
    return this.memoryService.createLine(dto);
  }

  @Patch('lines/:lineId/impression')
  async updateLineImpression(
    @Param('lineId') lineId: string,
    @Body()
    dto: {
      impressionLabel: string;
      impressionAbstract: string;
      salienceScore?: number;
      lastActivatedAt?: string;
    },
  ) {
    return this.memoryService.updateLineImpression({
      lineId,
      ...dto,
    });
  }

  @Post('lines/by-ids')
  async getLinesByIds(@Body() dto: { lineIds: string[] }) {
    return this.memoryService.getLinesByIds(dto.lineIds || []);
  }

  @Post('lines/recent')
  async getRecentLines(@Body() dto: { userId: number; limit?: number; days?: number }) {
    return this.memoryService.getRecentLines(dto.userId, dto.limit || 10, dto.days);
  }

  @Post('lines/keyword-search')
  async searchLinesByKeywords(@Body() dto: { userId: number; query: string; limit?: number }) {
    return this.memoryService.searchLinesByKeywords(dto.userId, dto.query, dto.limit || 10);
  }

  @Post('lines/leaf-points')
  async getLeafPointsByLineIds(@Body() dto: { lineIds: string[] }) {
    return this.memoryService.getLeafPointsByLineIds(dto.lineIds || []);
  }

  @Post('points')
  async createPoint(
    @Body()
    dto: {
      userId: number;
      sessionId?: string | null;
      lineId: string;
      op: 'new' | 'supplement' | 'revise' | 'conflict';
      sourcePointId?: string | null;
      text: string;
      memoryDate: string;
      salienceScore?: number;
    },
  ) {
    return this.memoryService.createPoint(dto);
  }

  @Patch('points/:pointId')
  async updatePointInPlace(
    @Param('pointId') pointId: string,
    @Body()
    dto: {
      text: string;
      batchId: string;
      salienceScore?: number;
    },
  ) {
    return this.memoryService.updatePointInPlace({
      pointId,
      ...dto,
    });
  }

  @Post('points/by-ids')
  async getPointsByIds(@Body() dto: { pointIds: string[] }) {
    return this.memoryService.getPointsByIds(dto.pointIds || []);
  }

  @Post('point-message-links')
  async createPointMessageLinks(
    @Body()
    dto: {
      pointId: string;
      messageIds: number[];
      batchId: string;
    },
  ) {
    return this.memoryService.recordPointMessageLinks(dto);
  }

  @Post('clear-user')
  async clearUserMemory(@Body() dto: { userId: number }) {
    await this.memoryService.clearUserMemory(dto.userId);
    return { cleared: true };
  }
}
