-- CreateEnum
CREATE TYPE "PetSpecies" AS ENUM ('DOG', 'CAT', 'BIRD', 'RABBIT', 'HAMSTER', 'GUINEA_PIG', 'FERRET', 'TURTLE');

-- CreateEnum
CREATE TYPE "PetSex" AS ENUM ('MALE', 'FEMALE');

-- CreateTable
CREATE TABLE "pets" (
    "id" UUID NOT NULL,
    "name" VARCHAR(32) NOT NULL,
    "species" "PetSpecies" NOT NULL,
    "breed" VARCHAR(32) NOT NULL,
    "sex" "PetSex" NOT NULL,
    "birth_date" DATE,
    "is_birth_date_estimated" BOOLEAN NOT NULL DEFAULT false,
    "is_neutered" BOOLEAN NOT NULL DEFAULT false,
    "owner_user_id" UUID NOT NULL,
    "chip_no_encrypted" TEXT,
    "chip_no_index" VARCHAR(64),
    "chip_no_last4" CHAR(4),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pets_chip_no_index_key" ON "pets"("chip_no_index");

-- CreateIndex
CREATE INDEX "pets_owner_user_id_idx" ON "pets"("owner_user_id");
