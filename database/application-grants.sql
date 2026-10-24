-- Apply separately after reviewed restore + migrations 1-23. No owner/superuser privileges.
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
GRANT SELECT,INSERT ON meal.admin_session_unlocks TO meal_app;
GRANT SELECT ON meal.schema_migrations,meal.environment,meal.users,meal.password_credentials,
 meal.user_settings,meal.sessions,meal.auth_challenges,meal.mfa_factors,meal.mfa_recovery_codes,
 meal.staff_role_assignments,meal.staff_grants,meal.auth_rate_limits,
 meal.account_tokens,meal.account_email_changes,meal.account_devices TO meal_app;
GRANT INSERT ON meal.users,meal.password_credentials,meal.audit_events TO meal_app;
GRANT UPDATE (email_normalized,email_verified_at) ON meal.users TO meal_app;
GRANT UPDATE (display_name) ON meal.users TO meal_app;
GRANT INSERT ON meal.user_settings TO meal_app;
GRANT UPDATE (timezone,locale,theme,onboarding_state,preferences,version) ON meal.user_settings TO meal_app;
GRANT UPDATE (password_hash,changed_at,version) ON meal.password_credentials TO meal_app;
GRANT INSERT,UPDATE ON meal.sessions,meal.auth_challenges,meal.mfa_factors,meal.mfa_recovery_codes,
 meal.auth_rate_limits,meal.account_tokens,meal.account_email_changes,meal.account_devices TO meal_app;
-- Curated admin read projections; no credentials or private payloads in API responses.
GRANT SELECT ON meal.moderation_cases,meal.sanctions,meal.subscriptions,meal.billing_orders,
 meal.support_tickets,meal.brand_products,meal.announcements,meal.audit_events,
 meal.compensation_requests,meal.legal_requests,meal.background_jobs,
 meal.admin_error_events,meal.admin_metric_events,meal.notification_preferences,
 meal.idempotency_records TO meal_app;
GRANT INSERT ON meal.notification_preferences,meal.support_messages,meal.support_events,
 meal.idempotency_records TO meal_app;
