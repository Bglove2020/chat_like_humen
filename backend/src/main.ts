import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable CORS
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type,Authorization',
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  const configService = app.get(ConfigService);
  const host = configService.get<string>('host') || '0.0.0.0';
  const port = configService.get<number>('port') || 7001;

  await app.listen(port, host);
  console.log(`Chat Like Human Backend started on http://${host}:${port}`);
  console.log('Endpoints:');
  console.log('  GET  /api/health');
  console.log('  POST /api/register');
  console.log('  POST /api/login');
  console.log('  POST /api/chat (requires auth)');
  console.log('  POST /api/chat-context');
  console.log('  POST /api/retrieve');
}

bootstrap();
