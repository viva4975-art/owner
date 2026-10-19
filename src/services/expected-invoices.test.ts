import { describe, expect, it } from 'vitest';
import { subcontractTodo } from './expected-invoices.js';

describe('NU-Bestellung „zu erledigen“', () => {
  it('nur erteilte ohne unterschriebenen Auftrag (Rechnungen stehen im Rechnungseingang)', () => {
    expect(subcontractTodo({ status: 'erteilt', signed: false })).toEqual(['Unterschrift fehlt']);
    expect(subcontractTodo({ status: 'erteilt', signed: true })).toEqual([]);
    expect(subcontractTodo({ status: 'beendet', signed: false })).toEqual([]);
  });
});
