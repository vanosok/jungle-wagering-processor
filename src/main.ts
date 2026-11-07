import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WageringService } from './application/wagering';
import { config } from './config';
import {
  ApiController,
  ApiExceptionFilter,
  NoopProviderIdentity,
  ProviderIdentityGuard,
  RUNTIME,
  type Runtime,
} from './http/api';
import { TracingInterceptor } from './http/tracing';
import { connectDatabase } from './infrastructure/database/database';
import { Queries } from './infrastructure/database/queries';
import { PostgresFinancialStore } from './infrastructure/database/store';
import { SqsBroker } from './infrastructure/messaging/sqs';
import { errorCode, log } from './infrastructure/observability';
import { startTelemetry, stopTelemetry } from './infrastructure/telemetry';
import { Workers } from './infrastructure/workers';

export async function bootstrap(port = config.PORT, enableWorkers = config.WORKERS_ENABLED) {
  startTelemetry();
  const db = await connectDatabase();
  const broker = new SqsBroker();
  const service = new WageringService(new PostgresFinancialStore(db));
  const runtime: Runtime = {
    db,
    broker,
    service,
    queries: new Queries(db),
    identity: new NoopProviderIdentity(),
    isStopping: false,
  };
  @Module({
    controllers: [ApiController],
    providers: [ProviderIdentityGuard, { provide: RUNTIME, useValue: runtime }],
  })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new TracingInterceptor());
  await app.listen(port, '0.0.0.0');
  const workers = new Workers(db, broker, service);
  if (enableWorkers) workers.start();
  const address = app.getHttpServer().address();
  log('info', 'application_started');
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    runtime.isStopping = true;
    await workers.stop();
    await app.close();
    broker.close();
    await db.close(true);
    await stopTelemetry();
  };
  return {
    app,
    runtime,
    workers,
    port: typeof address === 'object' && address ? (address.port as number) : port,
    close,
  };
}

if (import.meta.main) {
  try {
    const instance = await bootstrap();
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        void instance.close().then(() => process.exit(0));
      });
    }
  } catch (error) {
    log('error', 'startup_failed', { code: errorCode(error) });
    process.exit(1);
  }
}
