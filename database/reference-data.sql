-- Canonical reference data extracted from the former development seed.
-- No accounts, subscriptions, prices, demo catalog or provider configuration.
-- Apply explicitly as database owner after migrations 001-028; never run on startup.
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(73821641);
DO $guard$ BEGIN
 IF current_database() <> 'meal_planner_postgres'
 OR NOT EXISTS(SELECT 1 FROM meal.environment WHERE name IN ('test','development'))
 OR (SELECT count(*) FROM meal.schema_migrations) <> 28
 THEN RAISE EXCEPTION 'Reference-data target or migration history mismatch'; END IF;
END $guard$;

INSERT INTO meal.billing_products(id,code,kind,features)
SELECT gen_random_uuid(),code,'subscription',jsonb_build_object('tier',code)
FROM (VALUES ('free'),('plus'),('pro')) AS expected(code)
ON CONFLICT(code) DO NOTHING;

INSERT INTO meal.units(id,code,dimension,factor,approximate)
SELECT gen_random_uuid(),code,dimension,factor,false
FROM (VALUES ('g','mass',1),('kg','mass',1000),('ml','volume',1),('l','volume',1000),
 ('pcs','count',1),('pack','package',1),('serv','portion',1)) AS expected(code,dimension,factor)
ON CONFLICT(code) DO NOTHING;

-- Existing dictionary records must match canonical values; do not overwrite conflicts.
DO $verify$ BEGIN
 IF (SELECT count(*) FROM meal.billing_products p
     WHERE p.code IN ('free','plus','pro') AND p.kind='subscription'
       AND p.features=jsonb_build_object('tier',p.code)) <> 3
 OR (SELECT count(*) FROM meal.units u
     JOIN (VALUES ('g','mass',1),('kg','mass',1000),('ml','volume',1),('l','volume',1000),
      ('pcs','count',1),('pack','package',1),('serv','portion',1)) expected(code,dimension,factor)
      ON u.code=expected.code AND u.dimension=expected.dimension AND u.factor=expected.factor
     WHERE NOT u.approximate) <> 7
 THEN RAISE EXCEPTION 'Reference-data conflict; transaction rolled back without overwrite'; END IF;
END $verify$;
COMMIT;
