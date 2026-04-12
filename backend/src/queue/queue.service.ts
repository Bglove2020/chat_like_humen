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
    role: 'user' | 'assistant';
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
    const latestTimestamp =
      messages[messages.length - 1]?.timestamp || new Date().toISOString();
    const memoryDate = computeMemoryDate(latestTimestamp);
    const batchSuffix = Date.now();
    const batchId = `${userId}_${memoryDate}_${batchSuffix}`;

    await this.summaryQueue.add(
      'summary',
      {
        userId,
        sessionId,
        date: memoryDate,
        batchId,
        messages,
      },
      {
        attempts: SUMMARY_JOB_ATTEMPTS,
        backoff: {
          type: 'exponential',
          delay: SUMMARY_JOB_BACKOFF_DELAY_MS,
        },
        removeOnComplete: 500,
        removeOnFail: false,
      },
    );

    console.log(
      `[Queue] Enqueued summary job: ${batchId} messages=${messages.length} (attempts=${SUMMARY_JOB_ATTEMPTS}, backoff=exponential:${SUMMARY_JOB_BACKOFF_DELAY_MS}ms)`,
    );

    return { batchId, date: memoryDate };
  }

  async enqueueFactBatch(
    userId: number,
    batchId: string,
    messages: FactJobData['messages'],
  ): Promise<void> {
    const normalizedMessages = messages
      .filter(
        (message) => message.role === 'user' || message.role === 'assistant',
      )
      .filter((message) => String(message.content || '').trim());

    const hasUserMessages = normalizedMessages.some(
      (message) => message.role === 'user',
    );
    if (!hasUserMessages) {
      return;
    }

    await this.factQueue.add(
      'fact',
      {
        userId,
        batchId,
        messages: normalizedMessages,
      },
      {
        attempts: FACT_JOB_ATTEMPTS,
        backoff: {
          type: 'exponential',
          delay: FACT_JOB_BACKOFF_DELAY_MS,
        },
        removeOnComplete: 500,
        removeOnFail: false,
      },
    );

    console.log(
      `[Queue] Enqueued fact job: ${batchId} messages=${normalizedMessages.length} (attempts=${FACT_JOB_ATTEMPTS}, backoff=exponential:${FACT_JOB_BACKOFF_DELAY_MS}ms)`,
    );
  }
}
