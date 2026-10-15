-- Angebot: Status „aufgehoben“ (Ausschreibung/Vergabe vom Auftraggeber aufgehoben, kein Zuschlag an irgendwen)
alter type app.offer_status add value if not exists 'aufgehoben';
