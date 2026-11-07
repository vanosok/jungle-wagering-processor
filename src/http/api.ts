import {
  type ArgumentsHost,
  Body,
  type CanActivate,
  Catch,
  Controller,
  type ExceptionFilter,
  type ExecutionContext,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ProviderIdentityPort } from '../application/ports';
import type { WageringService } from '../application/wagering';
import { DomainError } from '../domain/errors';
import type { Database } from '../infrastructure/database/database';
import type { Queries } from '../infrastructure/database/queries';
import type { SqsBroker } from '../infrastructure/messaging/sqs';
import { errorCode, log, metrics, registry } from '../infrastructure/observability';

export const RUNTIME = Symbol('RUNTIME');
export interface Runtime {
  db: Database;
  service: WageringService;
  queries: Queries;
  broker: SqsBroker;
  identity: ProviderIdentityPort;
  isStopping: boolean;
}
export class NoopProviderIdentity implements ProviderIdentityPort {
  async assertProvider(_providerId: string, _authorization?: string): Promise<void> {}
}
@Injectable()
export class ProviderIdentityGuard implements CanActivate {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const providerId: unknown = request.body?.providerId ?? request.params.providerId;
    if (typeof providerId === 'string')
      await this.runtime.identity.assertProvider(providerId, request.headers.authorization);
    return true;
  }
}

function uuid(value: string): string {
  if (!z.uuid().safeParse(value).success) throw new DomainError('INVALID_INPUT', 'Invalid UUID');
  return value;
}
function correlation(value?: string): string {
  return value && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : crypto.randomUUID();
}

@Controller()
export class ApiController {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}
  @Get('health/live') live() {
    return { status: 'ok' };
  }
  @Get('health/ready') async ready(@Res({ passthrough: true }) response: Response) {
    const checks = await Promise.allSettled([
      this.runtime.db.em.fork().execute('select 1'),
      this.runtime.broker.ready(),
    ]);
    const ready = !this.runtime.isStopping && checks.every((c) => c.status === 'fulfilled');
    response.status(ready ? 200 : 503);
    return {
      status: ready ? 'ready' : 'not_ready',
      postgres: checks[0]?.status === 'fulfilled',
      sqs: checks[1]?.status === 'fulfilled',
    };
  }
  @Get('metrics') async prometheus(@Res() response: Response) {
    response.type(registry.contentType).send(await registry.metrics());
  }
  @Post('wallets')
  @UseGuards(ProviderIdentityGuard)
  async open(@Body() body: unknown, @Headers('x-correlation-id') header?: string) {
    return this.runtime.service.openWallet(body, { correlationId: correlation(header) });
  }
  @Get('wallets/:walletId')
  @UseGuards(ProviderIdentityGuard)
  wallet(@Param('walletId') walletId: string) {
    return this.runtime.queries.wallet(uuid(walletId));
  }
  @Get('wallets/:walletId/ledger')
  @UseGuards(ProviderIdentityGuard)
  ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .safeParse(rawLimit ?? '50');
    if (!limit.success || (cursor !== undefined && typeof cursor !== 'string'))
      throw new DomainError('INVALID_INPUT', 'Invalid pagination');
    return this.runtime.queries.ledger(uuid(walletId), cursor, limit.data);
  }
  @Get('wagering/transactions/:transactionId')
  @UseGuards(ProviderIdentityGuard)
  transaction(@Param('transactionId') transactionId: string) {
    return this.runtime.queries.transaction(uuid(transactionId));
  }
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @UseGuards(ProviderIdentityGuard)
  external(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalId: string,
  ) {
    return this.runtime.queries.externalTransaction(providerId, externalId);
  }
  @Post('wallets/:walletId/reconciliation')
  @UseGuards(ProviderIdentityGuard)
  async reconciliation(
    @Param('walletId') walletId: string,
    @Headers('x-correlation-id') header: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.status(200);
    return this.runtime.queries.reconcile(uuid(walletId), correlation(header));
  }
  @Post('wagering/transactions')
  @UseGuards(ProviderIdentityGuard)
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('x-correlation-id') header: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const correlationId = correlation(header);
    const end = metrics.latency.startTimer();
    try {
      const outcome = await this.runtime.service.submit(body, key ?? '', { correlationId });
      response.status(
        outcome.status === 'PENDING_REFERENCE' || outcome.status === 'PENDING'
          ? 202
          : outcome.status === 'REJECTED'
            ? 422
            : outcome.status === 'FAILED'
              ? 500
              : 200,
      );
      response.setHeader('X-Correlation-Id', correlationId);
      metrics.transactions.inc({ status: outcome.status });
      if (outcome.idempotentReplay) metrics.duplicates.inc({ source: 'http' });
      log('info', 'http_transaction_committed', {
        correlationId,
        transactionId: outcome.transactionId,
        walletId:
          typeof body === 'object' && body && 'walletId' in body
            ? String(body.walletId)
            : undefined,
        providerId:
          typeof body === 'object' && body && 'providerId' in body
            ? String(body.providerId)
            : undefined,
      });
      return outcome;
    } finally {
      end();
    }
  }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    const correlationId = correlation(request.get('x-correlation-id'));
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    if (error instanceof DomainError) {
      code = error.code;
      status =
        code === 'INVALID_INPUT'
          ? 400
          : code === 'NOT_FOUND'
            ? 404
            : [
                  'IDEMPOTENCY_CONFLICT',
                  'EXTERNAL_ID_CONFLICT',
                  'INBOX_CONFLICT',
                  'WALLET_EXISTS',
                ].includes(code)
              ? 409
              : 422;
    } else if (errorCode(error) === '23505') {
      status = 409;
      code = 'WALLET_EXISTS';
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      code = status === 400 ? 'INVALID_INPUT' : 'HTTP_ERROR';
    } else if (
      [
        'ECONNREFUSED',
        'ECONNRESET',
        'ETIMEDOUT',
        '57P01',
        '57P03',
        '53300',
        '08006',
        '55P03',
        '40001',
        '40P01',
        '57014',
        'KnexTimeoutError',
        'TimeoutError',
      ].includes(errorCode(error))
    ) {
      status = 503;
      code = 'INFRASTRUCTURE_UNAVAILABLE';
    }
    if (status === 503) response.setHeader('Retry-After', '1');
    log('error', 'http_request_failed', { correlationId, code });
    response.status(status).setHeader('X-Correlation-Id', correlationId);
    response.json({ statusCode: status, code, correlationId });
  }
}
