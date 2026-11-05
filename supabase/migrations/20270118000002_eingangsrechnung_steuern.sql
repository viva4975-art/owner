-- Eingangsrechnung: Kostenarten Umsatzsteuer / Körperschaftsteuer (Ahmed 05.11.2026: Zahlung ans Finanzamt nicht vergessen)
alter type app.cost_category add value if not exists 'umsatzsteuer';
alter type app.cost_category add value if not exists 'koerperschaftsteuer';
