-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "StockCategory" AS ENUM ('VACCINE', 'MEDICINE', 'SUPPLY', 'FOOD', 'OTHER');

-- CreateEnum
CREATE TYPE "StockUnit" AS ENUM ('PIECE', 'BOX', 'BOTTLE', 'AMPOULE', 'TABLET', 'DOSE', 'ML', 'MG', 'G');

-- CreateTable
CREATE TABLE "clinics" (
    "id" UUID NOT NULL,
    "full_name" VARCHAR(128) NOT NULL,
    "tax_number" VARCHAR(11) NOT NULL,
    "contact_email" VARCHAR(254) NOT NULL,
    "tel_no" VARCHAR(16) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clinics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_items" (
    "id" UUID NOT NULL,
    "clinic_id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "category" "StockCategory" NOT NULL,
    "unit" "StockUnit" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "critical_level" INTEGER NOT NULL,
    "expires_at" DATE,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clinics_tax_number_key" ON "clinics"("tax_number");

-- CreateIndex
CREATE UNIQUE INDEX "clinics_contact_email_key" ON "clinics"("contact_email");

-- CreateIndex
CREATE UNIQUE INDEX "clinics_tel_no_key" ON "clinics"("tel_no");

-- CreateIndex
CREATE INDEX "stock_items_clinic_id_category_idx" ON "stock_items"("clinic_id", "category");

-- AddForeignKey
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

