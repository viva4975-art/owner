-- Ahmed 16.10.: Auffällige Zeiten (Ist weicht stark vom Plan ab, gestempelt weit weg vom Objekt) am PC und in der App der
-- Objektleitung anzeigen. Hier nur das „geprüft“-Häkchen je Zeit; erkannt wird in src/services/time-anomalies.ts.
create table app.time_entry_reviews (
  entry_id uuid primary key references app.time_entries (id) on delete cascade,
  note text,
  reviewed_by text not null,
  reviewed_at timestamptz not null default now()
);
alter table app.time_entry_reviews enable row level security;
create policy time_entry_reviews_read on app.time_entry_reviews for select to authenticated
  using ((select app.is_office()) or (select app.is_hr())
         or entry_id in (select t.id from app.time_entries t join app.sites s on s.id = t.site_id
                          where s.manager_user_id = (select auth.uid())));
