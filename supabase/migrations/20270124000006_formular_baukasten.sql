-- Formular-Baukasten (Ahmed 13.11., Vorbild Blink Check): eigene Formulare mit Seiten und Feldern, ausgefüllt in der
-- App bzw. am PC, Ergebnis als PDF in der Akte von Mitarbeiter oder Objekt. Einträge sind unveränderbar.
create table if not exists app.form_templates (
  id uuid primary key,
  name text not null check (length(trim(name)) between 1 and 80),
  description text check (description is null or length(description) <= 500),
  target text not null default 'keins' check (target in ('mitarbeiter', 'objekt', 'keins')),
  file_category text check (file_category is null or length(file_category) <= 60),
  schema jsonb not null default '{"pages":[]}',
  active boolean not null default true,
  version integer not null default 1,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger form_templates_version before update on app.form_templates for each row execute function app.bump_version();
alter table app.form_templates enable row level security;
create policy form_templates_read on app.form_templates for select to authenticated using (true);
grant select on app.form_templates to authenticated;
grant all on app.form_templates to service_role;

create table if not exists app.form_submissions (
  id uuid primary key,
  template_id uuid not null references app.form_templates (id),
  template_name text not null,
  schema jsonb not null,                   -- Stand der Vorlage beim Ausfüllen
  employee_id uuid references app.employees (id),
  site_id uuid references app.sites (id),
  data jsonb not null,
  file_id uuid references app.files (id),
  created_by text not null,
  created_at timestamptz not null default now()
);
create index if not exists form_submissions_tpl on app.form_submissions (template_id, created_at desc);
alter table app.form_submissions enable row level security;
create policy form_submissions_office on app.form_submissions for select to authenticated using ((select app.is_office()));
grant select on app.form_submissions to authenticated;
grant all on app.form_submissions to service_role;
create trigger form_submissions_no_update before update or delete on app.form_submissions
  for each row execute function app.deny_change_unless_purge();

-- Startvorlagen (änderbar)
insert into app.form_templates (id, name, description, target, file_category, schema, created_by) values
('00000000-0000-4000-8000-00000f000001', 'Führerscheinkontrolle', 'Halbjährliche Kontrolle für Mitarbeitende mit Firmenfahrzeug.', 'mitarbeiter', 'Personalunterlagen',
 '{"pages":[{"title":"Führerschein","fields":[
   {"id":"klassen","type":"multi","label":"Führerscheinklassen","required":true,"options":["B","BE","C1","C1E","L"]},
   {"id":"gueltig","type":"date","label":"Gültig bis (falls angegeben)"},
   {"id":"original","type":"yesno","label":"Führerschein lag im Original vor","required":true},
   {"id":"foto","type":"photo","label":"Foto Vorder- und Rückseite"}]},
  {"title":"Bestätigung","fields":[
   {"id":"hinweis","type":"info","label":"Ich melde ein Fahrverbot oder den Entzug der Fahrerlaubnis sofort."},
   {"id":"unterschrift","type":"signature","label":"Unterschrift Mitarbeiter/in","required":true}]}]}', 'system'),
('00000000-0000-4000-8000-00000f000002', 'Objektbegehung', 'Begehung mit dem Kunden oder intern.', 'objekt', 'Protokolle',
 '{"pages":[{"title":"Begehung","fields":[
   {"id":"teilnehmer","type":"text","label":"Teilnehmer"},
   {"id":"zustand","type":"select","label":"Gesamteindruck","required":true,"options":["sehr gut","gut","ausreichend","mangelhaft"]},
   {"id":"maengel","type":"textarea","label":"Festgestellte Mängel / Wünsche des Kunden"},
   {"id":"fotos","type":"photo","label":"Fotos"},
   {"id":"massnahmen","type":"textarea","label":"Vereinbarte Maßnahmen"},
   {"id":"unterschrift","type":"signature","label":"Unterschrift Kunde"}]}]}', 'system'),
('00000000-0000-4000-8000-00000f000003', 'Adressänderung', 'Neue Anschrift einer/eines Mitarbeitenden.', 'mitarbeiter', 'Personalunterlagen',
 '{"pages":[{"title":"Neue Anschrift","fields":[
   {"id":"strasse","type":"text","label":"Straße und Hausnummer","required":true},
   {"id":"plz_ort","type":"text","label":"PLZ und Ort","required":true},
   {"id":"ab","type":"date","label":"Gültig ab","required":true},
   {"id":"unterschrift","type":"signature","label":"Unterschrift Mitarbeiter/in","required":true}]}]}', 'system'),
('00000000-0000-4000-8000-00000f000004', 'Mitarbeiterumfrage', 'Kurze Zufriedenheitsumfrage.', 'keins', null,
 '{"pages":[{"title":"Umfrage","fields":[
   {"id":"zufrieden","type":"select","label":"Wie zufrieden bist du mit deiner Arbeit?","required":true,"options":["sehr zufrieden","zufrieden","geht so","unzufrieden"]},
   {"id":"material","type":"yesno","label":"Hast du genug Material und Geräte?"},
   {"id":"wunsch","type":"textarea","label":"Was können wir besser machen?"}]}]}', 'system')
on conflict (id) do nothing;
