import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../domain/errors';
import { Money } from '../domain/money';
import { assertTransactionInput, publicKinds } from '../domain/transaction';

const identifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
export const moneySchema = z.strictObject({
  amount: z.string().max(21),
  currency: z.string().length(3),
});
export const walletSchema = z.strictObject({ playerId: z.uuid(), initialBalance: moneySchema });
export const transactionSchema = z.strictObject({
  providerId: identifier.refine((v) => !v.startsWith('internal:'), 'Reserved provider namespace'),
  externalTransactionId: identifier,
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: identifier,
  gameId: identifier,
  kind: z.enum(publicKinds),
  money: moneySchema,
  referenceExternalTransactionId: identifier.optional(),
});
export const keySchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[\x21-\x7E]+$/)
  .refine((v) => !v.startsWith('internal:'), 'Reserved idempotency namespace');
export type TransactionInput = z.infer<typeof transactionSchema>;
export const messageSchema = z.strictObject({
  messageId: identifier,
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(),
  data: transactionSchema.extend({ idempotencyKey: keySchema }),
});

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
    .join(',')}}`;
}
export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export function parseTransaction(value: unknown): TransactionInput {
  const parsed = transactionSchema.safeParse(value);
  if (!parsed.success) throw new DomainError('INVALID_INPUT', 'Invalid transaction contract');
  assertTransactionInput({
    kind: parsed.data.kind,
    money: Money.from(parsed.data.money),
    referenceExternalTransactionId: parsed.data.referenceExternalTransactionId,
  });
  return parsed.data;
}
