-- Additive AI policy v4 identity and provider-cost evidence. Legacy v3 runtime remains executable.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

INSERT INTO meal.ai_rule_versions(id,kind,version,config,effective_at)
VALUES(
  '00000000-0000-4000-8000-00000000a139'::uuid,
  'cost',
  4,
  '{
    "taskPolicyVersion":"ai-task-policy-v4",
    "routingPolicyVersion":"ai-routing-policy-v1",
    "pricePolicyVersion":"ai-price-policy-v1",
    "resultContractVersion":"ai-result-contract-v2",
    "safetyPolicyVersion":"ai-safety-policy-v1",
    "cachePolicyVersion":"ai-cache-policy-v1",
    "previewTtlSeconds":600,
    "profiles":{
      "economy":{"version":"yandex-alice-flash-economy-v1","maxInputBytes":24576,"maxOutputTokens":1000,"fallback":null},
      "balanced":{"version":"yandexgpt-5.1-balanced-v1","maxInputBytes":49152,"maxOutputTokens":2000,"fallback":null}
    },
    "taskModes":[
      ["culinary_question","answer","free","economy",1],
      ["substitution","candidates","free","backend",0],
      ["substitution","explain","free","economy",1],
      ["storage_advice","rule","free","backend",0],
      ["storage_advice","explain","free","economy",1],
      ["ingredient_extraction","extract","free","economy",1],
      ["product_classification","candidates","free","backend",0],
      ["product_classification","classify","free","economy",1],
      ["recipe_from_stock","select_existing","free","backend",0],
      ["recipe_from_stock","generate_new","free","balanced",2],
      ["personal_recommendation","weekly","free","backend",0],
      ["beverage_pairing","catalog","free","backend",0],
      ["beverage_pairing","custom","free","economy",1],
      ["recipe_adaptation","scale","free","backend",0],
      ["recipe_adaptation","adapt","free","balanced",2],
      ["registry_analysis","facts","free","backend",0],
      ["registry_analysis","explain","free","economy",1],
      ["review_summary","public_summary","free","economy",0],
      ["shopping_list_generation","from_recipes","plus","backend",0],
      ["shopping_list_generation","from_meal_plan","plus","backend",0],
      ["meal_plan_generation","generate","plus","balanced",4],
      ["meal_plan_generation","replace_slot","plus","balanced",0],
      ["event_menu","generate","plus","balanced",3],
      ["nutrition_calculation","calculate","pro","backend",0],
      ["nutrition_calculation","explain","pro","economy",1],
      ["portion_cost_calculation","calculate","pro","backend",0],
      ["portion_cost_calculation","explain","pro","economy",1],
      ["seasonal_analysis","disabled",null,"disabled",null],
      ["document_analysis","disabled",null,"disabled",null]
    ]
  }'::jsonb,
  '2026-11-09T00:00:00Z'::timestamptz
),(
  '00000000-0000-4000-8000-00000000c139'::uuid,
  'context',
  2,
  '{
    "contextVersion":"ai-context-policy-v2",
    "selection":"server_offer_ids_only",
    "maximumSelectedSources":16,
    "sharedCachePersonalDataAllowed":false,
    "categories":[
      "user_prompt","personal_profile","preferences","dietary_restrictions","personal_inventory",
      "family_inventory","owned_recipe","public_recipe_catalog","meal_plan","shopping_list",
      "nutrition_profile","nutrition_targets","diary_summary","price_observations","finance_summary",
      "bounded_public_reviews","owned_document_extract","seasonality_dataset"
    ]
  }'::jsonb,
  '2026-11-09T00:00:00Z'::timestamptz
),(
  '00000000-0000-4000-8000-00000000b139'::uuid,
  'routing',1,
  '{"routingPolicyVersion":"ai-routing-policy-v1","routes":["backend","economy","balanced"],"automaticFallback":false}'::jsonb,
  '2026-11-09T00:00:00Z'::timestamptz
),(
  '00000000-0000-4000-8000-00000000d139'::uuid,
  'price',1,
  '{"pricePolicyVersion":"ai-price-policy-v1","currency":"RUB","backendCost":0,"actionCostRange":[0,4]}'::jsonb,
  '2026-11-09T00:00:00Z'::timestamptz
),(
  '00000000-0000-4000-8000-00000000e139'::uuid,
  'result',2,
  '{"resultContractVersion":"ai-result-contract-v2","envelope":["schemaVersion","data","warningCodes"],"additionalProperties":false}'::jsonb,
  '2026-11-09T00:00:00Z'::timestamptz
),(
  '00000000-0000-4000-8000-00000000f139'::uuid,
  'safety',1,
  '{"safetyPolicyVersion":"ai-safety-policy-v1","backendVerdictsAuthoritative":true,"directDomainMutation":false}'::jsonb,
  '2026-11-09T00:00:00Z'::timestamptz
),(
  '00000000-0000-4000-8000-00000000a239'::uuid,
  'cache',1,
  '{"cachePolicyVersion":"ai-cache-policy-v1","sharedPersonalDataAllowed":false,"semanticPromptCacheAllowed":false}'::jsonb,
  '2026-11-09T00:00:00Z'::timestamptz
);

