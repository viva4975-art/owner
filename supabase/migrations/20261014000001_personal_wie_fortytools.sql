-- Personal wie Fortytools: Anrede, Tags, Warnhinweis, Info, Mobil, weitere E-Mail, Lohnstufen, Resturlaub-Regel;
-- vertraulich: Geburtsort/-land, Familienstand, Aufenthaltserlaubnis-Info. Dokumentvorlagen für Serienbriefe.

create table app.wage_levels (
  id uuid primary key,
  name text not null unique check (length(trim(name)) > 0),   -- z. B. „Stundenlohn Tarif 1 NEU“
  hourly_wage_cents bigint not null check (hourly_wage_cents > 0),
  valid_from date,
  note text,
  active boolean not null default true,
  version integer not null default 1
);
create trigger wage_levels_version before update on app.wage_levels for each row execute function app.bump_version();

alter table app.employees
  add column salutation text check (salutation in ('Herr', 'Frau', 'divers')),
  add column tags text[] not null default '{}',
  add column warning_note text,                 -- besonders hervorgehobene Info (Fortytools „Warnhinweis“)
  add column info text,
  add column mobile text,
  add column email_private text,                -- „weitere E-Mail“
  add column wage_level_id uuid references app.wage_levels (id),
  add column carry_over_leave boolean not null default true; -- Resturlaub ins Folgejahr (verfällt 31.03.)
create index on app.employees using gin (tags);

alter table app.employee_private
  add column birth_place text,
  add column birth_country text,
  add column marital_status text,
  add column residence_permit_info text;

-- Wirksamer Stundenlohn: individueller Lohn vor Lohnstufe
create or replace function app.effective_wage_cents(e app.employees) returns bigint
language sql stable as $$
  select coalesce(e.hourly_wage_cents, (select w.hourly_wage_cents from app.wage_levels w where w.id = e.wage_level_id))
$$;

-- Dokumentvorlagen (Serienbrief / „Neu aus Vorlage“) mit Platzhaltern {{vorname}} usw.
create table app.document_templates (
  id uuid primary key,
  title text not null check (length(trim(title)) > 0),
  category text not null default 'Sonstiges',
  body text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  version integer not null default 1
);
create trigger document_templates_version before update on app.document_templates
for each row execute function app.bump_version();

insert into app.document_templates (id, title, category, body) values
  ('00000000-0000-4000-8000-0000000c1001', 'Bescheinigung über das Beschäftigungsverhältnis', 'Bescheinigung',
   'hiermit bestätigen wir, dass {{anrede_name}}, geboren am {{geburtsdatum}}, wohnhaft {{strasse}}, {{plz}} {{ort}}, seit dem {{eintritt}} bei der Viva-Deluxe Gebäudereinigung GmbH als {{beschaeftigung}} mit {{wochenstunden}} Wochenstunden beschäftigt ist.

Das Beschäftigungsverhältnis ist ungekündigt.

Diese Bescheinigung wird auf Wunsch zur Vorlage bei Behörden ausgestellt.'),
  ('00000000-0000-4000-8000-0000000c1002', 'Arbeitsanweisung Objekt', 'Unterweisung',
   'für Ihren Einsatz gelten die folgenden Regeln:

1. Arbeitsbeginn und -ende werden mit der Viva-Deluxe-App am Objekt erfasst (QR-Code).
2. Reinigungsmittel nur nach Betriebsanweisung verwenden und nie mischen.
3. Schäden und Auffälligkeiten sofort der Objektleitung melden.
4. Schlüssel und Zugangsmedien sind sorgfältig zu verwahren; Verlust sofort melden.

Bei Fragen wenden Sie sich bitte an Ihre Objektleitung.');

alter table app.wage_levels enable row level security;
create policy wage_levels_hr on app.wage_levels for select to authenticated using ((select app.is_hr()));
alter table app.document_templates enable row level security;
create policy document_templates_hr on app.document_templates for select to authenticated using ((select app.is_hr()));
grant select on app.wage_levels, app.document_templates to authenticated;
grant all on app.wage_levels, app.document_templates to service_role;
