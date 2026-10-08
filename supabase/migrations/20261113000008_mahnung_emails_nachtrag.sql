-- Fund 08.10. (Ahmed: „column dunning_emails does not exist“): Die Spalte war nachträglich an die bereits eingespielte
-- Migration 20261029000001 angehängt worden – Server, die diese Datei vorher eingespielt hatten, bekamen sie nie.
alter table app.invoice_groups add column if not exists dunning_emails text[];