ALTER TABLE meal.ai_tasks
  ADD COLUMN contract_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN task_code varchar(64),
  ADD COLUMN task_mode varchar(64),
  ADD COLUMN execution_route varchar(16),
  ADD COLUMN task_policy_version varchar(64),
  ADD COLUMN context_policy_version varchar(64),
  ADD COLUMN routing_policy_version varchar(64),
  ADD COLUMN price_policy_version varchar(64),
  ADD COLUMN result_schema_version varchar(160),
  ADD COLUMN safety_policy_version varchar(64),
  ADD COLUMN cache_policy_version varchar(64),
  ADD COLUMN provider_profile_version varchar(64),
  ADD COLUMN provider_cost_ceiling_minor integer;

ALTER TABLE meal.ai_tasks
  ADD CONSTRAINT ck_ai_tasks_contract_version CHECK(contract_version IN(1,2)),
  ADD CONSTRAINT ck_ai_tasks_v2_presence CHECK(
    (contract_version=1 AND task_code IS NULL AND task_mode IS NULL AND execution_route IS NULL
      AND task_policy_version IS NULL AND context_policy_version IS NULL AND routing_policy_version IS NULL
      AND price_policy_version IS NULL AND result_schema_version IS NULL AND safety_policy_version IS NULL
      AND cache_policy_version IS NULL AND provider_profile_version IS NULL AND provider_cost_ceiling_minor IS NULL)
    OR
    (contract_version=2 AND task_code IS NOT NULL AND task_mode IS NOT NULL AND execution_route IS NOT NULL
      AND task_policy_version='ai-task-policy-v4' AND context_policy_version='ai-context-policy-v2'
      AND routing_policy_version='ai-routing-policy-v1' AND price_policy_version='ai-price-policy-v1'
      AND result_schema_version LIKE 'ai-result-contract-v2:%' AND safety_policy_version='ai-safety-policy-v1'
      AND cache_policy_version='ai-cache-policy-v1' AND provider_cost_ceiling_minor IS NOT NULL
      AND accepted_cost BETWEEN 0 AND 4)
  ),
  ADD CONSTRAINT ck_ai_tasks_task_code CHECK(task_code IS NULL OR task_code IN(
      'culinary_question','recipe_from_stock','substitution','storage_advice','meal_plan_generation',
      'shopping_list_generation','registry_analysis','personal_recommendation','nutrition_calculation',
      'product_classification','ingredient_extraction','review_summary','beverage_pairing','event_menu',
      'portion_cost_calculation','seasonal_analysis','recipe_adaptation','document_analysis'
    )),
  ADD CONSTRAINT ck_ai_tasks_task_mode CHECK(task_mode IS NULL OR task_mode ~ '^[a-z][a-z0-9_]{1,63}$'),
  ADD CONSTRAINT ck_ai_tasks_task_mode_pair CHECK(
    task_mode IS NULL OR (task_code,task_mode) IN(
      ('culinary_question','answer'),('substitution','candidates'),('substitution','explain'),
      ('storage_advice','rule'),('storage_advice','explain'),('ingredient_extraction','extract'),
      ('product_classification','candidates'),('product_classification','classify'),
      ('recipe_from_stock','select_existing'),('recipe_from_stock','generate_new'),
      ('personal_recommendation','weekly'),('beverage_pairing','catalog'),('beverage_pairing','custom'),
      ('recipe_adaptation','scale'),('recipe_adaptation','adapt'),('registry_analysis','facts'),
      ('registry_analysis','explain'),('review_summary','public_summary'),
      ('shopping_list_generation','from_recipes'),('shopping_list_generation','from_meal_plan'),
      ('meal_plan_generation','generate'),('meal_plan_generation','replace_slot'),('event_menu','generate'),
      ('nutrition_calculation','calculate'),('nutrition_calculation','explain'),
      ('portion_cost_calculation','calculate'),('portion_cost_calculation','explain')
    )
  ),
  ADD CONSTRAINT ck_ai_tasks_v2_route CHECK(
    contract_version=1 OR execution_route IN('backend','economy','balanced')
  ),
  ADD CONSTRAINT ck_ai_tasks_v2_profile CHECK(
    contract_version=1
    OR (execution_route='backend' AND provider_profile_version IS NULL AND provider_cost_ceiling_minor=0)
    OR (execution_route='economy' AND provider_profile_version='yandex-alice-flash-economy-v1' AND provider_cost_ceiling_minor BETWEEN 0 AND 100)
    OR (execution_route='balanced' AND provider_profile_version='yandexgpt-5.1-balanced-v1' AND provider_cost_ceiling_minor BETWEEN 0 AND 1200)
  );

