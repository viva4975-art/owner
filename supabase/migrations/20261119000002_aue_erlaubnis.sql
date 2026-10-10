-- Erlaubnis zur Arbeitnehmerüberlassung (§ 1 AÜG) in den Firmendaten (Ahmed 10.10.: „wir haben eine
-- Arbeitnehmerüberlassung“). Füllt die Platzhalter der AÜ-Verträge und erinnert vor Ablauf (Verlängerung § 2 Abs. 4 AÜG
-- spätestens drei Monate vor Ablauf beantragen).
alter table app.company
  add column if not exists aue_permit_date date,
  add column if not exists aue_permit_file_no text,
  add column if not exists aue_permit_authority text,
  add column if not exists aue_permit_valid_until date,
  add column if not exists aue_permit_unlimited boolean not null default false;
