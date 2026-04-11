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

const SUMMARY_JOB_ATTEMPTS = 4;
const SUMMARY_JOB_BACKOFF_DELAY_MS = 5000;

@Injectable()
export class QueueService {
  constructor(
    @InjectQueue('chat-summary-queue')
    private summaryQueue: Queue<SummaryJobData>,
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
  ): Promise<void> {
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
  }
}
