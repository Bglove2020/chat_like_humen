import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
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

export interface EnqueuedSummaryBatch {
  batchId: string;
  date: string;
}

const SUMMARY_JOB_ATTEMPTS = 4;
const SUMMARY_JOB_BACKOFF_DELAY_MS = 5000;
const FACT_JOB_ATTEMPTS = 3;
const FACT_JOB_BACKOFF_DELAY_MS = 5000;

@Injectable()
export class QueueService {
  constructor(
    @InjectQueue('chat-summary-queue')
    private summaryQueue: Queue<SummaryJobData>,
    @InjectQueue('chat-fact-queue')
    private factQueue: Queue<FactJobData>,
  ) {}

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
}
