-- Prepared for the account-deletion lifecycle. Apply after 001-026.
ALTER TABLE meal.users DROP CONSTRAINT ck_users_3;

ALTER TABLE meal.users
 ADD CONSTRAINT ck_users_3
 CHECK(
   status IN('active','archived','blocked','pending','deleted')
   AND login<>''
   AND email_normalized=lower(email_normalized)
 );