CREATE FUNCTION meal.prepare_ai_task_contract_v2() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (
    NEW.contract_version IS DISTINCT FROM OLD.contract_version
    OR NEW.task_code IS DISTINCT FROM OLD.task_code OR NEW.task_mode IS DISTINCT FROM OLD.task_mode
    OR NEW.execution_route IS DISTINCT FROM OLD.execution_route
    OR NEW.task_policy_version IS DISTINCT FROM OLD.task_policy_version
    OR NEW.context_policy_version IS DISTINCT FROM OLD.context_policy_version
    OR NEW.routing_policy_version IS DISTINCT FROM OLD.routing_policy_version
    OR NEW.price_policy_version IS DISTINCT FROM OLD.price_policy_version
    OR NEW.result_schema_version IS DISTINCT FROM OLD.result_schema_version
    OR NEW.safety_policy_version IS DISTINCT FROM OLD.safety_policy_version
    OR NEW.cache_policy_version IS DISTINCT FROM OLD.cache_policy_version
    OR NEW.provider_profile_version IS DISTINCT FROM OLD.provider_profile_version
    OR NEW.provider_cost_ceiling_minor IS DISTINCT FROM OLD.provider_cost_ceiling_minor
  ) THEN
    RAISE EXCEPTION 'AI task contract identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER prepare_contract_v2 BEFORE INSERT OR UPDATE ON meal.ai_tasks
  FOR EACH ROW EXECUTE FUNCTION meal.prepare_ai_task_contract_v2();

ALTER TABLE meal.ai_operations
  DROP CONSTRAINT ck_ai_operations_contract_version,
  DROP CONSTRAINT ck_ai_operations_financial_state,
  ALTER COLUMN provider_profile_version DROP NOT NULL,
  ADD COLUMN execution_route varchar(16),
  ADD COLUMN routing_policy_version varchar(64),
  ADD COLUMN price_policy_version varchar(64),
  ADD COLUMN result_schema_version varchar(160),
  ADD COLUMN safety_policy_version varchar(64),
  ADD COLUMN cache_policy_version varchar(64),
  ADD COLUMN provider_cost_state varchar(24),
  ADD COLUMN provider_cost_currency char(3);