-- Preview commits lock their idempotency record with SELECT ... FOR UPDATE.
GRANT UPDATE(status) ON meal.idempotency_records TO meal_app;
GRANT INSERT ON meal.admin_error_events,meal.admin_metric_events TO meal_app;
GRANT SELECT(id,body,author_id,created_at,ticket_id,internal,version) ON meal.support_messages TO meal_app;
GRANT SELECT(id,order_id,status,created_at) ON meal.payment_attempts TO meal_app;
GRANT UPDATE(enabled,timezone,quiet_hours,urgent_opt_in,version) ON meal.notification_preferences TO meal_app;
-- Reschedule only pending cooking notifications when their owner changes timezone.
GRANT UPDATE(available_at,version) ON meal.notifications TO meal_app;
GRANT UPDATE(status,closed_at,assignee_id,version) ON meal.support_tickets TO meal_app;
-- Curated related collections: exact selected and predicate columns.
GRANT SELECT(subscription_id,id,version,created_at,grant_kind,starts_at,ends_at,order_id,price_snapshot) ON meal.subscription_periods TO meal_app;
GRANT SELECT(subscription_id,id,version,created_at,kind,status,scheduled_at,applied_at,reason,actor_id,preview) ON meal.subscription_changes TO meal_app;
GRANT SELECT(subscription_id,id,version,created_at,reason,family_id,starts_at,ends_at,selected_at) ON meal.family_coverages TO meal_app;
GRANT SELECT(subscription_id,id,version,created_at,reason,starts_at,ends_at,extended_at,extended_by) ON meal.grace_incidents TO meal_app;
GRANT SELECT(quota_period_id,id,version,created_at,kind,granted,balance_projection,reserved_projection,expires_at) ON meal.ai_buckets TO meal_app;
GRANT SELECT(bucket_id,id,version,created_at,kind,delta,reserved_delta,recorded_at) ON meal.ai_ledger TO meal_app;
GRANT SELECT(id,subscription_id,family_coverage_id,starts_at,ends_at) ON meal.ai_quota_periods TO meal_app;
GRANT SELECT(order_id,id,version,created_at,provider,status,amount_minor) ON meal.payment_attempts TO meal_app;
GRANT SELECT(attempt_id,id,version,created_at,status,requested_at,requested_by,reason) ON meal.payment_reconciliations TO meal_app;
GRANT SELECT(attempt_id,id,version,created_at,status,amount_minor,requested_by,reason) ON meal.payment_refunds TO meal_app;
GRANT SELECT(order_id,id,version,created_at,kind,issued_at,amount_minor) ON meal.billing_documents TO meal_app;
GRANT SELECT(recipe_id,id,version,created_at,title,revision,portions,method,change_kind,created_by) ON meal.recipe_revisions TO meal_app;
GRANT SELECT(proposal_id,id,version,created_at,revision,author_id) ON meal.catalog_proposal_revisions TO meal_app;
GRANT SELECT(recipe_revision_id,catalog_proposal_revision_id,assigned_to) ON meal.moderation_cases TO meal_app;
GRANT SELECT(case_id,id,version,created_at,action,reason,decided_at,actor_id) ON meal.moderation_decisions TO meal_app;
GRANT SELECT(case_id,id,version,created_at,outcome,staff_id,claimed_at,lease_until,released_at) ON meal.moderation_claims TO meal_app;
GRANT SELECT(id,version,created_at,name,status,ingredient_id) ON meal.ingredient_variants TO meal_app;
GRANT SELECT(id,variant_id) ON meal.brand_products TO meal_app;
GRANT SELECT(product_id,id,version,created_at,code,format,verified_at) ON meal.product_barcodes TO meal_app;
GRANT SELECT(product_id,id,version,created_at,revision,composition_text,kcal,protein,fat,carbs,basis_quantity,basis_unit_id,source,confidence) ON meal.composition_versions TO meal_app;
GRANT SELECT(source_product_id,target_product_id,id,version,created_at,kind,status,reason,applied_at,actor_id) ON meal.catalog_merges TO meal_app;
GRANT SELECT(announcement_id,id,version,created_at,kind,status,scheduled_at,created_by) ON meal.mail_campaigns TO meal_app;
GRANT SELECT(campaign_id,notification_id,id,version,created_at,channel,status,scheduled_at,sent_at,attempt_no) ON meal.notification_deliveries TO meal_app;
GRANT SELECT(id,announcement_id) ON meal.notifications TO meal_app;
GRANT SELECT(user_id,id,version,created_at,role,assigned_at,revoked_at,assigned_by) ON meal.staff_role_assignments TO meal_app;
GRANT SELECT(user_id,id,version,created_at,permission,scope,valid_until,revoked_at,granted_by) ON meal.staff_grants TO meal_app;
GRANT SELECT(user_id,kind,id,version,created_at,auth_context,authenticated_at,mfa_verified_at,expires_at,revoked_at) ON meal.sessions TO meal_app;
GRANT SELECT(request_id,id,version,created_at,kind,status,completed_at,approved_by) ON meal.legal_request_steps TO meal_app;
GRANT SELECT(request_id,id,version,created_at,status,source_event_id,result_event_id,dependency_snapshot,result) ON meal.compensation_items TO meal_app;
GRANT UPDATE(status,result,result_event_id,version) ON meal.compensation_items TO meal_app;
GRANT UPDATE(status,reason,applied_at,version) ON meal.compensation_requests TO meal_app;
GRANT SELECT(job_id,id,version,created_at,attempt_no,started_at,finished_at) ON meal.job_attempts TO meal_app;
GRANT SELECT(ticket_id,id,version,created_at,kind,recorded_at,actor_id,reason,before_snapshot,after_snapshot) ON meal.support_events TO meal_app;
GRANT EXECUTE ON FUNCTION meal.link_value(jsonb,text,text,text) TO meal_app;
GRANT SELECT(id,version,created_at,status,body,submitted_at,resolved_at,decision,user_id,sanction_id,ticket_id) ON meal.appeals TO meal_app;
GRANT INSERT ON meal.appeals TO meal_app;
-- Personal inventory and author-private catalog proposals (v6). No DELETE privileges.
GRANT SELECT ON meal.data_scopes,meal.units,meal.categories,meal.ingredients,
 meal.ingredient_categories,meal.ingredient_variants,meal.brands,meal.brand_products,
 meal.product_barcodes,meal.composition_versions,meal.allergens,meal.composition_allergens,
 meal.catalog_proposals,meal.catalog_proposal_revisions,meal.inventory_batches,
 meal.storage_locations,meal.inventory_operations,meal.inventory_movements TO meal_app;
