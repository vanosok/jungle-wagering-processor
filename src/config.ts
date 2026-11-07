import { z } from 'zod';

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const schema = z.object({
  DATABASE_URL: z.string().url().default('postgresql://wager:wager@localhost:5432/wagering'),
  AWS_ENDPOINT_URL: z.string().url().default('http://localhost:4566'),
  AWS_REGION: z.string().default('us-east-1'),
  PORT: positiveInt(3000),
  WORKERS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  REFERENCE_MAX_ATTEMPTS: positiveInt(10),
  REFERENCE_BASE_DELAY_MS: positiveInt(1000),
  REFERENCE_MAX_DELAY_MS: positiveInt(60000),
  SQS_VISIBILITY_SECONDS: positiveInt(30),
  SQS_MAX_RECEIVES: positiveInt(5),
  LOG_LEVEL: z.enum(['info', 'error', 'silent']).default('info'),
});

export const config = schema.parse(process.env);
