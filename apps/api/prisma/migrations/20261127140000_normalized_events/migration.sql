-- CreateTable
CREATE TABLE "normalized_events" (
    "workspace_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "repository_owner" TEXT NOT NULL,
    "repository_name" TEXT NOT NULL,
    "commit_sha" TEXT,
    "data" JSONB NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "fixture" TEXT,
    "fingerprint" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "normalized_events_pkey" PRIMARY KEY ("workspace_id","id")
);

-- CreateIndex
CREATE INDEX "normalized_events_workspace_id_occurred_at_source_source_id_idx" ON "normalized_events"("workspace_id", "occurred_at", "source", "source_id", "id");

-- CreateIndex
CREATE INDEX "normalized_events_workspace_id_commit_sha_idx" ON "normalized_events"("workspace_id", "commit_sha");

-- CreateIndex
CREATE INDEX "normalized_events_workspace_id_repository_id_idx" ON "normalized_events"("workspace_id", "repository_id");

-- CreateIndex
CREATE UNIQUE INDEX "normalized_events_workspace_id_source_kind_source_id_key" ON "normalized_events"("workspace_id", "source", "kind", "source_id");

-- AddForeignKey
ALTER TABLE "normalized_events" ADD CONSTRAINT "normalized_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "normalized_events" ADD CONSTRAINT "normalized_events_workspace_id_repository_id_fkey" FOREIGN KEY ("workspace_id", "repository_id") REFERENCES "repository_connections"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;



-- Integrity rules Prisma cannot express in the schema; they mirror the event
-- contract in packages/contracts.
ALTER TABLE "normalized_events" ADD CONSTRAINT "normalized_events_id_format" CHECK ("id" ~ '^evt_[a-z0-9_]{1,64}$');
ALTER TABLE "normalized_events" ADD CONSTRAINT "normalized_events_source_known" CHECK ("source" IN ('github', 'replay'));
ALTER TABLE "normalized_events" ADD CONSTRAINT "normalized_events_kind_known"
  CHECK ("kind" IN ('pull_request.merged', 'check_run.completed', 'deployment.status', 'alert.triggered'));
ALTER TABLE "normalized_events" ADD CONSTRAINT "normalized_events_source_id_length" CHECK (char_length("source_id") BETWEEN 1 AND 200);
-- Alerts are never tied to a commit; every other kind carries a full SHA.
ALTER TABLE "normalized_events" ADD CONSTRAINT "normalized_events_commit_sha_by_kind"
  CHECK (("kind" = 'alert.triggered') = ("commit_sha" IS NULL));
ALTER TABLE "normalized_events" ADD CONSTRAINT "normalized_events_commit_sha_format"
  CHECK ("commit_sha" IS NULL OR "commit_sha" ~ '^[0-9a-f]{40}$');
-- Replayed (synthetic) events always name their fixture; source events never do.
ALTER TABLE "normalized_events" ADD CONSTRAINT "normalized_events_fixture_marks_replay"
  CHECK (("source" = 'replay') = ("fixture" IS NOT NULL));
ALTER TABLE "normalized_events" ADD CONSTRAINT "normalized_events_data_object" CHECK (jsonb_typeof("data") = 'object');
ALTER TABLE "normalized_events" ADD CONSTRAINT "normalized_events_fingerprint_format" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$');

-- Events are evidence: once stored they never change.
CREATE FUNCTION "normalized_events_reject_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'normalized_events rows are append-only' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "normalized_events_append_only"
  BEFORE UPDATE ON "normalized_events"
  FOR EACH ROW EXECUTE FUNCTION "normalized_events_reject_update"();
