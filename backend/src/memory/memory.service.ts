import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { In, Repository } from 'typeorm';
import { ChatMessage } from '../chat/chat_message.entity';
import { MemoryLine } from './memory-line.entity';
import { MemoryPoint, MemoryPointOp } from './memory-point.entity';
import { PointMessageLink } from './point-message-link.entity';
import { PointRevisionLog } from './point-revision-log.entity';

export interface MemoryLineRecord {
  id: string;
  userId: number;
  sessionId: string | null;
  anchorLabel: string;
  impressionLabel: string;
  impressionAbstract: string;
  impressionVersion: number;
  salienceScore: number;
  lastActivatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryPointRecord {
  id: string;
  userId: number;
  sessionId: string | null;
  lineId: string;
  op: MemoryPointOp;
  sourcePointId: string | null;
  text: string;
  memoryDate: string;
  salienceScore: number;
  createdAt: string;
  updatedAt: string;
}

interface CreateLineParams {
  userId: number;
  sessionId?: string | null;
  anchorLabel: string;
  impressionLabel?: string;
  impressionAbstract?: string;
  salienceScore?: number;
  lastActivatedAt?: string;
}

interface UpdateLineImpressionParams {
  lineId: string;
  impressionLabel: string;
  impressionAbstract: string;
  salienceScore?: number;
  lastActivatedAt?: string;
}

interface CreatePointParams {
  userId: number;
  sessionId?: string | null;
  lineId: string;
  op: MemoryPointOp;
  sourcePointId?: string | null;
  text: string;
  memoryDate: string;
  salienceScore?: number;
}

interface UpdatePointInPlaceParams {
  pointId: string;
  text: string;
  batchId: string;
  salienceScore?: number;
}

interface RecordPointMessageLinksParams {
  pointId: string;
  messageIds: number[];
  batchId: string;
}

export interface LineMessageRecord {
  batchId: string;
  linkedAt: string;
  message: {
    id: number;
    role: 'user' | 'assistant';
    content: string;
    sessionId: string | null;
    createdAt: string;
  } | null;
}

const DEFAULT_SALIENCE_SCORE = 1;

function toIso(value: Date | null | undefined): string {
  return value ? value.toISOString() : '';
}

function extractKeywordTokens(query: string): string[] {
  return Array.from(new Set(
    String(query || '')
      .match(/[\p{L}\p{N}]{2,}/gu) || [],
  ))
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 8);
}

@Injectable()
export class MemoryService {
  constructor(
    @InjectRepository(MemoryLine)
    private memoryLineRepository: Repository<MemoryLine>,
    @InjectRepository(MemoryPoint)
    private memoryPointRepository: Repository<MemoryPoint>,
    @InjectRepository(PointRevisionLog)
    private pointRevisionLogRepository: Repository<PointRevisionLog>,
    @InjectRepository(PointMessageLink)
    private pointMessageLinkRepository: Repository<PointMessageLink>,
    @InjectRepository(ChatMessage)
    private chatMessageRepository: Repository<ChatMessage>,
  ) {}

  private mapLine(entity: MemoryLine): MemoryLineRecord {
    return {
      id: entity.id,
      userId: entity.userId,
      sessionId: entity.sessionId ?? null,
      anchorLabel: entity.anchorLabel,
      impressionLabel: entity.impressionLabel,
      impressionAbstract: entity.impressionAbstract,
      impressionVersion: entity.impressionVersion,
      salienceScore: Number(entity.salienceScore || DEFAULT_SALIENCE_SCORE),
      lastActivatedAt: toIso(entity.lastActivatedAt),
      createdAt: toIso(entity.createdAt),
      updatedAt: toIso(entity.updatedAt),
    };
  }

  private mapPoint(entity: MemoryPoint): MemoryPointRecord {
    return {
      id: entity.id,
      userId: entity.userId,
      sessionId: entity.sessionId ?? null,
      lineId: entity.lineId,
      op: entity.op,
      sourcePointId: entity.sourcePointId ?? null,
      text: entity.text,
      memoryDate: entity.memoryDate,
      salienceScore: Number(entity.salienceScore || DEFAULT_SALIENCE_SCORE),
      createdAt: toIso(entity.createdAt),
      updatedAt: toIso(entity.updatedAt),
    };
  }

