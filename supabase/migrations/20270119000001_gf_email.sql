-- E-Mail der Geschäftsführung (Ahmed 05.11.2026: Kundenübersicht, „Geschäftsführung mail ist a.chomontek“)
alter table app.company add column if not exists managing_director_email text
  check (managing_director_email is null or managing_director_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');
update app.company set managing_director_email = 'a.chomontek@viva-deluxe-reinigung.de'
 where managing_director_email is null and email ilike '%@viva-deluxe-reinigung.de';