GRANT INSERT ON meal.data_scopes,meal.storage_locations,meal.inventory_batches,
 meal.inventory_operations,meal.inventory_movements,meal.ingredients,meal.ingredient_variants,
 meal.brands,meal.brand_products,meal.product_barcodes,meal.composition_versions,
 meal.composition_allergens,meal.catalog_proposals,meal.catalog_proposal_revisions,
 meal.moderation_cases TO meal_app;
GRANT UPDATE(name,version) ON meal.storage_locations TO meal_app;
GRANT UPDATE(name,quantity,quantity_known,unit_id,location_id,precision,package_state,
 opened_at,purchased_on,expiry_on,barcode_snapshot,archived_at,metadata,version)
 ON meal.inventory_batches TO meal_app;
-- Recipe public read projections and user-owned bookmark desired-state commands (v7).
GRANT SELECT ON meal.recipes,meal.recipe_revisions,meal.recipe_publications,
 meal.recipe_ingredients,meal.recipe_steps,meal.recipe_ratings,meal.recipe_comments,
 meal.recipe_bookmarks,meal.cooking_outputs,meal.cooking_attempts TO meal_app;
GRANT INSERT ON meal.recipe_bookmarks TO meal_app;
GRANT UPDATE(removed_at,version) ON meal.recipe_bookmarks TO meal_app;
-- v8 personal authoring, community, cooking, shopping and audited policy.
GRANT SELECT ON meal.recipe_policy,meal.recipe_action_events,meal.comment_revisions,
 meal.cooking_steps,meal.cooking_inputs,meal.shopping_lists,meal.shopping_items,meal.notifications TO meal_app;
GRANT INSERT ON meal.recipe_action_events,meal.recipes,meal.recipe_revisions,meal.recipe_ingredients,
 meal.recipe_steps,meal.recipe_ratings,meal.recipe_comments,meal.comment_revisions,meal.notifications,meal.moderation_decisions,
 meal.cooking_attempts,meal.cooking_steps,meal.cooking_inputs,meal.cooking_outputs,
 meal.shopping_lists,meal.shopping_items TO meal_app;
GRANT UPDATE(submission_daily_limit,comment_hourly_limit,report_daily_limit,version,updated_at) ON meal.recipe_policy TO meal_app;
GRANT UPDATE(title,status,archived_at,version) ON meal.recipes TO meal_app;
GRANT UPDATE(unpublished_at,version) ON meal.recipe_publications TO meal_app;
GRANT UPDATE(body,edited_at,removed_at,version) ON meal.recipe_comments TO meal_app;
GRANT UPDATE ON meal.cooking_attempts,meal.cooking_steps,meal.shopping_lists,meal.shopping_items TO meal_app;
-- v9 personal preserves. No DELETE and no QR issuance on the Free tier.
GRANT SELECT ON meal.preserve_details,meal.preserve_containers TO meal_app;
GRANT INSERT ON meal.preserve_details,meal.preserve_containers TO meal_app;
GRANT SELECT,INSERT,UPDATE ON meal.qr_labels TO meal_app;
GRANT UPDATE(type,created_on,shelf_life_days,volume_per_unit,notes,tags,ingredients_snapshot,recipe_revision_id,version)
 ON meal.preserve_details TO meal_app;
GRANT UPDATE(label,initial_quantity,remaining_quantity,opened_at,opened_on,depleted_at,updated_at,version)
 ON meal.preserve_containers TO meal_app;
-- v10 personal shopping purchases and photo receipts. No finance tables and no DELETE privileges.
GRANT SELECT ON meal.shopping_allocations,meal.receipts,meal.receipt_lines,
 meal.purchases,meal.purchase_lines,meal.stock_intakes,meal.stores TO meal_app;
GRANT INSERT ON meal.shopping_allocations,meal.receipts,meal.receipt_lines,
 meal.purchases,meal.purchase_lines,meal.stock_intakes TO meal_app;
