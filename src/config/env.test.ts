import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const valid = {
  APP_ENV: 'test',
  SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co',
  SUPABASE_PROJECT_REF: 'abcdefghijklmnop',
  SUPABASE_REGION: 'eu-central-1',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  MAIL_TEST_RECIPIENT: 'test@example.com',
};

describe('loadEnv', () => {
  it('akzeptiert eine gültige Test-Konfiguration', () => {
    expect(loadEnv(valid).APP_ENV).toBe('test');
  });

  it('lehnt das alte Live-Projekt ab (per Ref)', () => {
    expect(() => loadEnv({ ...valid, SUPABASE_PROJECT_REF: 'essogronliskkfhocxst' })).toThrow(
      /Live-System der alten App/,
    );
  });

  it('lehnt das alte Live-Projekt ab (per URL)', () => {
    expect(() => loadEnv({ ...valid, SUPABASE_URL: 'https://essogronliskkfhocxst.supabase.co' })).toThrow(
      /Live-System der alten App/,
    );
  });

  it('verlangt Region Frankfurt', () => {
    expect(() => loadEnv({ ...valid, SUPABASE_REGION: 'eu-west-1' })).toThrow(/Frankfurt/);
  });

  it('verlangt im Test-Betrieb eine Testadresse für Mails', () => {
    const { MAIL_TEST_RECIPIENT: _omit, ...rest } = valid;
    expect(() => loadEnv(rest)).toThrow(/Testadresse/);
  });
});
