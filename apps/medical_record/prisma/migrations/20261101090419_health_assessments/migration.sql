-- CreateEnum
CREATE TYPE "HealthAssessmentStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "HealthRiskLevel" AS ENUM ('LOW', 'MODERATE', 'HIGH', 'URGENT');

-- CreateTable
CREATE TABLE "health_assessments" (
    "id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "status" "HealthAssessmentStatus" NOT NULL DEFAULT 'PENDING',
    "input_hash" CHAR(64) NOT NULL,
    "based_on_record_ids" UUID[],
    "requested_by_user_id" UUID NOT NULL,
    "summary" TEXT,
    "risk_level" "HealthRiskLevel",
    "payload" JSONB,
    "confidence" DOUBLE PRECISION,
    "model_version" VARCHAR(64),
    "failure_reason" VARCHAR(64),
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generated_at" TIMESTAMP(3),

    CONSTRAINT "health_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "health_assessments_pet_id_key" ON "health_assessments"("pet_id");

-- CreateIndex
CREATE UNIQUE INDEX "health_assessments_request_id_key" ON "health_assessments"("request_id");
