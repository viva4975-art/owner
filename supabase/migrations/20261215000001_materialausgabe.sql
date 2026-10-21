-- Interner Lieferschein / Materialausgabe an Objekt (Ahmed 21.10.): Artikel aus dem Lager an ein Objekt ausgeben,
-- Bestand wird abgebucht, Kosten (EK zum Ausgabetag, eingefroren) zählen in der Nachkalkulation auf die Kostenstelle
-- des Objekts im Monat der Ausgabe. Nummer MA-JJJJ-NNNN, nur anhängen; Storno über Gegenbuchung.

alter table app.stock_movements
  add column unit_cost_cents bigint,
  add column booked_on date,
  add column material_issue_id uuid;

create table app.material_issues (
  id uuid primary key,
  issue_no text not null unique,
  site_id uuid not null references app.sites (id),
  issue_date date not null,
  received_by text,
  note text,
  total_cents bigint not null,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index on app.material_issues (site_id, issue_date);
create index on app.material_issues (issue_date desc);

create table app.material_issue_lines (
  issue_id uuid not null references app.material_issues (id),
  position integer not null,
  article_id uuid not null references app.articles (id),
  description text not null,
  unit text not null,
  quantity_milli bigint not null check (quantity_milli > 0),
  unit_cost_cents bigint not null check (unit_cost_cents >= 0),
  net_cents bigint not null,
  primary key (issue_id, position)
);

create table app.material_issue_cancellations (
  issue_id uuid primary key references app.material_issues (id),
  reason text not null,
  cancelled_by text not null,
  cancelled_at timestamptz not null default now()
);

create index on app.stock_movements (material_issue_id);

create trigger material_issues_append_only before update or delete on app.material_issues
for each row execute function app.deny_change();
create trigger material_issue_lines_append_only before update or delete on app.material_issue_lines
for each row execute function app.deny_change();
create trigger material_issue_cancellations_append_only before update or delete on app.material_issue_cancellations
for each row execute function app.deny_change();

alter table app.material_issues enable row level security;
alter table app.material_issue_lines enable row level security;
alter table app.material_issue_cancellations enable row level security;
create policy material_issues_office on app.material_issues for select to authenticated using ((select app.is_office()));
create policy material_issue_lines_office on app.material_issue_lines for select to authenticated using ((select app.is_office()));
create policy material_issue_cancellations_office on app.material_issue_cancellations for select to authenticated
  using ((select app.is_office()));
grant select on app.material_issues, app.material_issue_lines, app.material_issue_cancellations to authenticated;
grant all on app.material_issues, app.material_issue_lines, app.material_issue_cancellations to service_role;
