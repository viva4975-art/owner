import { afterEach, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { configureAuthAdmin, ensureAuthUser } from './auth-users.js';

const ID = '5f0c1a2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';
const noSql = (() => {
  throw new Error('darf in Supabase nicht direkt in auth.users schreiben');
}) as unknown as Sql;

describe('Supabase-Konten über die Admin-API', () => {
  afterEach(() => configureAuthAdmin(null));

  it('legt fehlendes Konto mit fester ID an (Service-Key nur im Header)', async () => {
    const calls: { url: string; method: string; body: string | undefined; auth: string | undefined }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: init.body as string,
        auth: (init.headers as Record<string, string>).Authorization,
      });
      if ((init.method ?? 'GET') === 'GET') return new Response('{}', { status: 404 });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    configureAuthAdmin({ url: 'https://abc.supabase.co/', serviceKey: 'srv', fetch: fake });
    await ensureAuthUser(noSql, ID, null);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET https://abc.supabase.co/auth/v1/admin/users/${ID}`,
      'POST https://abc.supabase.co/auth/v1/admin/users',
    ]);
    const body = JSON.parse(calls[1]!.body!);
    expect(body).toMatchObject({ id: ID, email_confirm: true });
    expect(body.email).toBe(`konto-${ID}@konten.viva-deluxe-reinigung.de`);
    expect(calls[1]!.auth).toBe('Bearer srv');
  });

  it('vorhandenes Konto → nichts anlegen; Fehler wird gemeldet', async () => {
    let posts = 0;
    configureAuthAdmin({
      url: 'https://abc.supabase.co',
      serviceKey: 'srv',
      fetch: (async (_u: string, init: RequestInit) => {
        if (init.method === 'POST') posts++;
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    await ensureAuthUser(noSql, ID, 'a@b.de');
    expect(posts).toBe(0);
    configureAuthAdmin({
      url: 'https://abc.supabase.co',
      serviceKey: 'srv',
      fetch: (async () => new Response('kaputt', { status: 500 })) as unknown as typeof fetch,
    });
    await expect(ensureAuthUser(noSql, ID, 'a@b.de')).rejects.toThrow(/HTTP 500/);
  });
});
