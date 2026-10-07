-- Anzeigename = voller Name statt Benutzername („ahmed.chomontek“ → „Ahmed Chomontek“)
update app.profiles p
   set display_name = initcap(regexp_replace(a.login, '[._-]+', ' ', 'g'))
  from app.user_accounts a
 where a.id = p.user_id
   and lower(p.display_name) = lower(a.login)
   and a.login ~ '[._-]';
