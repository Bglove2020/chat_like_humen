import { Controller, Post, Body, UseGuards, Request, Get, Param, Delete, HttpCode, HttpStatus } from '@nestjs/common';
import { ChatService } from './chat.service';
import { SendMessageDto } from './dto/send-message.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateSessionDto } from './dto/create-session.dto';
import { ChatContextDto } from './dto/chat-context.dto';
import { ChatContextService } from './chat-context.service';

@Controller('api')
export class ChatController {
  constructor(
    private chatService: ChatService,
    private chatContextService: ChatContextService,
  ) {}

  @Get('chat-sessions')
  @UseGuards(JwtAuthGuard)
  async listSessions(@Request() req: any) {
    const { userId } = req.user;
    return this.chatService.listSessions(userId);
  }

  @Post('chat-sessions')
  @UseGuards(JwtAuthGuard)
  async createSession(@Request() req: any, @Body() dto: CreateSessionDto) {
    const { userId } = req.user;
    return this.chatService.createSession(userId, dto.title);
  }

  @Get('chat-sessions/:sessionId/messages')
  @UseGuards(JwtAuthGuard)
  async getSessionMessages(@Request() req: any, @Param('sessionId') sessionId: string) {
    const { userId } = req.user;
    return this.chatService.getSessionMessages(userId, sessionId);
  }

  @Delete('chat-sessions/:sessionId')
  @UseGuards(JwtAuthGuard)
  async deleteSession(@Request() req: any, @Param('sessionId') sessionId: string) {
    const { userId } = req.user;
    await this.chatService.deleteSession(userId, sessionId);
    return { success: true };
  }

  @Post('chat')
  @UseGuards(JwtAuthGuard)
  async sendMessage(@Request() req: any, @Body() dto: SendMessageDto) {
    const { userId } = req.user;
    return this.chatService.sendMessage(userId, dto.message, dto.sessionId);
  }

  @Post('chat-context')
  @HttpCode(HttpStatus.OK)
  async getChatContext(@Body() dto: ChatContextDto) {
    return this.chatContextService.getContext(dto.userId, dto.message, dto.limit);
  }
}
