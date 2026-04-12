import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  FactExtractionService,
  FactMessageInput,
} from '../services/fact-extraction.service';
import { UserProfileMemoryService } from '../services/user-profile-memory.service';

export interface FactJobData {
  openId: string;
  batchId: string;
  messages: FactMessageInput[];
}

const FACT_WORKER_CONCURRENCY = parseInt(
  process.env.FACT_WORKER_CONCURRENCY || process.env.WORKER_CONCURRENCY || '5',
  10,
);

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
    const { openId, batchId } = job.data;
    const messages = (job.data.messages || [])
      .filter(
        (message) => message.role === 'user' || message.role === 'assistant',
      )
      .filter((message) => String(message.content || '').trim());
    const userMessages = messages.filter((message) => message.role === 'user');

    console.log(
      `[FactProcessor] Received job ${job.id} (batchId: ${batchId}) for openId ${openId}, ` +
        `messages=${messages.length}, userMessages=${userMessages.length}`,
    );

    if (!userMessages.length) {
      return;
    }

    const extraction = await this.factExtractionService.extract(messages);
    const fixedFieldCount = Object.keys(extraction.structuredProfile).length;

    if (fixedFieldCount > 0) {
      await this.upsertStructuredProfile(
        openId,
        batchId,
        extraction.structuredProfile,
      );
    }

    const memoryStats = await this.userProfileMemoryService.reconcileAndPersist(
      openId,
      batchId,
      messages,
      extraction.preferenceMemories,
    );

    console.log(
      `[FactProcessor] Finished batch ${batchId}: fixedFields=${fixedFieldCount}, ` +
        `preferenceCandidates=${memoryStats.candidates}, created=${memoryStats.created}, ` +
        `covered=${memoryStats.covered}, discarded=${memoryStats.discarded}`,
    );
  }

  private async upsertStructuredProfile(
    openId: string,
    batchId: string,
    fields: Record<string, string>,
  ): Promise<void> {
    const backendInternalUrl = this.configService.get<string>(
      'backend.internalUrl',
    )!;
    const backendInternalApiKey = this.configService.get<string>(
      'backend.internalApiKey',
    )!;

    await axios.post(
      `${backendInternalUrl}/internal/user-profiles/upsert`,
      {
        openId,
        batchId,
        fields,
      },
      {
        headers: {
          'x-api-key': backendInternalApiKey,
        },
      },
    );
  }
}
