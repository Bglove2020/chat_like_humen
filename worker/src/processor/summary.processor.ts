import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { QdrantService, SummaryJobData } from '../services/qdrant.service';

const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '5', 10);
const LOCK_TTL_MS = 15 * 60 * 1000; // Keep the per-user lock across retries.
const LOCK_CONFLICT_DELAY_MS = 3000; // Re-check soon without burning a retry attempt.
const RETRY_DELAY_BUFFER_MS = 500;

@Processor('chat-summary-queue', { concurrency: WORKER_CONCURRENCY })
export class SummaryProcessor extends WorkerHost {
  private redis: Redis;

  constructor(
    private qdrantService: QdrantService,
    private configService: ConfigService,
  ) {
    super();
    this.redis = new Redis({
      host: this.configService.get<string>('redis.host') || 'localhost',
      port: this.configService.get<number>('redis.port') || 6379,
      password: this.configService.get<string>('redis.password') || undefined,
    });
    console.log('[Processor] Redis lock connection initialized');
  }

  async process(job: Job<SummaryJobData>, token?: string): Promise<void> {
    const userId = job.data.userId;
    const lockKey = `processing:user:${userId}`;
    const retryAtKey = `${lockKey}:retryAt`;
    const jobId = String(job.id || 'unknown');
    const totalAttempts = job.opts.attempts || 1;
    const currentAttempt = job.attemptsMade + 1;
    let lockOwnedByCurrentJob = false;
    let releaseLock = true;

    console.log(
      `[Processor] Received job ${job.id} (batchId: ${job.data.batchId}) for user ${userId} ` +
      `(attempt ${currentAttempt}/${totalAttempts})`,
    );

    const lockAcquired = await this.tryAcquireUserLock(lockKey, jobId);
    if (!lockAcquired) {
      const lockOwner = await this.redis.get(lockKey);
      const retryAt = parseInt((await this.redis.get(retryAtKey)) || '0', 10);
      const rescheduleDelayMs = retryAt > Date.now()
        ? Math.max(LOCK_CONFLICT_DELAY_MS, retryAt - Date.now() + RETRY_DELAY_BUFFER_MS)
        : LOCK_CONFLICT_DELAY_MS;
      console.log(
        `[Processor] User ${userId} is blocked by job ${lockOwner}; delaying job ${job.id} by ${rescheduleDelayMs}ms` +
        `${retryAt ? ` (retryAt=${new Date(retryAt).toISOString()})` : ''}`,
      );
      if (!token) {
        throw new Error(`Missing BullMQ token while delaying job ${job.id} for user ${userId}`);
      }
      await job.moveToDelayed(Date.now() + rescheduleDelayMs, token);
      throw new DelayedError(
        `User ${userId} is locked by job ${lockOwner}; job ${job.id} moved to delayed`,
      );
    }
    lockOwnedByCurrentJob = true;

    try {
      console.log(`[Processor] Acquired lock for user ${userId} with job ${job.id}`);
      await this.qdrantService.processSummaryJob(job.data);
    } catch (error: any) {
      const willRetry = currentAttempt < totalAttempts;
      if (willRetry && lockOwnedByCurrentJob) {
        releaseLock = false;
        await this.redis.pexpire(lockKey, LOCK_TTL_MS);
        const retryDelayMs = this.getRetryDelayMs(job, currentAttempt);
        const retryAt = Date.now() + retryDelayMs;
        await this.redis.set(retryAtKey, String(retryAt), 'PX', LOCK_TTL_MS);
        console.error(
          `[Processor] Scheduled retry for job ${job.id} at ${new Date(retryAt).toISOString()} (+${retryDelayMs}ms)`,
        );
      }
      console.error(
        `[Processor] Job ${job.id} failed on attempt ${currentAttempt}/${totalAttempts}: ${error?.message}`,
      );
      console.error(
        `[Processor] Failure policy for job ${job.id}: ${willRetry ? 'retrying with retained user lock' : 'final failure, releasing user lock'}`,
      );
      throw error;
    } finally {
      if (!lockOwnedByCurrentJob) {
        // Lock was never acquired by this job.
      } else if (!releaseLock) {
        console.log(`[Processor] Retaining lock for user ${userId} until job ${job.id} retry completes`);
      } else {
        const lockOwner = await this.redis.get(lockKey);
        if (lockOwner === jobId) {
          await this.redis.del(retryAtKey);
          await this.redis.del(lockKey);
          console.log(`[Processor] Released lock for user ${userId}`);
        } else {
          console.log(
            `[Processor] Skip releasing lock for user ${userId}; current owner is ${lockOwner}`,
          );
        }
      }
    }
  }

  private async tryAcquireUserLock(lockKey: string, jobId: string): Promise<boolean> {
    const currentOwner = await this.redis.get(lockKey);
    const retryAtKey = `${lockKey}:retryAt`;

    if (currentOwner === jobId) {
      await this.redis.pexpire(lockKey, LOCK_TTL_MS);
      await this.redis.del(retryAtKey);
      console.log(`[Processor] Re-entered lock ${lockKey} for retrying job ${jobId}`);
      return true;
    }

    if (currentOwner) {
      return false;
    }

    const acquired = await this.redis.set(lockKey, jobId, 'PX', LOCK_TTL_MS, 'NX');
    return acquired === 'OK';
  }

  private getRetryDelayMs(job: Job<SummaryJobData>, currentAttempt: number): number {
    const backoff = job.opts.backoff;
    if (!backoff) {
      return 0;
    }

    if (typeof backoff === 'number') {
      return backoff;
    }

    const baseDelay = typeof backoff.delay === 'number' ? backoff.delay : 0;
    if (backoff.type === 'exponential') {
      return baseDelay * Math.pow(2, Math.max(0, currentAttempt - 1));
    }

    return baseDelay;
  }
}