  async createLine(params: CreateLineParams): Promise<MemoryLineRecord> {
    const now = params.lastActivatedAt ? new Date(params.lastActivatedAt) : new Date();
    const line = this.memoryLineRepository.create({
      id: randomUUID(),
      userId: params.userId,
      sessionId: params.sessionId ?? null,
      anchorLabel: params.anchorLabel.trim(),
      impressionLabel: (params.impressionLabel || params.anchorLabel).trim(),
      impressionAbstract: (params.impressionAbstract || '').trim(),
      impressionVersion: 1,
      salienceScore: params.salienceScore ?? DEFAULT_SALIENCE_SCORE,
      lastActivatedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await this.memoryLineRepository.save(line);
    return this.mapLine(line);
  }

  async updateLineImpression(params: UpdateLineImpressionParams): Promise<MemoryLineRecord | null> {
    const line = await this.memoryLineRepository.findOne({ where: { id: params.lineId } });
    if (!line) {
      return null;
    }

    line.impressionLabel = params.impressionLabel.trim();
    line.impressionAbstract = params.impressionAbstract.trim();
    line.impressionVersion = Math.max(1, Number(line.impressionVersion || 0) + 1);
    if (typeof params.salienceScore === 'number') {
      line.salienceScore = params.salienceScore;
    }
    line.lastActivatedAt = params.lastActivatedAt ? new Date(params.lastActivatedAt) : new Date();

    await this.memoryLineRepository.save(line);
    return this.mapLine(line);
  }

  async getLineById(lineId: string): Promise<MemoryLineRecord | null> {
    const line = await this.memoryLineRepository.findOne({ where: { id: lineId } });
    return line ? this.mapLine(line) : null;
  }

  async getLinesByIds(lineIds: string[]): Promise<MemoryLineRecord[]> {
    const uniqueLineIds = Array.from(new Set(lineIds.filter(Boolean)));
    if (!uniqueLineIds.length) {
      return [];
    }

    const lines = await this.memoryLineRepository.find({
      where: { id: In(uniqueLineIds) },
      order: { lastActivatedAt: 'DESC', updatedAt: 'DESC' },
    });
    return lines.map((line) => this.mapLine(line));
  }

  async getAllLines(userId: number): Promise<MemoryLineRecord[]> {
    const lines = await this.memoryLineRepository.find({
      where: { userId },
      order: { lastActivatedAt: 'DESC', updatedAt: 'DESC' },
    });
    return lines.map((line) => this.mapLine(line));
  }

  async getRecentLines(userId: number, limit: number, days?: number): Promise<MemoryLineRecord[]> {
    const take = Math.max(1, Math.min(limit || 10, 50));

    if (Number.isInteger(days) && (days || 0) > 0) {
      const cutoff = new Date(Date.now() - (days! * 24 * 60 * 60 * 1000));
      const lines = await this.memoryLineRepository
        .createQueryBuilder('line')
        .where('line.user_id = :userId', { userId })
        .andWhere('line.last_activated_at >= :cutoff', { cutoff })
        .orderBy('line.last_activated_at', 'DESC')
        .addOrderBy('line.updated_at', 'DESC')
        .take(take)
        .getMany();
      return lines.map((line) => this.mapLine(line));
    }

    const lines = await this.memoryLineRepository.find({
      where: { userId },
      order: { lastActivatedAt: 'DESC', updatedAt: 'DESC' },
      take,
    });
    return lines.map((line) => this.mapLine(line));
  }

  async searchLinesByKeywords(userId: number, query: string, limit: number): Promise<MemoryLineRecord[]> {
    const tokens = extractKeywordTokens(query);
    if (!tokens.length) {
      return [];
    }

    const lines = await this.memoryLineRepository.find({
      where: { userId },
      order: { lastActivatedAt: 'DESC', updatedAt: 'DESC' },
      take: 200,
    });

    return lines
      .map((line) => {
        const haystack = [
          line.anchorLabel,
          line.impressionLabel,
          line.impressionAbstract,
        ].join(' ').toLowerCase();
        const score = tokens.reduce((total, token) => (
          haystack.includes(token) ? total + 1 : total
        ), 0);
        return { line, score };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return right.line.lastActivatedAt.getTime() - left.line.lastActivatedAt.getTime();
      })
      .slice(0, Math.max(1, Math.min(limit || 10, 30)))
      .map((item) => this.mapLine(item.line));
  }

  async createPoint(params: CreatePointParams): Promise<MemoryPointRecord> {
    const point = this.memoryPointRepository.create({
      id: randomUUID(),
      userId: params.userId,
      sessionId: params.sessionId ?? null,
      lineId: params.lineId,
      op: params.op,
      sourcePointId: params.sourcePointId ?? null,
      text: params.text.trim(),
      memoryDate: params.memoryDate,
      salienceScore: params.salienceScore ?? DEFAULT_SALIENCE_SCORE,
    });
    await this.memoryPointRepository.save(point);
    return this.mapPoint(point);
  }

  async updatePointInPlace(params: UpdatePointInPlaceParams): Promise<MemoryPointRecord | null> {
    const point = await this.memoryPointRepository.findOne({ where: { id: params.pointId } });
    if (!point) {
      return null;
    }

    const nextText = params.text.trim();
    const beforeText = point.text;

    if (beforeText !== nextText) {
      const revisionLog = this.pointRevisionLogRepository.create({
        id: randomUUID(),
        pointId: point.id,
        beforeText,
        afterText: nextText,
        batchId: params.batchId,
      });
      await this.pointRevisionLogRepository.save(revisionLog);
      point.text = nextText;
    }

    if (typeof params.salienceScore === 'number') {
      point.salienceScore = params.salienceScore;
    }

    await this.memoryPointRepository.save(point);
    return this.mapPoint(point);
  }

  async getPointById(pointId: string): Promise<MemoryPointRecord | null> {
    const point = await this.memoryPointRepository.findOne({ where: { id: pointId } });
    return point ? this.mapPoint(point) : null;
  }

  async getPointsByIds(pointIds: string[]): Promise<MemoryPointRecord[]> {
    const uniquePointIds = Array.from(new Set(pointIds.filter(Boolean)));
    if (!uniquePointIds.length) {
      return [];
    }

    const points = await this.memoryPointRepository.find({
      where: { id: In(uniquePointIds) },
      order: { updatedAt: 'DESC', createdAt: 'DESC' },
    });
    return points.map((point) => this.mapPoint(point));
  }

  async getLeafPoints(lineId: string): Promise<MemoryPointRecord[]> {
    return this.getLeafPointsByLineIds([lineId]).then((map) => map[lineId] || []);
  }

  async getLeafPointsByLineIds(lineIds: string[]): Promise<Record<string, MemoryPointRecord[]>> {
    const uniqueLineIds = Array.from(new Set(lineIds.filter(Boolean)));
    if (!uniqueLineIds.length) {
      return {};
    }

    const points = await this.memoryPointRepository
      .createQueryBuilder('point')
      .leftJoin(
        MemoryPoint,
        'child',
        'child.source_point_id = point.id',
      )
      .where('point.line_id IN (:...lineIds)', { lineIds: uniqueLineIds })
      .andWhere('child.id IS NULL')
      .orderBy('point.updated_at', 'DESC')
      .addOrderBy('point.created_at', 'DESC')
      .getMany();

    const grouped: Record<string, MemoryPointRecord[]> = {};
    for (const point of points) {
      if (!grouped[point.lineId]) {
        grouped[point.lineId] = [];
      }
      grouped[point.lineId].push(this.mapPoint(point));
    }

    for (const lineId of uniqueLineIds) {
      if (!grouped[lineId]) {
        grouped[lineId] = [];
      }
    }

    return grouped;
  }

  async recordPointMessageLinks(params: RecordPointMessageLinksParams): Promise<{ created: number }> {
    const pointId = params.pointId?.trim();
    const batchId = params.batchId?.trim();
    const uniqueMessageIds = Array.from(
      new Set((params.messageIds || []).map((messageId) => Number(messageId)).filter(Number.isInteger)),
    );

    if (!pointId || !batchId || !uniqueMessageIds.length) {
      return { created: 0 };
    }

    const existing = await this.pointMessageLinkRepository.find({
      where: {
        pointId,
        batchId,
        messageId: In(uniqueMessageIds),
      },
    });
    const existingMessageIds = new Set(existing.map((item) => item.messageId));
    const toInsert = uniqueMessageIds
      .filter((messageId) => !existingMessageIds.has(messageId))
      .map((messageId) => this.pointMessageLinkRepository.create({
        pointId,
        messageId,
        batchId,
      }));

    if (!toInsert.length) {
      return { created: 0 };
    }

    await this.pointMessageLinkRepository.save(toInsert);
    return { created: toInsert.length };
  }

  async getLineMessages(lineId: string): Promise<LineMessageRecord[]> {
    const points = await this.memoryPointRepository.find({
      where: { lineId },
      select: ['id'],
      order: { createdAt: 'ASC' },
    });
    const pointIds = points.map((point) => point.id);
    if (!pointIds.length) {
      return [];
    }

    const links = await this.pointMessageLinkRepository.find({
      where: { pointId: In(pointIds) },
      order: { createdAt: 'ASC' },
    });
    if (!links.length) {
      return [];
    }

    const messageIds = Array.from(new Set(links.map((link) => link.messageId)));
    const messages = await this.chatMessageRepository.find({
      where: { id: In(messageIds) },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    const messageById = new Map(messages.map((message) => [message.id, message]));

    return links.map((link) => {
      const message = messageById.get(link.messageId);
      return {
        batchId: link.batchId,
        linkedAt: toIso(link.createdAt),
        message: message ? {
          id: message.id,
          role: message.role,
          content: message.content,
          sessionId: message.chatSessionId,
          createdAt: toIso(message.createdAt),
        } : null,
      };
    });
  }

  async clearUserMemory(userId: number): Promise<void> {
    const points = await this.memoryPointRepository.find({
      where: { userId },
      select: ['id'],
    });
    const pointIds = points.map((point) => point.id);

    if (pointIds.length) {
      await this.pointMessageLinkRepository.delete({ pointId: In(pointIds) });
      await this.pointRevisionLogRepository.delete({ pointId: In(pointIds) });
      await this.memoryPointRepository.delete({ id: In(pointIds) });
    }

    await this.memoryLineRepository.delete({ userId });
  }
}
