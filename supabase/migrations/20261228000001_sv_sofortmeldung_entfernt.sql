-- SV-Sofortmeldung wieder entfernt (Ahmed 26.10.: „lösch das dann wieder“) – gemeldet wird in Lexware/sv.net.
drop table if exists app.sv_immediate_reports;
alter table app.company drop column if exists betriebsnummer;
