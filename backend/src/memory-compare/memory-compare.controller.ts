import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { MemoryCompareSearchDto } from './dto/memory-compare-search.dto';
import { MemoryCompareService } from './memory-compare.service';

@Controller('api/memory-compare')
export class MemoryCompareController {
  constructor(private memoryCompareService: MemoryCompareService) {}

  @Post('search')
  @HttpCode(HttpStatus.OK)
  async search(@Body() dto: MemoryCompareSearchDto) {
    return this.memoryCompareService.search(dto.userId, dto.query, dto.limit);
  }
}
