-- Briefe: „Unser Zeichen“, „Ihr Zeichen“, Ansprechpartner (statt Briefnummer im Brief)
alter table app.letters add column if not exists our_ref text check (our_ref is null or length(our_ref) <= 60);
alter table app.letters add column if not exists your_ref text check (your_ref is null or length(your_ref) <= 60);
alter table app.letters add column if not exists sender text check (sender is null or length(sender) <= 120);