GRANT UPDATE(status,purchased_at,raw_review_snapshot,linked_purchase_id,version) ON meal.receipts TO meal_app;
GRANT UPDATE(receipt_id,version) ON meal.purchases TO meal_app;
GRANT UPDATE(name,quantity,unit_id,version) ON meal.purchase_lines TO meal_app;
-- Pro finance stage 5: private manual expenses and overall budgets only.
GRANT SELECT,INSERT ON meal.expenses,meal.budgets TO meal_app;
GRANT UPDATE(kind,amount_minor,occurred_at,version) ON meal.expenses TO meal_app;
GRANT UPDATE(amount_minor,starts_on,ends_on,version) ON meal.budgets TO meal_app;

-- Pro finance stage 6: private manual price observations and read-only approved aggregates.
GRANT SELECT,INSERT ON meal.price_observations TO meal_app;
GRANT SELECT ON meal.price_aggregates TO meal_app;
-- Pro nutrition, diary and prepared-portion lifecycle. History/components stay append-only.
GRANT SELECT ON meal.nutrition_profiles,meal.nutrition_targets,meal.portion_proposals,
 meal.diary_entries,meal.diary_components TO meal_app;
GRANT INSERT ON meal.nutrition_profiles,meal.nutrition_targets,meal.portion_proposals,
 meal.diary_entries,meal.diary_components TO meal_app;
GRANT UPDATE(profile_data,version) ON meal.nutrition_profiles TO meal_app;
GRANT UPDATE(ends_on,version) ON meal.nutrition_targets TO meal_app;
GRANT UPDATE(state,decision_at,confirmation_method,version) ON meal.portion_proposals TO meal_app;
GRANT UPDATE(eaten_at,meal,note,state,version) ON meal.diary_entries TO meal_app;
  -- Meal plan: Free day/week and Plus ranges/rules with immutable revisions. Planning never consumes stock.
GRANT SELECT ON meal.meal_plans,meal.plan_revisions,meal.plan_rules,meal.plan_entries,meal.plan_portions,
 meal.stock_reservations,meal.shopping_contributions TO meal_app;
GRANT INSERT ON meal.meal_plans,meal.plan_revisions,meal.plan_rules,meal.plan_entries,meal.plan_portions,
 meal.stock_reservations,meal.shopping_contributions TO meal_app;
GRANT UPDATE(name,archived_at,version) ON meal.meal_plans TO meal_app;
GRANT UPDATE(status,version) ON meal.plan_revisions TO meal_app;
GRANT UPDATE(status,version) ON meal.stock_reservations TO meal_app;
-- AI execution: application may reserve/capture/release quota; ledger and rules stay append-only.
GRANT SELECT(id,user_id,family_id,quota_period_id,kind,granted,balance_projection,reserved_projection,expires_at,created_at,version)
 ON meal.ai_buckets TO meal_app;
GRANT SELECT ON meal.ai_rule_versions,meal.ai_conversations,meal.ai_tasks,meal.ai_intervals,meal.ai_messages,meal.ai_operations TO meal_app;
GRANT INSERT ON meal.ai_conversations,meal.ai_tasks,meal.ai_intervals,meal.ai_messages,meal.ai_operations,meal.ai_ledger TO meal_app;
GRANT UPDATE(title,archived_at,version) ON meal.ai_conversations TO meal_app;
GRANT UPDATE(status,accepted_at,version) ON meal.ai_tasks TO meal_app;
GRANT UPDATE(clarifications_used,status,version) ON meal.ai_intervals TO meal_app;
GRANT UPDATE(status,result_snapshot,started_at,finished_at,provider_cost,version) ON meal.ai_operations TO meal_app;
GRANT UPDATE(granted,balance_projection,reserved_projection,version) ON meal.ai_buckets TO meal_app;
GRANT SELECT,INSERT ON meal.ai_transfers,meal.ai_reserve_consents TO meal_app;
GRANT UPDATE(status,accepted_at,version) ON meal.ai_transfers TO meal_app;
-- v12 admin Free operations. Error events remain append-only; only lifecycle metadata is mutable.
GRANT SELECT,INSERT ON meal.admin_notification_settings,meal.admin_incident_states TO meal_app;
GRANT UPDATE(settings,updated_at,version) ON meal.admin_notification_settings TO meal_app;
GRANT UPDATE(status,ignored_until,reason,assigned_to,updated_at,version) ON meal.admin_incident_states TO meal_app;
-- v13 governance metadata for explicit categories and staff-only notes.
GRANT UPDATE(scope,starts_at,ends_at,reason,revoked_at,category,private_note,version) ON meal.sanctions TO meal_app;
GRANT INSERT ON meal.sanctions,meal.staff_role_assignments,meal.staff_grants,meal.support_tickets,
 meal.moderation_decisions,meal.recipe_publications,meal.catalog_merges TO meal_app;
