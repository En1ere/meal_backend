CREATE TABLE meal.chat_mentions (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES meal.chat_messages(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  user_id uuid NOT NULL REFERENCES meal.users(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1,
  CONSTRAINT ck_chat_mentions_version CHECK (version > 0),
  CONSTRAINT uq_chat_mentions_message_user UNIQUE (message_id, user_id)
);

COMMENT ON TABLE meal.chat_mentions IS 'Явное упоминание активного account-участника семейного чата; доступ повторно проверяется по периоду членства';
CREATE INDEX ix_chat_mentions_user_id ON meal.chat_mentions(user_id);
CREATE TRIGGER require_serializable BEFORE INSERT OR UPDATE OR DELETE ON meal.chat_mentions FOR EACH STATEMENT EXECUTE FUNCTION meal.require_serializable();
CREATE TRIGGER protect_identity BEFORE UPDATE ON meal.chat_mentions FOR EACH ROW EXECUTE FUNCTION meal.protect_scope_and_identity();
