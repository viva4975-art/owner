-- Ausschreibung: Ortsbesichtigung als Auswahl (nicht nötig / vereinbart / jemand vereinbart sie noch)
alter table app.tenders add column if not exists site_visit_mode text
  check (site_visit_mode in ('none', 'fixed', 'arrange'));
alter table app.tenders add column if not exists site_visit_assignee text;
update app.tenders set site_visit_mode = 'fixed' where site_visit_mode is null and site_visit_at is not null;
