CREATE TABLE meal.allergen_icons (
  id uuid PRIMARY KEY,
  allergen_id uuid NOT NULL UNIQUE REFERENCES meal.allergens(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  state text NOT NULL CHECK(state IN ('fallback','ready','unavailable','rejected')),
  fallback_key text NOT NULL,
  alt_text text NOT NULL,
  asset_id uuid REFERENCES meal.media_assets(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  updated_by uuid NOT NULL REFERENCES meal.users(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  CONSTRAINT ck_allergen_icons_asset CHECK((state='ready' AND asset_id IS NOT NULL) OR (state<>'ready' AND asset_id IS NULL))
);

CREATE TABLE meal.allergen_mappings (
  id uuid PRIMARY KEY,
  allergen_id uuid NOT NULL REFERENCES meal.allergens(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  ingredient_id uuid REFERENCES meal.ingredients(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  variant_id uuid REFERENCES meal.ingredient_variants(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  product_id uuid REFERENCES meal.brand_products(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  status text NOT NULL CHECK(status IN ('contains','may_contain','unknown')),
  source text NOT NULL,
  created_by uuid NOT NULL REFERENCES meal.users(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  CONSTRAINT ck_allergen_mappings_subject CHECK(num_nonnulls(ingredient_id,variant_id,product_id)=1)
);
CREATE UNIQUE INDEX uq_allergen_mappings_active_ingredient ON meal.allergen_mappings(allergen_id,ingredient_id) WHERE ingredient_id IS NOT NULL AND removed_at IS NULL;
CREATE UNIQUE INDEX uq_allergen_mappings_active_variant ON meal.allergen_mappings(allergen_id,variant_id) WHERE variant_id IS NOT NULL AND removed_at IS NULL;
CREATE UNIQUE INDEX uq_allergen_mappings_active_product ON meal.allergen_mappings(allergen_id,product_id) WHERE product_id IS NOT NULL AND removed_at IS NULL;
CREATE INDEX ix_allergen_mappings_ingredient ON meal.allergen_mappings(ingredient_id) WHERE removed_at IS NULL;
CREATE INDEX ix_allergen_mappings_variant ON meal.allergen_mappings(variant_id) WHERE removed_at IS NULL;
CREATE INDEX ix_allergen_mappings_product ON meal.allergen_mappings(product_id) WHERE removed_at IS NULL;

CREATE TABLE meal.allergen_reports (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES meal.users(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  recipe_id uuid NOT NULL REFERENCES meal.recipes(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  revision_id uuid NOT NULL REFERENCES meal.recipe_revisions(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  unknown_ingredient_ids jsonb NOT NULL,
  note text NOT NULL,
  ticket_id uuid NOT NULL REFERENCES meal.support_tickets(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK(version>0)
);
COMMENT ON TABLE meal.allergen_mappings IS 'Admin-managed derived allergen dictionary; explicit immutable composition evidence remains authoritative and is never overwritten';
COMMENT ON TABLE meal.allergen_reports IS 'User report links only recipe revision and selected unknown recipe ingredients; personal allergen preferences are never copied';
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.allergen_icons FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.allergen_mappings FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.allergen_reports FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER protect_identity BEFORE UPDATE ON meal.allergen_icons FOR EACH ROW EXECUTE FUNCTION meal.protect_scope_and_identity();
CREATE TRIGGER protect_identity BEFORE UPDATE ON meal.allergen_mappings FOR EACH ROW EXECUTE FUNCTION meal.protect_scope_and_identity();
CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON meal.allergen_reports FOR EACH ROW EXECUTE FUNCTION meal.reject_mutation();
