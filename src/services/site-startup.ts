import type { Sql } from '../db/client.js';
import { addDays } from '../domain/time/holidays.js';
import { BusinessError } from './errors.js';

/*
 * Anlaufplan für eine Objektübernahme: feste Schritte als Aufgaben am Objekt, Fälligkeit relativ zum Vertragsbeginn,
 * zugewiesen an die Objektleitung. Feste IDs je Objekt + Schritt → erneut erstellen legt nichts doppelt an
 * (geänderter Beginn verschiebt nur offene Schritte).
 */
export const STARTUP_STEPS: { key: string; days: number; title: string; hint: string }[] = [
  {
    key: 'begehung',
    days: -21,
    title: 'Objektbegehung mit dem Kunden',
    hint: 'Leistungsverzeichnis, Reinigungszeiten, Zugang, Ansprechpartner, Besonderheiten klären.',
  },
  {
    key: 'raumbuch',
    days: -21,
    title: 'Raumbuch anlegen',
    hint: 'Räume, Flächen, Bodenbeläge, Intervalle (Objekt → Raumbuch, Excel-Import möglich).',
  },
  {
    key: 'leistungen',
    days: -14,
    title: 'Leistungen & Preise anlegen',
    hint: 'Monatspauschale, Sonderleistungen, Regiestundensatz, Lohnkostenanteil, Rechnungsgruppe.',
  },
  {
    key: 'personal',
    days: -14,
    title: 'Personal planen',
    hint: 'Einsätze anlegen, Vertretung klären. Übernahme von Personal des Vorgängers: § 613a BGB (Betriebsübergang) prüfen.',
  },
  {
    key: 'material',
    days: -14,
    title: 'Reinigungsmittel, Geräte, Material bestellen',
    hint: 'Bestellung anlegen, Lieferung ans Objekt.',
  },
  {
    key: 'schluessel',
    days: -10,
    title: 'Schlüssel/Transponder übernehmen',
    hint: 'Im Schlüsselbuch erfassen, Ausgabe an Mitarbeitende mit Unterschrift.',
  },
  {
    key: 'unterweisung',
    days: -7,
    title: 'Objektbezogene Unterweisung + Arbeitskleidung',
    hint: 'Gefährdungsbeurteilung, Betriebsanweisungen, Unterweisung unterschreiben lassen.',
  },
  {
    key: 'ordner',
    days: -7,
    title: 'Objektordner erstellen',
    hint: 'Objekt → Objektordner herunterladen, ausdrucken, im Putzraum hinterlegen.',
  },
  {
    key: 'qr',
    days: -3,
    title: 'QR-Aushang und Standort hinterlegen',
    hint: 'Objekt → QR-Aushang & Standort, Aushang laminiert aufhängen.',
  },
  {
    key: 'start',
    days: 0,
    title: 'Leistungsbeginn – Übergabeprotokoll mit dem Kunden',
    hint: 'Erstreinigung, Zustand dokumentieren (Fotos), Übergabe unterschreiben lassen.',
  },
  {
    key: 'qk1',
    days: 7,
    title: 'Erste Qualitätskontrolle',
    hint: 'Audit in der QM-App, Mängel sofort nachbessern.',
  },
  {
    key: 'gespraech',
    days: 30,
    title: 'Abstimmungsgespräch mit dem Kunden',
    hint: 'Zufriedenheit, Anpassungen, zweite Qualitätskontrolle.',
  },
];

export async function createStartupPlan(sql: Sql, siteId: string, start: string, actor: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new BusinessError('Bitte Vertragsbeginn angeben');
  const [site] = await sql<{ name: string; site_no: string; login: string | null }[]>`
    select s.name, s.site_no, a.login from app.sites s left join app.user_accounts a on a.id = s.manager_user_id
     where s.id = ${siteId}`;
  if (!site) throw new BusinessError('Objekt nicht gefunden');
  let created = 0;
  await sql.begin(async (tx) => {
    for (const s of STARTUP_STEPS) {
      const due = addDays(start, s.days);
      const r = await tx`
        insert into app.tasks (id, title, description, due_date, assignee, entity_type, entity_id, created_by)
        values (md5(${`anlauf:${siteId}:${s.key}`})::uuid, ${`Anlauf ${site.site_no}: ${s.title}`}, ${s.hint}, ${due},
                ${site.login}, 'site', ${siteId}, ${actor})
        on conflict (id) do update set due_date = excluded.due_date where app.tasks.status = 'open'
        returning (xmax = 0) as inserted`;
      if (r[0]?.inserted) created++;
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'startup_plan', 'site', ${siteId}, ${tx.json({ start })})`;
  });
  return { created, total: STARTUP_STEPS.length };
}
