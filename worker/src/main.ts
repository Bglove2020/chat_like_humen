import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  const configService = app.get(ConfigService);
  const queueName = configService.get<string>('worker.queueName') || 'chat-summary-queue';

  console.log(`[Worker] Summary worker started`);
  console.log(`[Worker] Queue: ${queueName}`);
  console.log(`[Worker] Waiting for jobs...`);

  // Keep the process running
  await app.enableShutdownHooks();
  await new Promise(() => {});
}

bootstrap();
