-- CreateEnum
CREATE TYPE "LabExplanationStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "lab_result_explanations" (
    "id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "status" "LabExplanationStatus" NOT NULL,
    "summary" TEXT,
    "items" JSONB,
    "confidence" DOUBLE PRECISION,
    "model_version" VARCHAR(64),
    "failure_reason" VARCHAR(64),
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generated_at" TIMESTAMP(3),

    CONSTRAINT "lab_result_explanations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lab_result_explanations_record_id_key" ON "lab_result_explanations"("record_id");

-- AddForeignKey
ALTER TABLE "lab_result_explanations" ADD CONSTRAINT "lab_result_explanations_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "medical_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
