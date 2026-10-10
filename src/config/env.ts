import { z } from 'zod';

/** Das laufende Projekt der alten App (Irland). Darf von der neuen App nie angesprochen werden. */
export const FORBIDDEN_SUPABASE_PROJECT_REFS = ['essogronliskkfhocxst'] as const;
export const REQUIRED_SUPABASE_REGION = 'eu-central-1';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z
  .object({
    /** dev = lokal (eigene Postgres-DB), test = Supabase-Testprojekt, live = Produktion */
    APP_ENV: z.enum(['dev', 'test', 'live']),
    PORT: z.coerce.number().int().positive().default(3000),
    /** Direkte Postgres-Verbindung des Servers (Supabase: Session-Pooler, Port 5432). */
    DATABASE_URL: z.string().min(1),
    /** supabase = Datenbank bei Supabase (Frankfurt); eigen = Postgres auf dem eigenen Server (z. B. IONOS, Docker). */
    DB_HOSTING: z.enum(['supabase', 'eigen']).default('supabase'),
    SUPABASE_URL: z.url().optional(),
    SUPABASE_PROJECT_REF: z.string().min(1).optional(),
    SUPABASE_REGION: z.string().optional(),
    SUPABASE_ANON_KEY: z.string().min(1).optional(),
    /** Nur serverseitig. Darf nie ins Frontend-Bundle. */
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
    /** Archiv-Ablage: lokales Verzeichnis (dev/test) – später Supabase Storage / S3 mit Object Lock. */
    ARCHIVE_DIR: z.string().default('./var/archive'),
    /** Ablage für hochgeladene Dateien (Ausschreibungs-ZIPs, Anlagen). Live: Supabase Storage. */
    FILES_DIR: z.string().default('./var/files'),
    /** Maximale Dateigröße für Uploads in Bytes (Standard 5 GiB). */
    UPLOAD_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(5 * 1024 ** 3),
    /** Im Test-/Dev-Betrieb gehen ALLE Mails nur an diese Adresse. */
    MAIL_TEST_RECIPIENT: z.email().optional(),
    MAIL_FROM: z.string().default('Viva-Deluxe Rechnungen <rechnung@viva-deluxe-reinigung.de>'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_SECURE: bool,
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    KOSIT_VALIDATOR_URL: z.url().default('http://127.0.0.1:8081'),
    /** Ordner der täglichen Sicherung (im Container schreibgeschützt eingebunden) – Systemwächter prüft ihr Alter. */
    BACKUP_DIR: z.string().optional(),
    /** Revisionssichere Archiv-Kopie: S3-kompatibler Speicher mit Object Lock (z. B. IONOS). Alle fünf oder keiner. */
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().min(1).optional(),
    S3_BUCKET: z.string().min(3).optional(),
    S3_ACCESS_KEY: z.string().min(1).optional(),
    S3_SECRET_KEY: z.string().min(1).optional(),
    /** Empfänger der Störungsmeldungen (sonst Erinnerungs-Empfänger bzw. Firmen-E-Mail). */
    ALERT_EMAIL: z.email().optional(),
    /** Zugang zur Oberfläche im Prototyp (Benutzer:Passwort). Später Supabase Auth. */
    /** Geheimnis zum Signieren der Mitarbeiter-Sitzungen (Handy-Ansicht). Außerhalb von dev Pflicht. */
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET: mindestens 32 Zeichen').optional(),
    /** Öffentliche Adresse der App (für QR-Codes an den Objekten), z. B. https://app.viva-deluxe-reinigung.de */
    PUBLIC_URL: z.url().optional(),
    APP_BASIC_AUTH: z.string().regex(/^[^:]+:.{8,}$/, 'Format benutzer:passwort (mind. 8 Zeichen)'),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });

    const s3 = [env.S3_ENDPOINT, env.S3_REGION, env.S3_BUCKET, env.S3_ACCESS_KEY, env.S3_SECRET_KEY];
    if (s3.some(Boolean) && !s3.every(Boolean))
      issue('S3_ENDPOINT', 'Archiv-Kopie: S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY und S3_SECRET_KEY gemeinsam angeben');
    if (env.S3_ENDPOINT && env.APP_ENV !== 'dev' && !env.S3_ENDPOINT.startsWith('https://'))
      issue('S3_ENDPOINT', 'Archiv-Kopie: S3_ENDPOINT muss mit https:// beginnen');

    const haystacks = [env.SUPABASE_PROJECT_REF, env.SUPABASE_URL, env.DATABASE_URL]
      .filter((v): v is string => !!v)
      .map((v) => v.toLowerCase());
    for (const forbidden of FORBIDDEN_SUPABASE_PROJECT_REFS) {
      if (haystacks.some((h) => h.includes(forbidden))) {
        issue(
          'SUPABASE_PROJECT_REF',
          `Projekt ${forbidden} ist das Live-System der alten App und darf nicht verwendet werden`,
        );
      }
    }

    if (env.APP_ENV === 'dev' || env.DB_HOSTING === 'eigen') {
      if (!/@(localhost|127\.0\.0\.1|\[::1\]|db|postgres)(:\d+)?\//.test(env.DATABASE_URL)) {
        issue(
          'DATABASE_URL',
          env.APP_ENV === 'dev'
            ? 'Im dev-Betrieb nur lokale Datenbank erlaubt'
            : 'Mit DB_HOSTING=eigen nur die Datenbank auf diesem Server (db/localhost) erlaubt',
        );
      }
    } else {
      for (const key of [
        'SUPABASE_URL',
        'SUPABASE_PROJECT_REF',
        'SUPABASE_ANON_KEY',
        'SUPABASE_SERVICE_ROLE_KEY',
      ] as const) {
        if (!env[key]) issue(key, `${key} ist im ${env.APP_ENV}-Betrieb Pflicht`);
      }
      if (env.SUPABASE_REGION !== REQUIRED_SUPABASE_REGION) {
        issue('SUPABASE_REGION', `Supabase muss in ${REQUIRED_SUPABASE_REGION} (Frankfurt) liegen`);
      }
      const ref = env.SUPABASE_PROJECT_REF?.toLowerCase();
      const db = env.DATABASE_URL.toLowerCase();
      if (ref && !db.includes(ref)) {
        issue('DATABASE_URL', 'DATABASE_URL gehört nicht zum Projekt SUPABASE_PROJECT_REF');
      }
      if (ref && env.SUPABASE_URL && !env.SUPABASE_URL.toLowerCase().includes(ref)) {
        issue('SUPABASE_URL', 'SUPABASE_URL gehört nicht zum Projekt SUPABASE_PROJECT_REF');
      }
      // Pooler-Adressen nennen die Region (aws-0-eu-central-1.pooler.supabase.com) → muss Frankfurt sein
      const pooler = /@aws-\d+-([a-z0-9-]+)\.pooler\.supabase\.com/.exec(db);
      if (pooler && pooler[1] !== REQUIRED_SUPABASE_REGION) {
        issue(
          'DATABASE_URL',
          `Datenbank liegt in ${pooler[1]}, nicht in Frankfurt (${REQUIRED_SUPABASE_REGION})`,
        );
      }
    }

    if (env.APP_ENV !== 'dev' && !env.SESSION_SECRET) {
      issue('SESSION_SECRET', `SESSION_SECRET ist im ${env.APP_ENV}-Betrieb Pflicht`);
    }

    if (env.APP_ENV !== 'live' && !env.MAIL_TEST_RECIPIENT) {
      issue(
        'MAIL_TEST_RECIPIENT',
        'Außerhalb des Live-Betriebs ist eine Testadresse für den Mailversand Pflicht',
      );
    }
  });

export type Env = z.infer<typeof schema>;

/** Datenbank liegt auf dem eigenen Server/Rechner (reines Postgres mit Supabase-Shim) statt bei Supabase. */
export function isSelfHostedDb(env: Pick<Env, 'APP_ENV' | 'DB_HOSTING'>): boolean {
  return env.APP_ENV === 'dev' || env.DB_HOSTING === 'eigen';
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Konfiguration ungültig:\n${lines.join('\n')}`);
  }
  return result.data;
}

/** Testbetrieb = alle Mails nur an die Testadresse. */
export function isMailRedirected(env: Env): boolean {
  return env.APP_ENV !== 'live' || !!env.MAIL_TEST_RECIPIENT;
}
