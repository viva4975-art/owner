import { describe, expect, it } from 'vitest';
import { areaOf, canAccess, setPermissionOverrides, stripForbiddenLinks } from './permissions.js';

describe('Objektleitung: Links auf gesperrte Seiten', () => {
  it('macht Text aus Links, entfernt Knöpfe, lässt erlaubte stehen', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const html =
      `<a href="/personal/${id}/abwesenheiten">Anna</a> ` +
      `<a class="btn sec" href="/neu?typ=objekt&amp;kunde=${id}">+ Objekt</a> ` +
      `<a href="/objekte/${id}">Schule</a> <a href="https://example.org">extern</a>`;
    const out = stripForbiddenLinks(html, 'objektleitung');
    expect(out).toContain('<span>Anna</span>');
    expect(out).not.toContain('+ Objekt');
    expect(out).toContain(`<a href="/objekte/${id}">Schule</a>`);
    expect(out).toContain('https://example.org');
  });
  it('Stellen und Plakat lesbar, Bewerber nicht', () => {
    expect(canAccess('objektleitung', '/stellen')).toBe(true);
    expect(canAccess('objektleitung', '/bewerber/stellen/11111111-2222-3333-4444-555555555555/plakat')).toBe(
      true,
    );
    expect(canAccess('objektleitung', '/bewerber')).toBe(false);
  });
});

describe('Rechte der Benutzergruppen (Einstellungen)', () => {
  it('Abweichung gilt für den Bereich, Admin-Seiten bleiben gesperrt', () => {
    expect(canAccess('personal', '/rechnungen')).toBe(false);
    expect(areaOf('/rechnungen/123')!.key).toBe('rechnungen');
    expect(areaOf('/personal/unterlagen.csv')!.key).toBe('unterlagen');
    setPermissionOverrides([
      { role: 'personal', area: 'rechnungen', allowed: true },
      { role: 'buchhaltung', area: 'kassenbuch', allowed: false },
      { role: 'personal', area: 'einstellungen', allowed: true },
    ]);
    try {
      expect(canAccess('personal', '/rechnungen/entwuerfe')).toBe(true);
      expect(canAccess('buchhaltung', '/kassenbuch')).toBe(false);
      expect(canAccess('admin', '/kassenbuch')).toBe(true);
      expect(canAccess('personal', '/einstellungen/firma')).toBe(false);
      expect(canAccess('personal', '/einstellungen/rechte')).toBe(false);
      expect(canAccess('buchhaltung', '/rechnungen')).toBe(true);
    } finally {
      setPermissionOverrides([]);
    }
  });
});
