-- Prepared only. Apply after 001-012 during the separately approved Linux transfer.
-- The migration runner owns the SERIALIZABLE transaction and checksum verification.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE meal.sanctions
 ADD COLUMN category text,
 ADD COLUMN private_note text;
ALTER TABLE meal.sanctions
 ADD CONSTRAINT sanctions_category_chk CHECK(category IS NULL OR category IN (
  'spam','harassment','discrimination','privacy','copyright','dangerous','inappropriate','fraud','evasion','other','rules'
 )),
 ADD CONSTRAINT sanctions_private_note_chk CHECK(private_note IS NULL OR length(private_note) <= 5000);
COMMENT ON COLUMN meal.sanctions.category IS 'Required by new admin commands; nullable only for historical sanctions created before v13.';
COMMENT ON COLUMN meal.sanctions.private_note IS 'Staff-only note. Never project to user-facing sanction responses.';

-- Application-role privileges are applied after all migrations from database/application-grants.sql.
