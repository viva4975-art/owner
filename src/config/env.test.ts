import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const test = {
  APP_ENV: 'test',
  DATABASE_URL:
    'postgres://postgres.abcdefghijklmnop:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres',
  SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co',
  SUPABASE_PROJECT_REF: 'abcdefghijklmnop',
  SUPABASE_REGION: 'eu-central-1',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  MAIL_TEST_RECIPIENT: 'test@example.com',
  APP_BASIC_AUTH: 'ahmed:geheim1234',
};

const dev = {
  APP_ENV: 'dev',
  DATABASE_URL: 'postgres://postgres@127.0.0.1:54322/viva_dev',
  MAIL_TEST_RECIPIENT: 'test@example.com',
  APP_BASIC_AUTH: 'ahmed:geheim1234',
};

describe('loadEnv', () => {
  it('akzeptiert eine gültige Test-Konfiguration', () => {
    expect(loadEnv(test).APP_ENV).toBe('test');
  });

  it('akzeptiert lokale dev-Konfiguration ohne Supabase', () => {
    expect(loadEnv(dev).APP_ENV).toBe('dev');
  });

  it('dev-Betrieb nur mit lokaler Datenbank', () => {
    expect(() => loadEnv({ ...dev, DATABASE_URL: test.DATABASE_URL })).toThrow(/lokale Datenbank/);
  });

  it('lehnt das alte Live-Projekt ab (per Ref)', () => {
    expect(() => loadEnv({ ...test, SUPABASE_PROJECT_REF: 'essogronliskkfhocxst' })).toThrow(
      /Live-System der alten App/,
    );
  });

  it('lehnt das alte Live-Projekt ab (per URL)', () => {
    expect(() => loadEnv({ ...test, SUPABASE_URL: 'https://essogronliskkfhocxst.supabase.co' })).toThrow(
      /Live-System der alten App/,
    );
  });

  it('lehnt das alte Live-Projekt ab (per DATABASE_URL)', () => {
    expect(() =>
      loadEnv({
        ...test,
        DATABASE_URL:
          'postgres://postgres.essogronliskkfhocxst:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres',
      }),
    ).toThrow(/Live-System der alten App/);
  });

  it('verlangt Region Frankfurt', () => {
    expect(() => loadEnv({ ...test, SUPABASE_REGION: 'eu-west-1' })).toThrow(/Frankfurt/);
  });

  it('verlangt außerhalb von live eine Testadresse für Mails', () => {
    const { MAIL_TEST_RECIPIENT: _omit, ...rest } = test;
    expect(() => loadEnv(rest)).toThrow(/Testadresse/);
  });

  it('verlangt ein ausreichend langes Passwort', () => {
    expect(() => loadEnv({ ...dev, APP_BASIC_AUTH: 'ahmed:kurz' })).toThrow(/mind. 8/);
  });
});
