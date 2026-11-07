import {
  type Attributes,
  type Context,
  context,
  propagation,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { errorCode } from './observability';

let provider: NodeTracerProvider | undefined;
export function startTelemetry(exporter?: SpanExporter): void {
  if (provider || (!exporter && !process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)) return;
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': 'jungle-wagering',
      'service.instance.id': `${process.pid}-${crypto.randomUUID()}`,
      'service.version': '0.1.0',
    }),
    spanProcessors: [
      new BatchSpanProcessor(
        exporter ??
          new OTLPTraceExporter({
            url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
            timeoutMillis: 2000,
          }),
        { scheduledDelayMillis: 1000, exportTimeoutMillis: 3000 },
      ),
    ],
  });
  provider.register();
}
export async function stopTelemetry(): Promise<void> {
  await provider?.shutdown();
}
export async function flushTelemetry(): Promise<void> {
  await provider?.forceFlush();
}
export function traceCarrier(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}
export function traceFailure(error: unknown): void {
  const span = trace.getActiveSpan();
  span?.setStatus({ code: SpanStatusCode.ERROR });
  span?.addEvent('failure', { code: errorCode(error) });
}
export function traceContext(carrier: Record<string, string>): Context {
  return propagation.extract(context.active(), carrier);
}
export async function traced<T>(
  name: string,
  work: () => Promise<T>,
  attributes: Attributes = {},
  parent?: Context,
): Promise<T> {
  return trace
    .getTracer('jungle-wagering')
    .startActiveSpan(name, { attributes }, parent ?? context.active(), async (span) => {
      try {
        const value = await work();
        span.setStatus({ code: SpanStatusCode.OK });
        return value;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.addEvent('failure', { code: errorCode(error) });
        throw error;
      } finally {
        span.end();
      }
    });
}
