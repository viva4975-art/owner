import { describe, expect, it } from 'vitest';
import { contactGreeting, personGreeting, stripGreeting } from './greeting.js';

describe('Briefanrede', () => {
  it('Person mit Anrede', () => {
    expect(personGreeting({ salutation: 'Frau', first_name: 'Anna', last_name: 'Müller' })).toBe(
      'Sehr geehrte Frau Müller,',
    );
    expect(personGreeting({ salutation: 'Herr', last_name: 'Öz' })).toBe('Sehr geehrter Herr Öz,');
    expect(personGreeting({ salutation: 'divers', first_name: 'Kim', last_name: 'Lee' })).toBe(
      'Guten Tag Kim Lee,',
    );
    expect(personGreeting({})).toBe('Sehr geehrte Damen und Herren,');
  });
  it('freier Ansprechpartner-Text', () => {
    expect(contactGreeting('Frau Dr. Anna Müller')).toBe('Sehr geehrte Frau Dr. Müller,');
    expect(contactGreeting('z. Hd. Herrn Schmidt')).toBe('Sehr geehrter Herr Schmidt,');
    expect(contactGreeting('Buchhaltung')).toBe('Sehr geehrte Damen und Herren,');
    expect(contactGreeting(null)).toBe('Sehr geehrte Damen und Herren,');
    expect(
      contactGreeting('Anna Müller', [{ salutation: 'Frau', first_name: 'Anna', last_name: 'Müller' }]),
    ).toBe('Sehr geehrte Frau Müller,');
  });
  it('alte Anrede im Text entfernen', () => {
    expect(stripGreeting('Sehr geehrte Damen und Herren, wir berechnen')).toBe('wir berechnen');
    expect(stripGreeting('Sehr geehrte Frau Müller,\nanbei')).toBe('anbei');
  });
});
