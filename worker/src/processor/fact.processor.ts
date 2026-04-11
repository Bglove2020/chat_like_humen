import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { FactExtractionService, FactMessageInput } from '../services/fact-extraction.service';
import { UserProfileMemoryService } from '../services/user-profile-memory.service';

export interface FactJobData {
  userId: number;
  batchId: string;
  messages: FactMessageInput[];
}

const FACT_WORKER_CONCURRENCY = parseInt(process.env.FACT_WORKER_CONCURRENCY || process.env.WORKER_CONCURRENCY || '5', 10);

@Processor('chat-fact-queue', { concurrency: FACT_WORKER_CONCURRENCY })
export class FactProcessor extends WorkerHost {
  constructor(
    private factExtractionService: FactExtractionService,
    private userProfileMemoryService: UserProfileMemoryService,
    private configService: ConfigService,
  ) {
    super();
  }

  async process(job: Job<FactJobData>): Promise<void> {
    const { userId, batchId } = job.data;
    const messages = (job.data.messages || [])
      .filter((message) => message.role === 'user')
      .filter((message) => String(message.content || '').trim());

    console.log(`[FactProcessor] Received job ${job.id} (batchId: ${batchId}) for user ${userId}, userMessages=${messages.length}`);

    if (!messages.length) {
      return;
    }

    const extraction = await this.factExtractionService.extract(messages);
    const fixedFieldCount = Object.keys(extraction.structuredProfile).length;

    if (fixedFieldCount > 0) {
      await this.upsertStructuredProfile(userId, batchId, extraction.structuredProfile);
    }

    const memoryStats = await this.userProfileMemoryService.reconcileAndPersist(
      userId,
      batchId,
      extraction.preferenceMemories,
    );

    console.log(
      `[FactProcessor] Finished batch ${batchId}: fixedFields=${fixedFieldCount}, ` +
      `preferenceCandidates=${memoryStats.candidates}, created=${memoryStats.created}, ` +
      `updated=${memoryStats.updated}, superseded=${memoryStats.superseded}, discarded=${memoryStats.discarded}`,
    );
  }

  private async upsertStructuredProfile(
    userId: number,
    batchId: string,
    fields: Record<string, string>,
  ): Promise<void> {
    const backendInternalUrl = this.configService.get<string>('backend.internalUrl')!;

    await axios.post(`${backendInternalUrl}/api/internal/user-profiles/upsert`, {
      userId,
      batchId,
      fields,
    });
  }
}
