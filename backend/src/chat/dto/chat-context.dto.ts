import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ChatContextDto {
  @IsInt()
  @Min(1)
  @Type(() => Number)
  userId: number;

  @IsString()
  message: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  @Type(() => Number)
  limit?: number = 6;
}
