-- Geräte mit QR-Code verfolgen, Stufe 1 (Ahmed 19.10.): Scheuersaugmaschinen, Staubsauger, Wischwagen usw. bekommen ein
-- QR-Etikett. Wer es scannt, meldet „Gerät ist hier“, „mitgenommen zu Objekt …“, „zurück ins Lager“ oder „defekt“.
-- Standort des Handys nur im Moment des Scans (kein Tracking).
alter type app.entity_type add value if not exists 'device';

alter table app.devices
  add column if not exists kind text not null default 'sonstiges'
    check (kind in ('scheuersaugmaschine', 'staubsauger', 'wischwagen', 'reinigungswagen', 'einscheibenmaschine',
                    'hochdruckreiniger', 'nasssauger', 'leiter', 'sonstiges')),
  add column if not exists status text not null default 'ok' check (status in ('ok', 'defekt', 'reparatur')),
  add column if not exists qr_token text not null default md5(gen_random_uuid()::text);
create unique index if not exists devices_qr_token_uq on app.devices (qr_token);

-- Verlauf je Gerät: Scans aus der App und Prüfungen/Reparaturen vom Büro. Nur anhängen.
create table app.device_events (
  id uuid primary key,
  device_id uuid not null references app.devices (id),
  action text not null check (action in ('hier', 'mitgenommen', 'lager', 'defekt', 'repariert', 'pruefung',
                                          'reparatur', 'notiz')),
  site_id uuid references app.sites (id),
  event_date date not null default (now() at time zone 'Europe/Berlin')::date,
  note text check (char_length(note) <= 1000),
  photo_file_id uuid references app.files (id),
  -- Standort beim Scan: Bewertung gegen das Objekt, Entfernung, Genauigkeit, Koordinaten (5 Nachkommastellen ≈ 1 m)
  geo text,
  geo_m integer,
  geo_acc_m integer,
  lat numeric(8, 5),
  lng numeric(8, 5),
  by_name text not null,
  employee_id uuid references app.employees (id),
  created_by text not null,
  created_at timestamptz not null default now()
);
create index on app.device_events (device_id, created_at desc);
create trigger device_events_append_only before update or delete on app.device_events
for each row execute function app.deny_change();

alter table app.device_events enable row level security;
create policy device_events_read on app.device_events for select to authenticated
  using ((select app.is_office()) or device_id in (
    select d.id from app.devices d join app.sites s on s.id = d.site_id where s.manager_user_id = (select auth.uid())));
grant select on app.device_events to authenticated;
grant all on app.device_events to service_role;

-- Art aus der Bezeichnung vorbelegen
update app.devices set kind = case
    when name ~* 'scheuersaug' then 'scheuersaugmaschine'
    when name ~* 'einscheibe' then 'einscheibenmaschine'
    when name ~* 'hochdruck' then 'hochdruckreiniger'
    when name ~* 'nass|wassersaug' then 'nasssauger'
    when name ~* 'sauger|staubsaug' then 'staubsauger'
    when name ~* 'wischwagen|moppwagen' then 'wischwagen'
    when name ~* 'reinigungswagen|putzwagen' then 'reinigungswagen'
    when name ~* 'leiter' then 'leiter'
    else 'sonstiges' end
 where kind = 'sonstiges';
