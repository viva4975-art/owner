import { describe, expect, it } from 'vitest';
import { canAccess, stripForbiddenLinks } from './permissions.js';

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
