-- Ahmed 20.10.2026: Neuanfang bei den Nachunternehmer-Bestellungen zum 01.10.2026.
-- 1) Erteilte NU-Bestellungen mit Beginn bis 30.09.2026 → beendet, Ende spätestens 30.09.2026.
-- 2) NU-Entwürfe, die vor dem 01.10.2026 angelegt wurden → storniert.
-- Bestellungen ab 01.10.2026 und Material-Bestellungen bleiben unverändert.
-- Der alte Stand jeder Zeile steht im Protokoll (audit_log, action 'stichtag_30_09') – damit rücknehmbar.

insert into app.audit_log (actor, action, entity, entity_id, details)
select 'migration', 'stichtag_30_09', 'subcontract', s.id,
       jsonb_build_object('status_alt', s.status, 'valid_to_alt', s.valid_to,
                          'status_neu', case when s.status = 'erteilt' then 'beendet' else 'storniert' end)
  from app.subcontracts s
 where (s.status = 'erteilt' and s.valid_from <= date '2026-09-30')
    or (s.status = 'entwurf' and (s.created_at at time zone 'Europe/Berlin')::date <= date '2026-09-30');

update app.subcontracts
   set status = 'beendet',
       valid_to = least(coalesce(valid_to, date '2026-09-30'), date '2026-09-30')
 where status = 'erteilt' and valid_from <= date '2026-09-30';

update app.subcontracts
   set status = 'storniert'
 where status = 'entwurf' and (created_at at time zone 'Europe/Berlin')::date <= date '2026-09-30';

-- Freigabe-Aufgaben stornierter Anfragen der Objektleitung erledigen
update app.tasks t
   set status = 'done', done_at = now(), done_by = 'migration'
  from app.subcontracts s
 where t.id = md5('nu-anfrage:' || s.id::text)::uuid and t.status = 'open' and s.status = 'storniert';
