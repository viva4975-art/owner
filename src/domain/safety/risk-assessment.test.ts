import { describe, expect, it } from 'vitest';
import { RISK_MODULES, selectModules } from './risk-assessment.js';

const base = { roomTypes: [], siteName: 'Bürogebäude', school: false, garage: false, offHours: false };
const keys = (x: ReturnType<typeof selectModules>) => x.map((m) => m.module.key);

describe('Gefährdungsbeurteilung: Bausteine je Leistungsart', () => {
  it('Grundbaustein immer, weitere nach Leistungsart', () => {
    expect(keys(selectModules({ ...base, services: ['Unterhaltsreinigung'] }))).toEqual(['allgemein']);
    const k = keys(
      selectModules({ ...base, services: ['Glasreinigung', '3. Kehrsaugen', 'Grundreinigung'] }),
    );
    expect(k).toEqual(expect.arrayContaining(['allgemein', 'glas', 'tiefgarage', 'grund']));
  });
  it('Raumbuch, Schule, Abendeinsatz', () => {
    const k = keys(
      selectModules({
        ...base,
        services: [],
        roomTypes: ['Sanitär / WC'],
        siteName: 'Grundschule Neubiberg',
        offHours: true,
      }),
    );
    expect(k).toEqual(expect.arrayContaining(['sanitaer', 'schule', 'alleinarbeit']));
    expect(k).not.toContain('grund');
  });
  it('„Grünpflege“ ist Außenanlage, keine Desinfektion/Einpflege', () => {
    const k = keys(selectModules({ ...base, services: ['Grünpflege'] }));
    expect(k).toContain('aussen');
    expect(k).not.toContain('desinfektion');
    expect(k).not.toContain('grund');
  });
  it('jede Gefährdung hat Maßnahmen', () => {
    for (const m of RISK_MODULES) for (const h of m.hazards) expect(h.measures.length).toBeGreaterThan(0);
  });
});