ALTER TABLE meal.ai_operations
  ADD CONSTRAINT ck_ai_operations_contract_version CHECK(contract_version IN (0,1,2)),
  ADD CONSTRAINT ck_ai_operations_financial_state CHECK(
    (lifecycle_state IN ('accepted','queued','running') AND financial_state IN ('none','reserved'))
    OR (lifecycle_state='unknown' AND financial_state IN ('none','released','reconciliation_hold'))
    OR (lifecycle_state='succeeded' AND financial_state IN ('none','captured'))
    OR (lifecycle_state IN ('failed','cancelled') AND financial_state IN ('none','released'))
  ),
  ADD CONSTRAINT ck_ai_operations_execution_route CHECK(execution_route IS NULL OR execution_route IN('backend','economy','balanced')),
  ADD CONSTRAINT ck_ai_operations_v2_frozen_policy CHECK(
    (contract_version IN(0,1) AND execution_route IS NULL AND routing_policy_version IS NULL
      AND price_policy_version IS NULL AND result_schema_version IS NULL AND safety_policy_version IS NULL
      AND cache_policy_version IS NULL AND provider_cost_state IS NULL AND provider_cost_currency IS NULL) OR
    (contract_version=2 AND execution_route IN('backend','economy','balanced')
      AND task_policy_version='ai-task-policy-v4'
      AND context_manifest_version='ai-context-policy-v2'
      AND routing_policy_version='ai-routing-policy-v1'
      AND price_policy_version='ai-price-policy-v1'
      AND safety_policy_version='ai-safety-policy-v1'
      AND cache_policy_version='ai-cache-policy-v1'
      AND result_schema_version LIKE 'ai-result-contract-v2:%')
  ),
  ADD CONSTRAINT ck_ai_operations_v2_provider_profile CHECK(
    contract_version<>2
    OR (execution_route='backend' AND provider_profile_version IS NULL)
    OR (execution_route='economy' AND provider_profile_version='yandex-alice-flash-economy-v1')
    OR (execution_route='balanced' AND provider_profile_version='yandexgpt-5.1-balanced-v1')
  ),
  ADD CONSTRAINT ck_ai_operations_provider_cost_state CHECK(provider_cost_state IS NULL OR provider_cost_state IN('none','estimated_hold','actual','released')),
  ADD CONSTRAINT ck_ai_operations_provider_cost_currency CHECK(
    provider_cost_currency IS NULL OR provider_cost_currency ~ '^[A-Z]{3}$'
  ),
  ADD CONSTRAINT ck_ai_operations_v2_provider_cost CHECK(
    contract_version<>2 OR
    (execution_route='backend' AND provider_cost_state='none' AND provider_cost IS NULL AND provider_cost_currency IS NULL) OR
    (execution_route IN('economy','balanced') AND provider_cost_currency='RUB'
      AND ((provider_cost_state='none' AND provider_cost IS NULL)
        OR (provider_cost_state IN('estimated_hold','actual','released') AND provider_cost IS NOT NULL AND provider_cost>=0)))
  ),
  ADD CONSTRAINT ck_ai_operations_v2_unknown CHECK(
    contract_version<>2 OR lifecycle_state<>'unknown'
    OR (provider_request_id IS NULL AND financial_state='released' AND provider_cost_state='estimated_hold')
    OR (provider_request_id IS NOT NULL AND financial_state='reconciliation_hold')
  );

CREATE UNIQUE INDEX uq_ai_operations_user_idempotency_v2
  ON meal.ai_operations(user_id,idempotency_key)
  WHERE contract_version=2;

