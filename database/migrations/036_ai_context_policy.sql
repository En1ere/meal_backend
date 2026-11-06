-- Versioned AI context-source policy. Historical rule rows remain immutable.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

INSERT INTO meal.ai_rule_versions(id,kind,version,config,effective_at)
VALUES(
  '00000000-0000-4000-8000-00000000a136'::uuid,
  'context',
  1,
  '{
    "contextVersion":"ai-context-v1",
    "maximumInventoryItems":50,
    "sources":["user_prompt","personal_inventory","preferences","nutrition_profile"],
    "tasks":{
      "culinary_question":{"required":[],"optional":["preferences"]},
      "recipe_from_stock":{"required":["personal_inventory"],"optional":["preferences"]},
      "substitution":{"required":[],"optional":["personal_inventory","preferences"]},
      "storage_advice":{"required":[],"optional":["personal_inventory"]},
      "meal_plan_generation":{"required":[],"optional":["personal_inventory","preferences","nutrition_profile"]},
      "shopping_list_generation":{"required":[],"optional":["personal_inventory","preferences"]},
      "registry_analysis":{"required":["personal_inventory"],"optional":["preferences"]},
      "personal_recommendation":{"required":["preferences"],"optional":["personal_inventory","nutrition_profile"]},
      "nutrition_calculation":{"required":[],"optional":["preferences","nutrition_profile"]},
      "product_classification":{"required":[],"optional":[]},
      "ingredient_extraction":{"required":[],"optional":[]},
      "review_summary":{"required":[],"optional":[]},
      "beverage_pairing":{"required":[],"optional":["preferences"]},
      "event_menu":{"required":[],"optional":["preferences"]},
      "portion_cost_calculation":{"required":[],"optional":[]},
      "seasonal_analysis":{"required":[],"optional":[]},
      "recipe_adaptation":{"required":[],"optional":["personal_inventory","preferences"]},
      "document_analysis":{"required":[],"optional":[]}
    }
  }'::jsonb,
  '2026-11-06T00:00:00Z'::timestamptz
);
