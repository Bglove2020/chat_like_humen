import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import configuration from './config/configuration';
import { SummaryProcessor } from './processor/summary.processor';
import { DashscopeService } from './services/dashscope.service';
import { QdrantService } from './services/qdrant.service';

const appEnv = process.env.NODE_ENV || 'development';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: [`.env.${appEnv}`, '.env'],
    }),
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
    BullModule.registerQueue({
      name: 'chat-summary-queue',
    }),
  ],
  providers: [SummaryProcessor, DashscopeService, QdrantService],
})
export class AppModule {}
