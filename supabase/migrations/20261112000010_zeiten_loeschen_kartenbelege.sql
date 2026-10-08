-- Ahmed 08.10.: Test-Zeiten und falsch übernommene Zeiten endgültig löschen; Karten-Belege stornieren/löschen.

-- ---------------------------------------------------------------------------
-- Zeiten endgültig löschen (nur über app.purge_time_entry, nur Admin im Server)
-- Der vollständige Stand (Zeile + Änderungsprotokoll) bleibt im Löschprotokoll.
-- ---------------------------------------------------------------------------
create table app.time_entry_deletions (
  id bigint generated always as identity primary key,
  entry_id uuid not null,
  deleted_at timestamptz not null default now(),
  actor text not null,
  reason text not null check (length(trim(reason)) > 0),
  entry jsonb not null,
  log jsonb not null default '[]'
);
create index on app.time_entry_deletions (entry_id);
create trigger time_entry_deletions_append_only before update or delete on app.time_entry_deletions
for each row execute function app.deny_change();
alter table app.time_entry_deletions enable row level security;
create policy time_entry_deletions_hr on app.time_entry_deletions for select to authenticated
  using ((select app.is_office()));
grant select on app.time_entry_deletions to authenticated;
grant all on app.time_entry_deletions to service_role;

create or replace function app.log_time_entry() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if coalesce(current_setting('app.purge', true), '') = 'on' then
      return old;
    end if;
    raise exception 'Zeiteinträge werden nicht gelöscht (§ 17 MiLoG: 2 Jahre aufbewahren) – bitte ablehnen oder korrigieren'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and old.status in ('erfasst', 'freigegeben')
     and (new.start_at, new.end_at, new.break_minutes, new.site_id, new.work_date)
         is distinct from (old.start_at, old.end_at, old.break_minutes, old.site_id, old.work_date)
     and coalesce(current_setting('app.reason', true), '') = '' then
    raise exception 'Änderung an erfasster Arbeitszeit nur mit Begründung' using errcode = 'check_violation';
  end if;
  insert into app.time_entry_log (entry_id, actor, reason, old_row, new_row)
  values (new.id, nullif(current_setting('app.actor', true), ''), nullif(current_setting('app.reason', true), ''),
          case when tg_op = 'UPDATE' then to_jsonb(old) end, to_jsonb(new));
  return new;
end $$;

create or replace function app.guard_time_entry_log() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('app.purge', true), '') = 'on' then
    return old;
  end if;
  raise exception 'Tabelle % ist nur anhängbar (Archiv/Protokoll)', tg_table_name using errcode = 'check_violation';
end $$;
drop trigger time_entry_log_append_only on app.time_entry_log;
create trigger time_entry_log_append_only before update or delete on app.time_entry_log
for each row execute function app.guard_time_entry_log();

create or replace function app.purge_time_entry(p_id uuid, p_actor text, p_reason text) returns boolean
language plpgsql as $$
declare
  r jsonb;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Begründung fehlt' using errcode = 'check_violation';
  end if;
  select to_jsonb(t) into r from app.time_entries t where id = p_id for update;
  if r is null then
    return false;
  end if;
  insert into app.time_entry_deletions (entry_id, actor, reason, entry, log)
  values (p_id, p_actor, trim(p_reason), r,
          coalesce((select jsonb_agg(to_jsonb(l) order by l.id) from app.time_entry_log l where l.entry_id = p_id), '[]'));
  perform set_config('app.purge', 'on', true);
  delete from app.time_entry_log where entry_id = p_id;
  delete from app.time_entries where id = p_id;
  perform set_config('app.purge', '', true);
  return true;
end $$;
revoke all on function app.purge_time_entry(uuid, text, text) from public;

-- ---------------------------------------------------------------------------
-- Karten-Belege: stornieren (bleibt sichtbar, zählt nicht mehr)
-- ---------------------------------------------------------------------------
alter table app.card_receipts
  add column cancelled_at timestamptz,
  add column cancelled_by text,
  add column cancel_reason text;
