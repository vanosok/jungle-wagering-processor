# Jungle Wagering Processor

Implementation of the [Jungle Gaming backend challenge](https://github.com/junglegaming/backend-challenge).

Financial correctness, durable idempotency and crash recovery are the priorities.

Stack: Bun 1.x, strict TypeScript, NestJS, MikroORM, PostgreSQL and SQS (LocalStack).

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
```

Setup, architecture and operational examples will be documented alongside the implementation.
