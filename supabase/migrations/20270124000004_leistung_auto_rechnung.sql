-- Automatik (Ahmed 13.11.): Rechnungsentwurf entsteht von selbst, sobald ein Arbeitsschein mit dieser Leistung
-- unterschrieben ist. Standard aus. Es entsteht nur ein Entwurf – ausgestellt wird weiterhin von Hand.
alter table app.site_services add column if not exists auto_invoice boolean not null default false;
