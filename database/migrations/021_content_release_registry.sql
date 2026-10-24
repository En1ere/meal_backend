-- Prepared only. Applying this migration requires the separately approved transfer procedure.
ALTER TABLE meal.content_release_patches DROP CONSTRAINT ck_content_release_patches_type;
ALTER TABLE meal.content_release_patches
  ADD CONSTRAINT ck_content_release_patches_type
  CHECK (resource_type IN ('achievement','reputation_title','legal_text','product_description','content_document','dictionary_entry'));

ALTER TABLE meal.content_resource_heads DROP CONSTRAINT ck_content_resource_heads_type;
ALTER TABLE meal.content_resource_heads
  ADD CONSTRAINT ck_content_resource_heads_type
  CHECK (resource_type IN ('achievement','reputation_title','legal_text','product_description','content_document','dictionary_entry'));

COMMENT ON COLUMN meal.content_release_patches.resource_type IS 'Strict typed registry adapter; unknown resource types fail closed.';
COMMENT ON COLUMN meal.content_resource_heads.resource_type IS 'Canonical versioned head for a supported release registry resource.';
