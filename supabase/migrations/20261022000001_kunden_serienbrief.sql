-- Vorlagen auch für Kunden-Briefe (Serienbrief aus der Kundenliste, später Schriftverkehr).
alter table app.document_templates
  add column audience text not null default 'mitarbeiter' check (audience in ('mitarbeiter', 'kunde'));

insert into app.document_templates (id, title, category, body, audience) values
  ('00000000-0000-4000-8000-0000000c2001', 'Neue Geschäftsadresse ab 01.11.2026', 'Information',
   'wir ziehen um: Ab dem 1. November 2026 erreichen Sie uns unter unserer neuen Geschäftsadresse. Telefonnummer, E-Mail-Adressen und Bankverbindungen bleiben unverändert.

Bitte passen Sie unsere Anschrift in Ihren Unterlagen (Kreditorenstamm, Bestellungen) für Ihre Kundennummer {{kundennummer}} an. Rechnungen erhalten Sie weiterhin wie gewohnt.

Für Fragen stehen wir Ihnen gern zur Verfügung.', 'kunde'),
  ('00000000-0000-4000-8000-0000000c2002', 'Preisanpassung wegen Tariflohnerhöhung', 'Preisanpassung',
   'zum 1. Januar steigen die tariflichen Mindestlöhne im Gebäudereiniger-Handwerk (allgemeinverbindlicher Tarifvertrag). Da die Lohnkosten den weitaus größten Teil unserer Leistung ausmachen, müssen wir unsere Preise entsprechend anpassen.

Die neuen Preise für Ihre Objekte teilen wir Ihnen in einer gesonderten Aufstellung mit. Grundlage ist der bestehende Vertrag mit {{firma}} (Kundennummer {{kundennummer}}).

Wir danken Ihnen für die vertrauensvolle Zusammenarbeit und Ihr Verständnis.', 'kunde'),
  ('00000000-0000-4000-8000-0000000c2003', 'Umstellung auf E-Rechnung', 'Information',
   'ab dem 1. Januar 2027 sind E-Rechnungen im Geschäftsverkehr Pflicht. Wir stellen Ihnen unsere Rechnungen deshalb künftig als ZUGFeRD-Rechnung (PDF mit eingebetteten Rechnungsdaten) bzw. als XRechnung zu.

Bitte teilen Sie uns mit, an welche E-Mail-Adresse wir Rechnungen senden sollen und ob Sie ein bestimmtes Format benötigen (z. B. XRechnung mit Leitweg-ID).', 'kunde')
on conflict (id) do nothing;
