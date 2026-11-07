import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { from, lastValueFrom } from 'rxjs';
import { traceContext, traced } from '../infrastructure/telemetry';

@Injectable()
export class TracingInterceptor implements NestInterceptor {
  intercept(execution: ExecutionContext, next: CallHandler) {
    const req = execution.switchToHttp().getRequest<Request>();
    const route: string = req.route?.path ?? 'unknown';
    const carrier = {
      ...(typeof req.headers.traceparent === 'string'
        ? { traceparent: req.headers.traceparent }
        : {}),
      ...(typeof req.headers.tracestate === 'string' ? { tracestate: req.headers.tracestate } : {}),
    };
    return from(
      traced(
        `HTTP ${req.method} ${route}`,
        () => lastValueFrom(next.handle()),
        { 'http.request.method': req.method, 'http.route': route },
        traceContext(carrier),
      ),
    );
  }
}
