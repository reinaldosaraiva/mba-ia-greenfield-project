import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

// The worker has no HTTP surface: a standalone application context gives it the
// DI container, the TypeORM connection and the BullMQ worker registration
// without opening a port.
async function bootstrap() {
  const context = await NestFactory.createApplicationContext(WorkerModule);
  context.enableShutdownHooks();
  Logger.log('Video worker is consuming the processing queue', 'Worker');
}

void bootstrap();
