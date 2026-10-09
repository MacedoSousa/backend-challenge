import { hostname } from 'node:os';
import { z } from 'zod';

export const APP_ROLES = ['api', 'consumer', 'outbox', 'scheduler', 'notifier'] as const;
export type AppRole = (typeof APP_ROLES)[number];

const roles = z
  .string()
  .default('all')
  .transform((value, ctx): AppRole[] => {
    const parts = value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.includes('all')) return [...APP_ROLES];
    const invalid = parts.filter((part) => !APP_ROLES.includes(part as AppRole));
    if (invalid.length > 0) {
      ctx.addIssue({ code: 'custom', message: `papéis inválidos: ${invalid.join(', ')}` });
      return z.NEVER;
    }
    return parts as AppRole[];
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // 0 = porta efêmera (usado nos testes)
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  APP_ROLE: roles,
  INSTANCE_ID: z.string().min(1).default(hostname()),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_READ_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),

  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ENDPOINT_URL: z.url().optional(),
  AWS_ACCESS_KEY_ID: z.string().min(1).default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).default('test'),
  SQS_WAGER_QUEUE: z.string().min(1).default('wager-transactions.fifo'),
  SQS_WAGER_DLQ: z.string().min(1).default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().min(1).default('wagering-events.fifo'),
  SQS_MAX_RECEIVE_COUNT: z.coerce.number().int().min(1).max(1000).default(5),

  /** Timeouts aplicados com SET LOCAL em cada transação (falha rápida → 503 / retry). */
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),

  /** Pontos de falha injetada (só respeitados com NODE_ENV=test). Ex.: "wager.before-commit". */
  FAULT_POINTS: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

export class InvalidEnvironmentError extends Error {
  constructor(readonly issues: string[]) {
    super(`configuração de ambiente inválida:\n  - ${issues.join('\n  - ')}`);
    this.name = 'InvalidEnvironmentError';
  }
}

/** Valida as variáveis de ambiente e falha rápido no boot. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new InvalidEnvironmentError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`),
    );
  }
  return result.data;
}
