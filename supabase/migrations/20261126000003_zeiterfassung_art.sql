-- Art der Zeiterfassung je Mitarbeiter (Ahmed 15.10.2026): alle Wege (wie bisher), nur Einsatz bestätigen,
-- nur Stoppuhr (Start/Stopp) oder Stoppuhr nur mit QR-Code am Objekt
alter table app.employees add column if not exists time_mode text not null default 'alle'
  check (time_mode in ('alle', 'bestaetigen', 'stoppuhr', 'qr'));