GRANT UPDATE(revoked_at,version) ON meal.staff_role_assignments TO meal_app;
GRANT UPDATE(revoked_at) ON meal.staff_grants TO meal_app;
GRANT UPDATE(status,resolved_at,decision,version) ON meal.appeals TO meal_app;
GRANT UPDATE(body,version) ON meal.support_messages TO meal_app;
GRANT UPDATE(status,assigned_to,version) ON meal.moderation_cases TO meal_app;
GRANT INSERT,UPDATE(released_at,outcome,version) ON meal.moderation_claims TO meal_app;
GRANT INSERT ON meal.support_messages,meal.support_events TO meal_app;
GRANT UPDATE(name,status,version) ON meal.brand_products TO meal_app;
GRANT UPDATE(status,run_at,version) ON meal.background_jobs TO meal_app;
-- v24 shared operational leases. No DELETE and no access to arbitrary worker payloads.
GRANT SELECT,INSERT ON meal.worker_leases TO meal_app;
GRANT UPDATE(owner_id,lease_id,fencing_token,acquired_at,expires_at,updated_at,version)
 ON meal.worker_leases TO meal_app;
GRANT SELECT ON meal.legal_document_publications TO meal_app;
GRANT SELECT,INSERT ON meal.agreement_acceptance_events,meal.legal_acknowledgement_events,meal.legal_consent_events TO meal_app;
GRANT SELECT ON meal.media_assets,meal.media_variants,meal.media_links TO meal_app;
-- Plus iteration: entitlement reads and atomic family bootstrap. No billing mutation is granted.
GRANT SELECT ON meal.billing_products,meal.families,meal.family_profiles,meal.family_memberships,
 meal.family_slot_grants,meal.ownership_transfers TO meal_app;
GRANT INSERT ON meal.families,meal.family_profiles,meal.family_memberships,meal.family_coverages TO meal_app;
GRANT SELECT,INSERT ON meal.family_invitations TO meal_app;
GRANT UPDATE(token_hash,status,expires_at,approved_at,accepted_at,approved_by,accepted_membership_id,version)
 ON meal.family_invitations TO meal_app;
GRANT UPDATE(status,archived_at,owner_membership_id,version) ON meal.families TO meal_app;
-- Membership lifecycle: keep history, revoke leases and transfer ownership atomically; no DELETE privileges.
GRANT SELECT ON meal.family_access_leases TO meal_app;
GRANT INSERT ON meal.ownership_transfers TO meal_app;
GRANT UPDATE(status,accepted_at,applied_at,reason,version) ON meal.ownership_transfers TO meal_app;
GRANT UPDATE(left_at,version) ON meal.family_memberships TO meal_app;
GRANT UPDATE(name,archived_at,version) ON meal.family_profiles TO meal_app;
GRANT UPDATE(revoked_at,version) ON meal.family_access_leases TO meal_app;
GRANT UPDATE(ends_at,version) ON meal.family_coverages TO meal_app;
GRANT UPDATE(holder_id,version) ON meal.family_slot_grants TO meal_app;
GRANT UPDATE(fullscreen_seen_at,read_at,version) ON meal.notifications TO meal_app;
-- Family notes: immutable revision history; only checklist rows may be physically removed by an author edit.
GRANT SELECT ON meal.family_notes,meal.note_revisions,meal.note_items TO meal_app;
GRANT INSERT ON meal.family_notes,meal.note_revisions,meal.note_items TO meal_app;
GRANT UPDATE(title,body,format,archived_at,version) ON meal.family_notes TO meal_app;
GRANT UPDATE(position,text,checked,checked_at,checked_by,version) ON meal.note_items TO meal_app;
GRANT DELETE ON meal.note_items TO meal_app;
-- Plus family chat. Prepared only; apply together with migration 014 after transfer.
GRANT SELECT,INSERT ON meal.chat_threads,meal.chat_messages,meal.chat_revisions,meal.chat_reactions,
 meal.chat_receipts,meal.chat_pins,meal.chat_drafts,meal.chat_mentions,meal.user_hidden_objects TO meal_app;
