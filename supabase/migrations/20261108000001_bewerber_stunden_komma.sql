-- Stunden/Woche bei Bewerbern und Stellen mit Nachkommastellen (z. B. 32,5)
alter table app.applicants alter column hours type numeric(5, 2);
alter table app.job_postings alter column hours type numeric(5, 2);
