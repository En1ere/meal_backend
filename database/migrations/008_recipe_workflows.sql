-- Prepared only. Apply via the migration runner after 002–007 during an approved transfer.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE meal.recipe_policy (
    id uuid PRIMARY KEY CHECK (id='71000000-0000-4000-8000-000000000001'),
    submission_daily_limit integer NOT NULL CHECK (submission_daily_limit BETWEEN 1 AND 10000),
    comment_hourly_limit integer NOT NULL CHECK (comment_hourly_limit BETWEEN 1 AND 10000),
    report_daily_limit integer NOT NULL CHECK (report_daily_limit BETWEEN 1 AND 10000),
    version bigint NOT NULL DEFAULT 1 CHECK (version>0),
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO meal.recipe_policy(id,submission_daily_limit,comment_hourly_limit,report_daily_limit)
VALUES ('71000000-0000-4000-8000-000000000001',10,30,10);
CREATE TABLE meal.recipe_action_events (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES meal.users(id),
    kind text NOT NULL CHECK (kind IN ('submission','comment','report')),
    occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Rolling per-account count uses this equality/equality/range access path.
CREATE INDEX ix_recipe_action_events_window ON meal.recipe_action_events(user_id,kind,occurred_at);
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.recipe_policy
FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.recipe_action_events
FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
COMMENT ON TABLE meal.recipe_policy IS 'Service-wide recipe anti-abuse policy; administrator edits are versioned and audited';
COMMENT ON TABLE meal.recipe_action_events IS 'Accepted recipe commands; rolling 24h/1h quota, no content payload; retention requires separate approval';

-- Metadata only: catalog filled during development must survive test resets.
DO $catalog_marker$
DECLARE table_name text; existing_comment text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['categories','units','ingredients','ingredient_categories','ingredient_variants','brands','brand_products','product_barcodes','composition_versions','allergens','composition_allergens','unit_conversions','catalog_proposals','catalog_proposal_revisions','catalog_merges','recipes','recipe_revisions','recipe_ingredients','recipe_steps','recipe_publications'] LOOP
    SELECT obj_description(format('meal.%I', table_name)::regclass, 'pg_class') INTO existing_comment;
    EXECUTE format('COMMENT ON TABLE meal.%I IS %L', table_name,
      coalesce(existing_comment, '') || ' [production-catalog] Preserve development curation for production; never reset with test operations. See database/catalog-preservation.json.');
  END LOOP;
END
$catalog_marker$;
