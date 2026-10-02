import { describe, expect, it } from 'vitest';
import { resolveRecipients } from './mailer.js';

describe('resolveRecipients', () => {
  const intended = ['a@behoerde.de', 'b@behoerde.de'];

  it('leitet im Testbetrieb immer auf die Testadresse um', () => {
    expect(resolveRecipients({ APP_ENV: 'test', MAIL_TEST_RECIPIENT: 't@x.de' }, intended)).toEqual({
      actual: ['t@x.de'],
      redirected: true,
    });
    expect(resolveRecipients({ APP_ENV: 'dev', MAIL_TEST_RECIPIENT: 't@x.de' }, intended).actual).toEqual([
      't@x.de',
    ]);
  });

  it('sperrt den Versand ohne Testadresse außerhalb von live', () => {
    expect(() => resolveRecipients({ APP_ENV: 'test', MAIL_TEST_RECIPIENT: undefined }, intended)).toThrow(
      /gesperrt/,
    );
  });

  it('versendet live an die echten Empfänger', () => {
    expect(resolveRecipients({ APP_ENV: 'live', MAIL_TEST_RECIPIENT: undefined }, intended)).toEqual({
      actual: intended,
      redirected: false,
    });
  });
});
