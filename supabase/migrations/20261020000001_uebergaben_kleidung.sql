-- Übergaben mit Unterschrift vor Ort (Arbeitskleidung, Schlüssel, Geräte, Dokumente/Unterweisungen, Sonstiges).
-- Objektleitung legt an und lässt am eigenen Gerät unterschreiben; erst mit der Unterschrift werden Bestand/Schlüsselbuch
-- gebucht. Danach unveränderbar, Protokoll-PDF write-once. Arbeitskleidung mit Bestand je Artikel + Größe
-- (Bewegungen append-only).

create table app.clothing_articles (
  id uuid primary key,
  name text not null unique check (length(trim(name)) > 0),
  unit_price_cents bigint not null default 0 check (unit_price_cents >= 0),   -- Wert je Stück (Protokoll)
  -- Persönliche Schutzausrüstung (z. B. Sicherheitsschuhe, Warnweste): Kosten trägt der Arbeitgeber (§ 3 Abs. 3 ArbSchG)
  is_ppe boolean not null default false,
  sizes text[] not null default '{}',
  min_stock integer not null default 2 check (min_stock >= 0),
  active boolean not null default true,
  version integer not null default 1,
  created_at timestamptz not null default now()
);
create trigger clothing_articles_version before update on app.clothing_articles
for each row execute function app.bump_version();

create table app.clothing_moves (
  id uuid primary key,
  article_id uuid not null references app.clothing_articles (id),
  size text not null default '',
  delta integer not null check (delta <> 0),
  reason text not null check (reason in ('zugang', 'ausgabe', 'rueckgabe', 'korrektur', 'inventur')),
  handover_id uuid,
  note text,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index on app.clothing_moves (article_id, size);
create trigger clothing_moves_append_only before update or delete on app.clothing_moves
for each row execute function app.deny_change();

create table app.handovers (
  id uuid primary key,
  number text not null unique,                       -- UE-JJJJ-NNNN
  kind text not null check (kind in ('kleidung', 'schluessel', 'geraet', 'dokument', 'sonstiges')),
  direction text not null default 'ausgabe' check (direction in ('ausgabe', 'rueckgabe')),
  employee_id uuid references app.employees (id),
  supplier_id uuid references app.suppliers (id),     -- Subunternehmer
  recipient_name text not null,                       -- Schnappschuss (Name des Unterschreibenden)
  site_id uuid references app.sites (id),
  handover_date date not null,
  title text not null,
  items jsonb not null default '[]'::jsonb,           -- [{label, size, qty, unit_price_cents, article_id?, key_id?, device_id?}]
  body_text text,                                     -- Erklärung/Inhalt (bei „dokument“: Text der Unterweisung)
  document_name text,                                 -- bei „dokument“: hochgeladenes PDF (write-once im Archiv)
  document_path text,
  document_sha256 text,
  wage_deduction boolean not null default false,      -- Vereinbarung Lohnabzug (nur ohne PSA, ausdrücklich)
  related_id uuid references app.handovers (id),      -- Rückgabe zu Ausgabe
  note text,
  status text not null default 'entwurf' check (status in ('entwurf', 'unterschrieben', 'ohne_unterschrift', 'storniert')),
  signed_name text,
  signed_at timestamptz,
  signature_path text,
  signature_sha256 text,
  issuer_name text,                                   -- „Übergeben durch“ (angemeldeter Benutzer)
  no_signature_reason text,
  pdf_path text,
  pdf_sha256 text,
  created_by text not null,
  created_at timestamptz not null default now(),
  version integer not null default 1,
  check ((employee_id is not null) or (supplier_id is not null) or kind = 'sonstiges'),
  check (status <> 'unterschrieben' or (signed_at is not null and signature_sha256 is not null)),
  check (status <> 'ohne_unterschrift' or no_signature_reason is not null)
);
create index on app.handovers (employee_id);
create index on app.handovers (site_id);
create index on app.handovers (status, handover_date);
create trigger handovers_version before update on app.handovers for each row execute function app.bump_version();

-- Abgeschlossene Übergaben sind unveränderbar (nur PDF-Pfad darf einmalig nachgetragen werden)
create or replace function app.guard_handover() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'entwurf' then raise exception 'Abgeschlossene Übergaben können nicht gelöscht werden'; end if;
    return old;
  end if;
  if old.status in ('unterschrieben', 'ohne_unterschrift') then
    if (new.pdf_path is distinct from old.pdf_path and old.pdf_path is null)
       and (to_jsonb(new) - 'pdf_path' - 'pdf_sha256' - 'version') = (to_jsonb(old) - 'pdf_path' - 'pdf_sha256' - 'version') then
      return new;
    end if;
    raise exception 'Abgeschlossene Übergaben sind unveränderbar';
  end if;
  return new;
end $$;
create trigger handovers_guard before update or delete on app.handovers
for each row execute function app.guard_handover();

alter table app.clothing_articles enable row level security;
alter table app.clothing_moves enable row level security;
alter table app.handovers enable row level security;
create policy clothing_articles_read on app.clothing_articles for select to authenticated using (true);
create policy clothing_moves_office on app.clothing_moves for select to authenticated using ((select app.is_office()));
create policy handovers_read on app.handovers for select to authenticated
  using ((select app.is_office()) or (select app.is_hr())
         or site_id in (select s.id from app.sites s where s.manager_user_id = (select auth.uid())));
grant select on app.clothing_articles, app.clothing_moves, app.handovers to authenticated;
grant all on app.clothing_articles, app.clothing_moves, app.handovers to service_role;

-- Startartikel aus der alten App (Preise wie dort; PSA ohne Lohnabzug)
insert into app.clothing_articles (id, name, unit_price_cents, is_ppe, sizes) values
  ('00000000-0000-4000-8000-0000000c7001', 'T-Shirt grau', 1500, false, '{XS,S,M,L,XL,XXL,3XL}'),
  ('00000000-0000-4000-8000-0000000c7002', 'T-Shirt weiß', 1500, false, '{XS,S,M,L,XL,XXL,3XL}'),
  ('00000000-0000-4000-8000-0000000c7003', 'Poloshirt', 1500, false, '{XS,S,M,L,XL,XXL,3XL}'),
  ('00000000-0000-4000-8000-0000000c7004', 'Arbeitshose', 3000, false, '{44,46,48,50,52,54,56,58,60,S,M,L,XL,XXL}'),
  ('00000000-0000-4000-8000-0000000c7005', 'Jacke', 6000, false, '{XS,S,M,L,XL,XXL,3XL}'),
  ('00000000-0000-4000-8000-0000000c7006', 'Kittel (Damen)', 3000, false, '{34,36,38,40,42,44,46,48}'),
  ('00000000-0000-4000-8000-0000000c7007', 'Cappy (Küche)', 1000, false, '{Einheitsgröße}'),
  ('00000000-0000-4000-8000-0000000c7008', 'Sicherheitsschuhe', 2500, true, '{36,37,38,39,40,41,42,43,44,45,46,47,48}'),
  ('00000000-0000-4000-8000-0000000c7009', 'Warnweste', 1000, true, '{Einheitsgröße}')
on conflict (id) do nothing;
