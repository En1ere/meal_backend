-- Prepared only. Apply during the separately approved Linux transfer.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE meal.inventory_batches ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE meal.inventory_batches ADD CONSTRAINT inventory_metadata_object CHECK (jsonb_typeof(metadata) = 'object');
COMMENT ON COLUMN meal.inventory_batches.metadata IS 'Inventory transport metadata: pricePaidRub decimal string/null, storeName string/null, quantitySource enum, confidence number/null. No credentials or OCR raw payload.';
