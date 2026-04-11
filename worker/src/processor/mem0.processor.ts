import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { Mem0JobData, Mem0Service } from '../services/mem0.service';

const MEM0_WORKER_CONCURRENCY = parseInt(process.env.MEM0_WORKER_CONCURRENCY || '2', 10);

@Processor('chat-mem0-queue', { concurrency: MEM0_WORKER_CONCURRENCY })
export class Mem0Processor extends WorkerHost {
  constructor(
    private mem0Service: Mem0Service,
    private configService: ConfigService,
  ) {
    super();
  }

  async process(job: Job<Mem0JobData>): Promise<void> {
    const enabled = this.configService.get<boolean>('mem0.enabled') === true;
    const totalAttempts = job.opts.attempts || 1;
    const currentAttempt = job.attemptsMade + 1;

    if (!enabled) {
      console.log(`[Mem0Processor] Skip job ${job.id}: MEM0_ENABLED is false`);
      return;
    }

    console.log(
      `[Mem0Processor] Processing job ${job.id} batch=${job.data.batchId} user=${job.data.userId} ` +
      `(attempt ${currentAttempt}/${totalAttempts})`,
    );

    try {
      await this.mem0Service.addMessages(job.data);
    } catch (error: any) {
      console.error(
        `[Mem0Processor] Job ${job.id} batch=${job.data.batchId} failed on attempt ` +
        `${currentAttempt}/${totalAttempts}: ${error?.message}`,
      );
      throw error;
    }
  }
}
