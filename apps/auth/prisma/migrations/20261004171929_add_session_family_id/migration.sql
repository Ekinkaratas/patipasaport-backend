-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "family_id" UUID;
UPDATE "sessions" SET "family_id" = "id";
ALTER TABLE "sessions" ALTER COLUMN "family_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "sessions_family_id_idx" ON "sessions"("family_id");
