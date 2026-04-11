import { Injectable, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { computeMemoryDate } from './memory-date.util';

export interface SummaryJobData {
  userId: number;
  sessionId?: string;
  date: string;
  batchId: string;
  messages: Array<{
    messageId?: number;
    role: string;
    content: string;
    timestamp: string;
    isNew?: boolean;
  }>;
}

export interface FactJobData {
  userId: number;
  batchId: string;
  messages: Array<{
    messageId?: number;
    role: 'user';
    content: string;
    timestamp: string;
  }>;
}

export interface Mem0JobData {
  userId: number;
  sessionId?: string;
  date: string;
  batchId: string;
  messages: Array<{
    messageId?: number;
    role: string;
    content: string;
    timestamp: string;
    isNew?: boolean;
  }>;
}

export interface EnqueuedSummaryBatch {
  batchId: string;
  date: string;
}

const SUMMARY_JOB_ATTEMPTS = 4;
const SUMMARY_JOB_BACKOFF_DELAY_MS = 5000;
const FACT_JOB_ATTEMPTS = 3;
const FACT_JOB_BACKOFF_DELAY_MS = 5000;
const MEM0_JOB_ATTEMPTS = 3;
const MEM0_JOB_BACKOFF_DELAY_MS = 10000;

@Injectable()
export class QueueService {
  constructor(
    @InjectQueue('chat-summary-queue')
    private summaryQueue: Queue<SummaryJobData>,
    @InjectQueue('chat-fact-queue')
    private factQueue: Queue<FactJobData>,
    @Optional()
    @InjectQueue('chat-mem0-queue')
    private mem0Queue?: Queue<Mem0JobData>,
    @Optional()
    private configService?: ConfigService,
  ) {}

  private isMem0Enabled(): boolean {
    if (!this.configService) {
      return false;
    }

    return this.configService.get<boolean>('mem0.enabled') === true;
  }

  async enqueueSummaryBatch(
    userId: number,
    sessionId: string | undefined,
    messages: Array<{
      messageId?: number;
      role: string;
      content: string;
      timestamp: string;
      isNew?: boolean;
    }>,
  ): Promise<EnqueuedSummaryBatch> {
    const latestTimestamp = messages[messages.length - 1]?.timestamp || new Date().toISOString();
    const memoryDate = computeMemoryDate(latestTimestamp);
    const batchSuffix = Date.now();
    const batchId = `${userId}_${memoryDate}_${batchSuffix}`;

    await this.summaryQueue.add('summary', {
      userId,
      sessionId,
      date: memoryDate,
      batchId,
      messages: messages.slice(-15),
    }, {
      attempts: SUMMARY_JOB_ATTEMPTS,
      backoff: {
        type: 'exponential',
        delay: SUMMARY_JOB_BACKOFF_DELAY_MS,
      },
      removeOnComplete: 500,
      removeOnFail: false,
    });

    console.log(
      `[Queue] Enqueued summary job: ${batchId} (attempts=${SUMMARY_JOB_ATTEMPTS}, backoff=exponential:${SUMMARY_JOB_BACKOFF_DELAY_MS}ms)`,
    );

    return { batchId, date: memoryDate };
  }

  async enqueueFactBatch(
    userId: number,
    batchId: string,
    messages: FactJobData['messages'],
  ): Promise<void> {
    const userMessages = messages
      .filter((message) => message.role === 'user')
      .filter((message) => String(message.content || '').trim());

    if (!userMessages.length) {
      return;
    }

    await this.factQueue.add('fact', {
      userId,
      batchId,
      messages: userMessages,
    }, {
      attempts: FACT_JOB_ATTEMPTS,
      backoff: {
        type: 'exponential',
        delay: FACT_JOB_BACKOFF_DELAY_MS,
      },
      removeOnComplete: 500,
      removeOnFail: false,
    });

    console.log(
      `[Queue] Enqueued fact job: ${batchId} messages=${userMessages.length} (attempts=${FACT_JOB_ATTEMPTS}, backoff=exponential:${FACT_JOB_BACKOFF_DELAY_MS}ms)`,
    );
  }

  async enqueueMem0Batch(
    userId: number,
    sessionId: string | undefined,
    messages: Array<{
      messageId?: number;
      role: string;
      content: string;
      timestamp: string;
      isNew?: boolean;
    }>,
    batchId?: string,
    date?: string,
  ): Promise<Mem0JobData | null> {
    if (!this.isMem0Enabled()) {
      return null;
    }

    if (!this.mem0Queue) {
      console.warn('[Queue] MEM0_ENABLED=true but chat-mem0-queue is not registered');
      return null;
    }

    const newMessages = messages.filter((message) => message.isNew !== false);
    if (!newMessages.length) {
      console.log('[Queue] Skip Mem0 job because batch has no new messages');
      return null;
    }

    const latestTimestamp = newMessages[newMessages.length - 1]?.timestamp || new Date().toISOString();
    const memoryDate = date || computeMemoryDate(latestTimestamp);
    const resolvedBatchId = batchId || `${userId}_${memoryDate}_${Date.now()}`;
    const payload: Mem0JobData = {
      userId,
      sessionId,
      date: memoryDate,
      batchId: resolvedBatchId,
      messages: newMessages,
    };

    await this.mem0Queue.add('mem0', payload, {
      attempts: MEM0_JOB_ATTEMPTS,
      backoff: {
        type: 'exponential',
        delay: MEM0_JOB_BACKOFF_DELAY_MS,
      },
      removeOnComplete: 500,
      removeOnFail: false,
    });

    console.log(
      `[Queue] Enqueued Mem0 job: ${resolvedBatchId} (messages=${newMessages.length}, attempts=${MEM0_JOB_ATTEMPTS})`,
    );

    return payload;
  }
}
