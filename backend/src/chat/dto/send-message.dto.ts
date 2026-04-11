import { IsString, IsNotEmpty, IsOptional, IsUUID } from 'class-validator';

export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  message: string;

  @IsOptional()
  @IsUUID()
  sessionId?: string;
}