GRANT UPDATE(body,edited_at,removed_for_all_at,version) ON meal.chat_messages TO meal_app;
GRANT UPDATE(unpinned_at,version) ON meal.chat_pins TO meal_app;
GRANT UPDATE(body,updated_at,version) ON meal.chat_drafts TO meal_app;
GRANT UPDATE(delivered_at,read_at,version) ON meal.chat_receipts TO meal_app;
GRANT DELETE ON meal.chat_mentions,meal.chat_reactions,meal.chat_drafts TO meal_app;
-- Monthly Plus quota is created lazily under a locked subscription/coverage source.
GRANT INSERT ON meal.ai_quota_periods,meal.ai_buckets TO meal_app;
-- PostgreSQL requires UPDATE privilege on at least one column of a relation
-- selected with FOR UPDATE. Family membership mutations lock the active quota
-- period without changing it; grant only the protected version column.
GRANT UPDATE(version) ON meal.ai_quota_periods TO meal_app;
-- Subscription settings v14: simulated Plus periods, one-time trial claims and scheduled downgrade.
GRANT SELECT,INSERT ON meal.trial_claims TO meal_app;
GRANT INSERT ON meal.subscriptions,meal.subscription_periods,meal.subscription_changes TO meal_app;
GRANT UPDATE(status,version) ON meal.subscriptions TO meal_app;
GRANT SELECT,INSERT ON meal.subscription_combinations,meal.combination_consents TO meal_app;
GRANT UPDATE(status,applied_at,result_subscription_id,version) ON meal.subscription_combinations TO meal_app;
GRANT SELECT(id,code,starts_at,expires_at,redeemed_at,user_id) ON meal.promotion_offers TO meal_app;
GRANT UPDATE(redeemed_at,version) ON meal.promotion_offers TO meal_app;
GRANT UPDATE(starts_at,ends_at,version) ON meal.subscription_periods TO meal_app;
GRANT UPDATE(version) ON meal.users TO meal_app;
-- An immediate account ban may transfer active family Plus to an eligible member; no period/payment rows change.
GRANT UPDATE(owner_id,auto_renew,version) ON meal.subscriptions TO meal_app;
-- Scheduled v22 sanction effects: durable worker state, without DELETE or arbitrary payload mutation.
GRANT SELECT,INSERT ON meal.scheduled_sanction_effects TO meal_app;
GRANT UPDATE(status,failure_reason,applied_at,version) ON meal.scheduled_sanction_effects TO meal_app;
-- Recommendation v16: append-only delivery feedback and reversible author follows.
GRANT SELECT,INSERT ON meal.recommendation_events,meal.recommendation_issuances TO meal_app;
GRANT UPDATE(surface,position,reason_codes,created_at,expires_at,version) ON meal.recommendation_issuances TO meal_app;
GRANT SELECT,INSERT ON meal.author_follows TO meal_app;
GRANT UPDATE(removed_at,version) ON meal.author_follows TO meal_app;
-- Allergen intelligence v17: admin dictionary, fallback icon metadata and user reports. Binary upload stays unavailable.
GRANT SELECT,INSERT ON meal.allergen_mappings,meal.allergen_icons,meal.allergen_reports TO meal_app;
GRANT UPDATE(removed_at,version) ON meal.allergen_mappings TO meal_app;
GRANT UPDATE(state,fallback_key,alt_text,asset_id,updated_by,version) ON meal.allergen_icons TO meal_app;
GRANT UPDATE(version) ON meal.allergens TO meal_app;
-- News publication v18: immutable content history and explicit authenticated read audit.
GRANT SELECT,INSERT ON meal.announcement_versions,meal.announcement_reads TO meal_app;
GRANT SELECT,INSERT ON meal.announcements,meal.mail_campaigns TO meal_app;
GRANT SELECT(user_id,revoked_at) ON meal.push_subscriptions TO meal_app;
GRANT UPDATE(kind,revision,pages,status,publish_at,version) ON meal.announcements TO meal_app;
GRANT UPDATE(status,scheduled_at,audience_snapshot,test_result,version) ON meal.mail_campaigns TO meal_app;
-- Privacy settings may inspect legal consent state and revoke an existing AI consent; enabling stays fail-closed.
GRANT SELECT ON meal.legal_documents,meal.user_consents TO meal_app;
GRANT UPDATE(withdrawn_at,version) ON meal.user_consents TO meal_app;
-- Atomic content releases v19. Publish/rollback are additionally protected by admin critical confirmation.
GRANT SELECT,INSERT ON meal.content_releases,meal.content_release_patches,meal.content_release_events,
 meal.content_resource_heads,meal.reputation_titles,meal.product_descriptions,meal.reputation_rule_versions TO meal_app;
