import { z } from 'zod';

/** Das laufende Projekt der alten App (Irland). Darf von der neuen App nie angesprochen werden. */
export const FORBIDDEN_SUPABASE_PROJECT_REFS = ['essogronliskkfhocxst'] as const;
export const REQUIRED_SUPABASE_REGION = 'eu-central-1';

const schema = z
  .object({
    APP_ENV: z.enum(['test', 'live']),
    SUPABASE_URL: z.url(),
    SUPABASE_PROJECT_REF: z.string().min(1),
    SUPABASE_REGION: z.literal(REQUIRED_SUPABASE_REGION, {
      error: `Supabase muss in ${REQUIRED_SUPABASE_REGION} (Frankfurt) liegen`,
    }),
    SUPABASE_ANON_KEY: z.string().min(1),
    /** Nur serverseitig. Darf nie ins Frontend-Bundle. */
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    /** Im Test-Betrieb gehen ALLE Mails nur an diese Adresse. */
    MAIL_TEST_RECIPIENT: z.email().optional(),
    KOSIT_VALIDATOR_URL: z.url().default('http://localhost:8081'),
  })
  .superRefine((env, ctx) => {
    const ref = env.SUPABASE_PROJECT_REF.toLowerCase();
    const urlHost = (() => {
      try {
        return new URL(env.SUPABASE_URL).hostname.toLowerCase();
      } catch {
        return '';
      }
    })();
    for (const forbidden of FORBIDDEN_SUPABASE_PROJECT_REFS) {
      if (ref === forbidden || urlHost.includes(forbidden)) {
        ctx.addIssue({
          code: 'custom',
          path: ['SUPABASE_PROJECT_REF'],
          message: `Projekt ${forbidden} ist das Live-System der alten App und darf nicht verwendet werden`,
        });
      }
    }
    if (env.APP_ENV === 'test' && !env.MAIL_TEST_RECIPIENT) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_TEST_RECIPIENT'],
        message: 'Im Test-Betrieb ist eine Testadresse für den Mailversand Pflicht',
      });
    }
  });

export type Env = z.infer<typeof schema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Konfiguration ungültig:\n${lines.join('\n')}`);
  }
  return result.data;
}
