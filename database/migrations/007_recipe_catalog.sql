-- Prepared only; migration runner owns serializable transaction/checksum.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE meal.recipe_revisions ADD COLUMN description text;
ALTER TABLE meal.recipe_revisions ADD COLUMN category text;
ALTER TABLE meal.recipe_revisions ADD COLUMN image_url text;
ALTER TABLE meal.recipe_revisions ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE meal.recipe_bookmarks ADD COLUMN removed_at timestamptz;
COMMENT ON COLUMN meal.recipe_revisions.category IS 'Dish category code belonging to this immutable published revision; not an ingredient category';
COMMENT ON COLUMN meal.recipe_bookmarks.removed_at IS 'Desired-state bookmark removal without destructive DELETE; restore updates this row';