CREATE FUNCTION meal.prepare_ai_operation_contract_v2() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  frozen_task record;
BEGIN
  IF TG_OP='INSERT' AND NEW.contract_version=2 AND NEW.execution_route='backend' THEN
    NEW.provider_profile_version:=NULL;
  END IF;
  IF TG_OP='INSERT' AND NEW.contract_version=2 THEN
    SELECT execution_route,task_policy_version,context_policy_version,routing_policy_version,
           price_policy_version,result_schema_version,safety_policy_version,cache_policy_version,
           provider_profile_version
      INTO frozen_task
      FROM meal.ai_tasks WHERE id=NEW.task_id AND contract_version=2;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'AI operation task contract is unavailable' USING ERRCODE='23514';
    END IF;
    IF NEW.execution_route IS DISTINCT FROM frozen_task.execution_route
       OR NEW.task_policy_version IS DISTINCT FROM frozen_task.task_policy_version
       OR NEW.context_manifest_version IS DISTINCT FROM frozen_task.context_policy_version
       OR NEW.routing_policy_version IS DISTINCT FROM frozen_task.routing_policy_version
       OR NEW.price_policy_version IS DISTINCT FROM frozen_task.price_policy_version
       OR NEW.result_schema_version IS DISTINCT FROM frozen_task.result_schema_version
       OR NEW.safety_policy_version IS DISTINCT FROM frozen_task.safety_policy_version
       OR NEW.cache_policy_version IS DISTINCT FROM frozen_task.cache_policy_version
       OR NEW.provider_profile_version IS DISTINCT FROM frozen_task.provider_profile_version THEN
      RAISE EXCEPTION 'AI operation does not match its frozen task contract' USING ERRCODE='23514';
    END IF;
  ELSIF TG_OP='UPDATE' AND (
    NEW.execution_route IS DISTINCT FROM OLD.execution_route
    OR NEW.routing_policy_version IS DISTINCT FROM OLD.routing_policy_version
    OR NEW.price_policy_version IS DISTINCT FROM OLD.price_policy_version
    OR NEW.result_schema_version IS DISTINCT FROM OLD.result_schema_version
    OR NEW.safety_policy_version IS DISTINCT FROM OLD.safety_policy_version
    OR NEW.cache_policy_version IS DISTINCT FROM OLD.cache_policy_version
    OR NEW.provider_cost_currency IS DISTINCT FROM OLD.provider_cost_currency
  ) THEN
    RAISE EXCEPTION 'AI operation v2 identity is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NEW.contract_version=2 AND NEW.lifecycle_state='unknown'
     AND NEW.provider_request_id IS NULL AND NEW.provider_cost_state='estimated_hold' THEN
    NEW.financial_state:='released';
  END IF;
  IF TG_OP='UPDATE' AND OLD.contract_version=2 AND NOT (
    NEW.provider_cost_state=OLD.provider_cost_state
    OR (OLD.provider_cost_state='none' AND NEW.provider_cost_state IN('estimated_hold','actual','released'))
    OR (OLD.provider_cost_state='estimated_hold' AND NEW.provider_cost_state IN('actual','released'))
  ) THEN
    RAISE EXCEPTION 'invalid AI provider cost transition % -> %',OLD.provider_cost_state,NEW.provider_cost_state
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

-- Runs after prepare_lifecycle by trigger-name order and removes its legacy provider default for backend v2.
CREATE TRIGGER zz_prepare_contract_v2 BEFORE INSERT OR UPDATE ON meal.ai_operations
  FOR EACH ROW EXECUTE FUNCTION meal.prepare_ai_operation_contract_v2();

COMMENT ON COLUMN meal.ai_tasks.task_code IS 'Frozen task code for contract v2; legacy rows remain null and keep their original preview.';
COMMENT ON COLUMN meal.ai_tasks.task_mode IS 'Frozen task mode for contract v2; legacy rows keep both task identity columns null.';
COMMENT ON COLUMN meal.ai_operations.execution_route IS 'Frozen backend/economy/balanced route for contract v2; legacy rows remain null.';
COMMENT ON COLUMN meal.ai_operations.provider_cost_state IS 'Provider budget evidence independent from user action financial state.';
COMMENT ON COLUMN meal.ai_operations.provider_cost_currency IS 'Frozen provider-cost currency; RUB for v2 model routes and null for backend.';
