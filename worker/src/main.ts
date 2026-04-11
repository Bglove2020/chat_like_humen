import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  const configService = app.get(ConfigService);
  const queueName = configService.get<string>('worker.queueName') || 'chat-summary-queue';
  const mem0Enabled = configService.get<boolean>('mem0.enabled') === true;

  console.log(`[Worker] Summary worker started`);
  console.log(`[Worker] Queue: ${queueName}`);
  console.log(`[Worker] Mem0 sidecar queue: chat-mem0-queue (${mem0Enabled ? 'enabled' : 'disabled'})`);
  console.log(`[Worker] Waiting for jobs...`);

  // Keep the process running
  await app.enableShutdownHooks();
  await new Promise(() => {});
}

bootstrap();
