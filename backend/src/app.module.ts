import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import configuration from './config/configuration';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ChatModule } from './chat/chat.module';
import { ImpressionsModule } from './impressions/impressions.module';
import { QueueModule } from './queue/queue.module';
import { MemoryCompareModule } from './memory-compare/memory-compare.module';
import { User } from './users/user.entity';
import { ChatMessage } from './chat/chat_message.entity';
import { HealthController } from './health.controller';
import { ImpressionEdge } from './impressions/impression-edge.entity';
import { ImpressionMessageLink } from './impressions/impression-message-link.entity';
import { ChatSession } from './chat/chat_session.entity';
import { UserProfile } from './users/user-profile.entity';
import { MemoryModule } from './memory/memory.module';
import { MemoryLine } from './memory/memory-line.entity';
import { MemoryPoint } from './memory/memory-point.entity';
import { PointRevisionLog } from './memory/point-revision-log.entity';
import { PointMessageLink } from './memory/point-message-link.entity';

const appEnv = process.env.NODE_ENV || 'development';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: [`.env.${appEnv}`, '.env'],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'mysql',
        host: configService.get<string>('database.host'),
        port: configService.get<number>('database.port'),
        username: configService.get<string>('database.username'),
        password: configService.get<string>('database.password'),
        database: configService.get<string>('database.database'),
        entities: [
          User,
          UserProfile,
          ChatMessage,
          ChatSession,
          ImpressionEdge,
          ImpressionMessageLink,
          MemoryLine,
          MemoryPoint,
          PointRevisionLog,
          PointMessageLink,
        ],
        synchronize: true,
        logging: false,
      }),
    }),
    AuthModule,
    UsersModule,
    ChatModule,
    MemoryModule,
    ImpressionsModule,
    QueueModule,
    MemoryCompareModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
