-- Revision-aware recipe moderation and exactly one active publication per recipe.
-- The migration runner owns the SERIALIZABLE transaction and checksum verification.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM meal.recipe_publications p
    JOIN meal.recipe_revisions rr ON rr.id = p.revision_id
    WHERE p.unpublished_at IS NULL
    GROUP BY rr.recipe_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'recipe lifecycle migration blocked: multiple active publications for one recipe';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM meal.moderation_cases
    WHERE kind = 'recipe' AND recipe_revision_id IS NOT NULL
    GROUP BY recipe_revision_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'recipe lifecycle migration blocked: duplicate recipe submission cases';
  END IF;

  IF EXISTS (
    SELECT 1 FROM meal.moderation_cases WHERE kind = 'recipe' AND recipe_revision_id IS NULL
  ) THEN
    RAISE EXCEPTION 'recipe lifecycle migration blocked: recipe case without revision';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM meal.recipe_publications p
    LEFT JOIN meal.recipe_revisions rr ON rr.id = p.revision_id
    WHERE rr.id IS NULL
  ) THEN
    RAISE EXCEPTION 'recipe lifecycle migration blocked: publication without revision';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM meal.recipe_publications p
    JOIN meal.moderation_decisions d ON d.id = p.decision_id
    LEFT JOIN meal.moderation_cases mc
      ON mc.id = d.case_id
     AND mc.kind = 'recipe'
     AND mc.recipe_revision_id = p.revision_id
    WHERE p.unpublished_at IS NULL AND mc.id IS NULL
  ) THEN
    RAISE EXCEPTION 'recipe lifecycle migration blocked: active publication lacks its recipe review case';
  END IF;
END;
$$;

ALTER TABLE meal.recipe_revisions
  ADD CONSTRAINT uq_recipe_revisions_recipe_id_id UNIQUE (recipe_id, id);

ALTER TABLE meal.recipe_publications
  ADD COLUMN recipe_id uuid;

-- Existing identity protection treats every identity-like *_id column as immutable.
-- Disable only that row trigger for the one-time NULL -> derived value backfill;
-- the SERIALIZABLE guard and every other trigger stay active.
ALTER TABLE meal.recipe_publications DISABLE TRIGGER protect_identity;

UPDATE meal.recipe_publications p
SET recipe_id = rr.recipe_id
FROM meal.recipe_revisions rr
WHERE rr.id = p.revision_id;

ALTER TABLE meal.recipe_publications ENABLE TRIGGER protect_identity;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM meal.recipe_publications WHERE recipe_id IS NULL) THEN
    RAISE EXCEPTION 'recipe lifecycle migration blocked: publication recipe backfill incomplete';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION meal.sync_recipe_publication_recipe_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, meal
AS $$
DECLARE
  expected_recipe_id uuid;
BEGIN
  SELECT rr.recipe_id
  INTO expected_recipe_id
  FROM meal.recipe_revisions rr
  WHERE rr.id = NEW.revision_id;

  IF expected_recipe_id IS NULL THEN
    RAISE EXCEPTION 'recipe publication revision does not exist'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.recipe_id IS NULL THEN
    NEW.recipe_id := expected_recipe_id;
  ELSIF NEW.recipe_id <> expected_recipe_id THEN
    RAISE EXCEPTION 'recipe publication recipe/revision mismatch'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM meal.moderation_decisions d
    JOIN meal.moderation_cases mc ON mc.id = d.case_id
    WHERE d.id = NEW.decision_id
      AND mc.kind = 'recipe'
      AND mc.recipe_revision_id = NEW.revision_id
  ) THEN
    RAISE EXCEPTION 'recipe publication decision is not bound to its recipe review case'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION meal.sync_recipe_publication_recipe_id() FROM PUBLIC;

CREATE TRIGGER sync_recipe_publication_recipe_id
BEFORE INSERT OR UPDATE OF recipe_id, revision_id, decision_id
ON meal.recipe_publications
FOR EACH ROW
EXECUTE FUNCTION meal.sync_recipe_publication_recipe_id();

ALTER TABLE meal.recipe_publications
  ALTER COLUMN recipe_id SET NOT NULL,
  ADD CONSTRAINT fk_recipe_publications_recipe_revision
    FOREIGN KEY (recipe_id, revision_id)
    REFERENCES meal.recipe_revisions (recipe_id, id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX uq_recipe_publications_active_recipe
  ON meal.recipe_publications (recipe_id)
  WHERE unpublished_at IS NULL;

CREATE UNIQUE INDEX uq_moderation_cases_recipe_revision_submission
  ON meal.moderation_cases (recipe_revision_id)
  WHERE kind = 'recipe' AND recipe_revision_id IS NOT NULL;

ALTER TABLE meal.moderation_cases
  ADD CONSTRAINT ck_moderation_cases_recipe_revision_target
  CHECK (kind <> 'recipe' OR recipe_revision_id IS NOT NULL);

COMMENT ON COLUMN meal.recipe_publications.recipe_id IS
  'Owning recipe, trigger-derived for rollback compatibility with pre-v29 writers';

