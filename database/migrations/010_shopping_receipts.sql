-- Prepared only. Apply after 002-009 during the separately approved Linux transfer.
-- The migration runner owns the SERIALIZABLE transaction and checksum verification.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE meal.shopping_items ADD COLUMN position integer NOT NULL DEFAULT 0 CHECK(position>=0), ADD COLUMN estimated_price_minor bigint CHECK(estimated_price_minor BETWEEN 0 AND 9007199254740991);
ALTER TABLE meal.shopping_lists ADD COLUMN archived_from text CHECK(archived_from IN ('active','completed'));
ALTER TABLE meal.receipts ADD COLUMN linked_purchase_id uuid REFERENCES meal.purchases(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX ix_shopping_lists_owner_cursor ON meal.shopping_lists(scope_id,created_at,id);
CREATE INDEX ix_shopping_items_position ON meal.shopping_items(list_id,position,id);
CREATE UNIQUE INDEX uq_stock_intakes_movement ON meal.stock_intakes(movement_id);
CREATE UNIQUE INDEX uq_receipt_purchase_once ON meal.purchases(receipt_id) WHERE receipt_id IS NOT NULL;
CREATE INDEX ix_receipts_linked_purchase ON meal.receipts(linked_purchase_id) WHERE linked_purchase_id IS NOT NULL;
ALTER TABLE meal.shopping_items ADD COLUMN origin_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(origin_snapshot)='array');
CREATE FUNCTION meal.protect_intaken_purchase_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM meal.stock_intakes WHERE purchase_line_id=OLD.id) AND (NEW.quantity IS DISTINCT FROM OLD.quantity OR NEW.unit_id IS DISTINCT FROM OLD.unit_id OR NEW.name IS DISTINCT FROM OLD.name OR NEW.is_food IS DISTINCT FROM OLD.is_food) THEN
 RAISE EXCEPTION 'purchase line already received into stock is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_intaken_line BEFORE UPDATE ON meal.purchase_lines FOR EACH ROW EXECUTE FUNCTION meal.protect_intaken_purchase_line();
ALTER TABLE meal.purchase_lines ADD COLUMN shopping_item_id uuid REFERENCES meal.shopping_items(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX ix_purchase_lines_shopping_item ON meal.purchase_lines(shopping_item_id) WHERE shopping_item_id IS NOT NULL;
CREATE FUNCTION meal.check_purchase_shopping_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM meal.purchase_lines pl JOIN meal.purchases p ON p.id=pl.purchase_id JOIN meal.shopping_items si ON si.id=pl.shopping_item_id JOIN meal.shopping_lists sl ON sl.id=si.list_id WHERE pl.id=NEW.id AND p.scope_id<>sl.scope_id) THEN
 RAISE EXCEPTION 'purchase and shopping scope mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER purchase_shopping_scope AFTER INSERT OR UPDATE ON meal.purchase_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal.check_purchase_shopping_scope();
CREATE FUNCTION meal.check_receipt_purchase_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.linked_purchase_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM meal.purchases p WHERE p.id=NEW.linked_purchase_id AND p.scope_id=NEW.scope_id) THEN
 RAISE EXCEPTION 'receipt and purchase scope mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER receipt_purchase_scope AFTER INSERT OR UPDATE OF linked_purchase_id,scope_id ON meal.receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal.check_receipt_purchase_scope();

COMMENT ON COLUMN meal.shopping_items.position IS 'Stable user-controlled order inside one shopping list.';
COMMENT ON COLUMN meal.shopping_items.estimated_price_minor IS 'Optional list-local estimate; it does not create financial history.';
COMMENT ON COLUMN meal.shopping_items.origin_snapshot IS 'Explicit recipe contribution snapshot; manual and purchased lines are not recalculated silently.';
COMMENT ON COLUMN meal.shopping_lists.archived_from IS 'Lifecycle state restored when an archived list is restored.';
COMMENT ON COLUMN meal.receipts.linked_purchase_id IS 'Existing purchase represented by this receipt; duplicate receipts may reference the same purchase without replacing its canonical source receipt.';
COMMENT ON COLUMN meal.purchase_lines.shopping_item_id IS 'Optional personal shopping need resolved by this purchased line.';
