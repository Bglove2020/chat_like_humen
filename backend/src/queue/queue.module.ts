import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QueueService } from './queue.service';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('redis.host'),
          port: configService.get<number>('redis.port'),
          password: configService.get<string>('redis.password'),
        },
        prefix: 'bull',
      }),
    }),
    BullModule.registerQueue(
      {
        name: 'chat-summary-queue',
      },
      {
        name: 'chat-fact-queue',
      },
    ),
  ],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
