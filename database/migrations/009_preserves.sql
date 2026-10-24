-- Prepared only. Apply after 002-008 during the separately approved Linux transfer.
-- The migration runner owns the SERIALIZABLE transaction and checksum verification.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE meal.preserve_details ADD COLUMN created_on date;
UPDATE meal.preserve_details
SET created_on = (created_at AT TIME ZONE 'UTC')::date
WHERE created_on IS NULL;
ALTER TABLE meal.preserve_details ALTER COLUMN created_on SET NOT NULL;

ALTER TABLE meal.preserve_details
    ADD COLUMN ingredients_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD CONSTRAINT preserve_ingredients_snapshot_array
        CHECK (jsonb_typeof(ingredients_snapshot) = 'array');

CREATE TABLE meal.preserve_containers (
    id uuid PRIMARY KEY,
    preserve_id uuid NOT NULL REFERENCES meal.preserve_details(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    label text NOT NULL CHECK (btrim(label) <> '' AND char_length(label) <= 120),
    initial_quantity numeric(24,8),
    remaining_quantity numeric(24,8),
    opened_at timestamptz,
    opened_on date,
    depleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    CONSTRAINT preserve_container_quantity_state CHECK (
        (initial_quantity IS NULL AND remaining_quantity IS NULL AND depleted_at IS NULL)
        OR
        (initial_quantity IS NOT NULL AND initial_quantity >= 0
         AND remaining_quantity IS NOT NULL AND remaining_quantity >= 0
         AND remaining_quantity <= initial_quantity
         AND ((remaining_quantity = 0) = (depleted_at IS NOT NULL)))
    ),
    CONSTRAINT preserve_container_opening_state CHECK ((opened_at IS NULL) = (opened_on IS NULL))
);

-- Every preserve created before v9 becomes one physical legacy package, so it can
-- immediately participate in opening, consumption and cooking workflows.
INSERT INTO meal.preserve_containers(
    id,
    preserve_id,
    label,
    initial_quantity,
    remaining_quantity,
    opened_at,
    opened_on,
    depleted_at,
    created_at,
    updated_at
)
SELECT
    (
        substr(md5(pd.id::text || ':legacy-container'), 1, 8) || '-' ||
        substr(md5(pd.id::text || ':legacy-container'), 9, 4) || '-' ||
        '5' || substr(md5(pd.id::text || ':legacy-container'), 14, 3) || '-' ||
        '8' || substr(md5(pd.id::text || ':legacy-container'), 18, 3) || '-' ||
        substr(md5(pd.id::text || ':legacy-container'), 21, 12)
    )::uuid,
    pd.id,
    'Упаковка 1',
    CASE WHEN b.quantity_known THEN b.quantity ELSE NULL END,
    CASE WHEN b.quantity_known THEN b.quantity ELSE NULL END,
    b.opened_at,
    CASE WHEN b.opened_at IS NOT NULL THEN (b.opened_at AT TIME ZONE 'UTC')::date ELSE NULL END,
    CASE WHEN b.quantity_known AND b.quantity = 0 THEN COALESCE(b.opened_at, pd.created_at) ELSE NULL END,
    pd.created_at,
    pd.created_at
FROM meal.preserve_details pd
JOIN meal.inventory_batches b ON b.id = pd.batch_id;

CREATE INDEX ix_preserve_containers_preserve ON meal.preserve_containers(preserve_id, created_at, id);

ALTER TABLE meal.cooking_inputs
    ADD COLUMN container_id uuid REFERENCES meal.preserve_containers(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION meal.protect_preserve_container_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id <> OLD.id OR NEW.preserve_id <> OLD.preserve_id OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'preserve container identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.opened_at IS NOT NULL
       AND (NEW.opened_at IS DISTINCT FROM OLD.opened_at OR NEW.opened_on IS DISTINCT FROM OLD.opened_on) THEN
        RAISE EXCEPTION 'preserve container opening event is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION meal.protect_preserve_recipe_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.recipe_revision_id IS NOT NULL
       AND NEW.recipe_revision_id IS DISTINCT FROM OLD.recipe_revision_id THEN
        RAISE EXCEPTION 'preserve recipe provenance is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION meal.check_cooking_preserve_container() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE linked_batch uuid;
BEGIN
    IF NEW.container_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT pd.batch_id INTO linked_batch
    FROM meal.preserve_containers pc
    JOIN meal.preserve_details pd ON pd.id = pc.preserve_id
    WHERE pc.id = NEW.container_id;
    IF linked_batch IS DISTINCT FROM NEW.batch_id THEN
        RAISE EXCEPTION 'cooking input container must belong to its batch' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER require_serializable
BEFORE INSERT OR UPDATE OR DELETE ON meal.preserve_containers
FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();

CREATE TRIGGER protect_identity
BEFORE UPDATE ON meal.preserve_containers
FOR EACH ROW EXECUTE FUNCTION meal.protect_preserve_container_identity();

CREATE TRIGGER protect_recipe_link
BEFORE UPDATE ON meal.preserve_details
FOR EACH ROW EXECUTE FUNCTION meal.protect_preserve_recipe_link();

CREATE CONSTRAINT TRIGGER cooking_preserve_container_link
AFTER INSERT OR UPDATE ON meal.cooking_inputs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION meal.check_cooking_preserve_container();

COMMENT ON COLUMN meal.preserve_details.created_on IS 'User-local calendar date when the preserve was made; timestamps remain UTC.';
COMMENT ON COLUMN meal.preserve_details.ingredients_snapshot IS 'Validated ingredient labels and optional catalog references captured when the preserve is created.';
COMMENT ON TABLE meal.preserve_containers IS 'Physical jars or packages inside one preserve batch. Opening is an immutable per-container event; remaining quantity may be unknown.';
COMMENT ON COLUMN meal.preserve_containers.opened_on IS 'User-local calendar date of first opening, retained for chronology checks.';
COMMENT ON COLUMN meal.cooking_inputs.container_id IS 'Selected physical preserve container when a cooking input consumes a preserve batch.';
