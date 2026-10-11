-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('QUEUED', 'PROCESSING', 'DRAFT_READY', 'FAILED');

-- CreateEnum
CREATE TYPE "DraftReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RecordType" AS ENUM ('EXAMINATION', 'VACCINATION', 'PRESCRIPTION', 'LAB_RESULT', 'SURGERY');

-- CreateEnum
CREATE TYPE "LabResultFlag" AS ENUM ('NORMAL', 'LOW', 'HIGH');

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "clinic_id" UUID NOT NULL,
    "storage_path" VARCHAR(64) NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(32) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "note" VARCHAR(500),
    "status" "DocumentStatus" NOT NULL DEFAULT 'QUEUED',
    "failure_reason" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_reviews" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "clinic_id" UUID NOT NULL,
    "record_type" "RecordType" NOT NULL,
    "proposed_payload" JSONB NOT NULL,
    "approved_payload" JSONB,
    "model_version" VARCHAR(64) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" "DraftReviewStatus" NOT NULL DEFAULT 'PENDING',
    "review_note" VARCHAR(500),
    "reviewed_by_clinic_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "created_record_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draft_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medical_records" (
    "id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "clinic_id" UUID NOT NULL,
    "type" "RecordType" NOT NULL,
    "title" VARCHAR(128) NOT NULL,
    "notes" TEXT,
    "recorded_at" DATE NOT NULL,
    "source_document_id" UUID,
    "source_draft_review_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medical_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "record_attachments" (
    "record_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,

    CONSTRAINT "record_attachments_pkey" PRIMARY KEY ("record_id","document_id")
);

-- CreateTable
CREATE TABLE "vaccinations" (
    "id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "vaccine_name" VARCHAR(128) NOT NULL,
    "batch_number" VARCHAR(64),
    "administered_at" DATE NOT NULL,
    "next_due_at" DATE,

    CONSTRAINT "vaccinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescriptions" (
    "id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "medication_name" VARCHAR(128) NOT NULL,
    "dosage" VARCHAR(64) NOT NULL,
    "frequency" VARCHAR(64) NOT NULL,
    "duration_days" INTEGER NOT NULL,
    "instructions" VARCHAR(1000),
    "prescribed_at" DATE NOT NULL,

    CONSTRAINT "prescriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_results" (
    "id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "test_name" VARCHAR(128) NOT NULL,
    "value" VARCHAR(64) NOT NULL,
    "unit" VARCHAR(32),
    "reference_range" VARCHAR(64),
    "flag" "LabResultFlag",
    "sampled_at" DATE NOT NULL,

    CONSTRAINT "lab_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL,
    "type" VARCHAR(128) NOT NULL,
    "payload" JSONB NOT NULL,
    "correlation_id" VARCHAR(128) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "documents_storage_path_key" ON "documents"("storage_path");

-- CreateIndex
CREATE INDEX "documents_clinic_id_status_idx" ON "documents"("clinic_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "draft_reviews_document_id_key" ON "draft_reviews"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "draft_reviews_created_record_id_key" ON "draft_reviews"("created_record_id");

-- CreateIndex
CREATE INDEX "draft_reviews_clinic_id_status_idx" ON "draft_reviews"("clinic_id", "status");

-- CreateIndex
CREATE INDEX "medical_records_pet_id_recorded_at_idx" ON "medical_records"("pet_id", "recorded_at");

-- CreateIndex
CREATE INDEX "record_attachments_document_id_idx" ON "record_attachments"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "vaccinations_record_id_key" ON "vaccinations"("record_id");

-- CreateIndex
CREATE INDEX "vaccinations_next_due_at_idx" ON "vaccinations"("next_due_at");

-- CreateIndex
CREATE UNIQUE INDEX "prescriptions_record_id_key" ON "prescriptions"("record_id");

-- CreateIndex
CREATE INDEX "lab_results_record_id_idx" ON "lab_results"("record_id");

-- CreateIndex
CREATE INDEX "outbox_published_at_next_attempt_at_idx" ON "outbox"("published_at", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "draft_reviews" ADD CONSTRAINT "draft_reviews_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_reviews" ADD CONSTRAINT "draft_reviews_created_record_id_fkey" FOREIGN KEY ("created_record_id") REFERENCES "medical_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_records" ADD CONSTRAINT "medical_records_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_records" ADD CONSTRAINT "medical_records_source_draft_review_id_fkey" FOREIGN KEY ("source_draft_review_id") REFERENCES "draft_reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_attachments" ADD CONSTRAINT "record_attachments_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "medical_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_attachments" ADD CONSTRAINT "record_attachments_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vaccinations" ADD CONSTRAINT "vaccinations_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "medical_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "medical_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "medical_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION forbid_medical_record_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '%: onaylı tıbbi kayıt değiştirilemez ve silinemez', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER medical_records_immutable
  BEFORE UPDATE OR DELETE ON medical_records
  FOR EACH ROW EXECUTE FUNCTION forbid_medical_record_change();

CREATE TRIGGER record_attachments_immutable
  BEFORE UPDATE OR DELETE ON record_attachments
  FOR EACH ROW EXECUTE FUNCTION forbid_medical_record_change();

CREATE TRIGGER vaccinations_immutable
  BEFORE UPDATE OR DELETE ON vaccinations
  FOR EACH ROW EXECUTE FUNCTION forbid_medical_record_change();

CREATE TRIGGER prescriptions_immutable
  BEFORE UPDATE OR DELETE ON prescriptions
  FOR EACH ROW EXECUTE FUNCTION forbid_medical_record_change();

CREATE TRIGGER lab_results_immutable
  BEFORE UPDATE OR DELETE ON lab_results
  FOR EACH ROW EXECUTE FUNCTION forbid_medical_record_change();
