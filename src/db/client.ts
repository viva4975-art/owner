import postgres from 'postgres';

// Eigene Typen (bigint, date) – die Generics von postgres.js sind dafür zu eng, daher `any`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Sql = postgres.Sql<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Tx = postgres.TransactionSql<any>;

/**
 * Datenbankverbindung mit festen Zeitlimits. Die alte App hatte ständig hängende
 * Verbindungen – deshalb: Verbindungsaufbau max. 10 s, jede Abfrage max. 30 s.
 */
export function createSql(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 10,
    connect_timeout: 10,
    idle_timeout: 30,
    max_lifetime: 60 * 30,
    prepare: false, // kompatibel mit Supabase-Pooler (Transaction Mode)
    connection: { statement_timeout: 30_000, application_name: 'viva-deluxe-app' },
    types: {
      // bigint (int8) als JS-bigint statt string – Cent-Beträge bleiben exakt.
      bigint: postgres.BigInt,
      // date als 'YYYY-MM-DD'-String – keine Zeitzonen-Verschiebung durch JS-Date.
      date: {
        to: 1082,
        from: [1082],
        serialize: (x: string) => x,
        parse: (x: string) => x,
      } as postgres.PostgresType<string>,
    },
    onnotice: () => {},
  });
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '57P01', // admin_shutdown
  '08006', // connection_failure
  '08003',
]);

export function isTransient(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return typeof code === 'string' && TRANSIENT_CODES.has(code);
}

/**
 * Wiederholt eine Operation bei Verbindungsfehlern (exponentiell, max. 4 Versuche).
 * NUR für idempotente Operationen verwenden (feste IDs, Upsert, oder ganze Transaktionen).
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4, baseDelayMs = 250): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
    }
  }
  throw lastErr;
}
