-- Offene Stellen automatisch auf der Website (Ahmed 02.11.): alle aktiven Stellen ohne Häkchen werden veröffentlicht,
-- neue Stellen haben das Häkchen vorbelegt. Abwählen bleibt je Stelle möglich. Geänderte IDs im Protokoll.
with ch as (
  update app.job_postings set website = true where status = 'aktiv' and not website returning id
)
insert into app.audit_log (actor, action, entity, entity_id, details)
select 'migration', 'website_an', 'job_posting', id, '{"website_alt": false}'::jsonb from ch;
