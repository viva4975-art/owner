-- Ahmed 28.10.: erstellte Materialausgaben (interne Lieferscheine) löschen können. Löschen nur über den Server
-- (app.purge = 'on' innerhalb der Transaktion, Stand vorher ins Protokoll); sonst bleiben die Tabellen nur anhängbar.
create or replace function app.deny_change_unless_purge() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('app.purge', true), '') = 'on' then
    return old;
  end if;
  raise exception 'Tabelle % ist nur anhängbar (Archiv/Protokoll)', tg_table_name using errcode = 'check_violation';
end $$;

drop trigger material_issues_append_only on app.material_issues;
create trigger material_issues_append_only before update or delete on app.material_issues
for each row execute function app.deny_change_unless_purge();
drop trigger material_issue_lines_append_only on app.material_issue_lines;
create trigger material_issue_lines_append_only before update or delete on app.material_issue_lines
for each row execute function app.deny_change_unless_purge();
drop trigger material_issue_cancellations_append_only on app.material_issue_cancellations;
create trigger material_issue_cancellations_append_only before update or delete on app.material_issue_cancellations
for each row execute function app.deny_change_unless_purge();
drop trigger stock_movements_append_only on app.stock_movements;
create trigger stock_movements_append_only before update or delete on app.stock_movements
for each row execute function app.deny_change_unless_purge();