GRANT UPDATE(name,status,revision,source_release_id,rolled_back_from_event_id,client_revision,client_checksum,published_by,published_at,updated_at,version)
 ON meal.content_releases TO meal_app;
GRANT DELETE ON meal.content_release_patches TO meal_app;
GRANT UPDATE(payload,retired,published_release_id,updated_at,version) ON meal.content_resource_heads TO meal_app;
GRANT UPDATE(threshold,title,published_release_id,updated_at,version) ON meal.reputation_titles TO meal_app;
GRANT UPDATE(description,published_release_id,updated_at,version) ON meal.product_descriptions TO meal_app;
GRANT SELECT,INSERT ON meal.achievement_rules,meal.achievement_awards,meal.reputation_events TO meal_app;
GRANT INSERT ON meal.legal_documents TO meal_app;
-- Privacy lifecycle v20. Protected archives remain unavailable without storage; irreversible account work stays gated.
GRANT SELECT,INSERT,UPDATE ON meal.user_critical_grants,meal.export_previews,meal.export_jobs TO meal_app;
GRANT SELECT ON meal.feature_rule_versions TO meal_app;
GRANT INSERT ON meal.legal_requests,meal.legal_request_steps TO meal_app;
GRANT UPDATE(status,retention_basis,approved_at,executed_at,handled_by,cancel_until,cancelled_at,
 finalization_not_before,policy_version,blocker_snapshot,export_id,version) ON meal.legal_requests TO meal_app;
GRANT UPDATE(login,display_name,email_normalized,status,archived_at,version) ON meal.users TO meal_app;
-- v26 provider-neutral payment application. Mutations remain constrained to lifecycle columns;
-- payment events and outbox records are append-only, and no card data is stored.
GRANT INSERT ON meal.payment_attempts,meal.payment_events,meal.payment_reconciliations,meal.payment_refunds,meal.outbox_events TO meal_app;
GRANT SELECT(id,provider,external_id,status,amount_minor,idempotency_key,order_id,created_at,
 request_hash,checkout_url,provider_occurred_at) ON meal.payment_attempts TO meal_app;
GRANT SELECT(provider,external_event_id,attempt_id) ON meal.payment_events TO meal_app;
GRANT SELECT(id,status,amount_minor,reason,attempt_id,requested_by,idempotency_key,request_hash,
 access_effect,access_target_kind,access_target_id,provider_event_id,consequence_applied_at)
 ON meal.payment_refunds TO meal_app;
GRANT SELECT(id,order_id,balance_projection,reserved_projection) ON meal.ai_buckets TO meal_app;
GRANT UPDATE(external_id,status,checkout_url,provider_occurred_at,version) ON meal.payment_attempts TO meal_app;
GRANT UPDATE(status,result,version) ON meal.payment_reconciliations TO meal_app;
GRANT UPDATE(status,provider_ref,provider_event_id,consequence_applied_at,version) ON meal.payment_refunds TO meal_app;
GRANT UPDATE(status,accepted_at,version) ON meal.billing_orders TO meal_app;
GRANT UPDATE(granted,balance_projection,reserved_projection,version) ON meal.ai_buckets TO meal_app;
COMMIT;
