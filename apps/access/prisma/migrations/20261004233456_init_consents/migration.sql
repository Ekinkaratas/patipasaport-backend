-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "ConsentAction" AS ENUM ('GRANTED', 'UPDATED', 'REVOKED');

-- CreateTable
CREATE TABLE "consents" (
    "id" UUID NOT NULL,
    "clinic_id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "pet_owner_id" UUID NOT NULL,
    "medical_read" BOOLEAN NOT NULL DEFAULT false,
    "medical_write" BOOLEAN NOT NULL DEFAULT false,
    "vaccination_read" BOOLEAN NOT NULL DEFAULT false,
    "prescription_read" BOOLEAN NOT NULL DEFAULT false,
    "chip_number_read" BOOLEAN NOT NULL DEFAULT false,
    "owner_contact_read" BOOLEAN NOT NULL DEFAULT false,
    "status" "ConsentStatus" NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_events" (
    "id" UUID NOT NULL,
    "consent_id" UUID NOT NULL,
    "action" "ConsentAction" NOT NULL,
    "medical_read" BOOLEAN NOT NULL,
    "medical_write" BOOLEAN NOT NULL,
    "vaccination_read" BOOLEAN NOT NULL,
    "prescription_read" BOOLEAN NOT NULL,
    "chip_number_read" BOOLEAN NOT NULL,
    "owner_contact_read" BOOLEAN NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "consents_pet_owner_id_idx" ON "consents"("pet_owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "consents_clinic_id_pet_id_key" ON "consents"("clinic_id", "pet_id");

-- CreateIndex
CREATE INDEX "consent_events_consent_id_created_at_idx" ON "consent_events"("consent_id", "created_at");

-- AddForeignKey
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_consent_id_fkey" FOREIGN KEY ("consent_id") REFERENCES "consents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION log_consent_event() RETURNS trigger AS $$
DECLARE
  v_actor text := NULLIF(current_setting('app.actor_id', true), '');
BEGIN
  IF TG_OP = 'UPDATE' AND
     (NEW.status, NEW.medical_read, NEW.medical_write, NEW.vaccination_read,
      NEW.prescription_read, NEW.chip_number_read, NEW.owner_contact_read, NEW.expires_at)
     IS NOT DISTINCT FROM
     (OLD.status, OLD.medical_read, OLD.medical_write, OLD.vaccination_read,
      OLD.prescription_read, OLD.chip_number_read, OLD.owner_contact_read, OLD.expires_at) THEN
    RETURN NEW;
  END IF;

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'consents: app.actor_id ayarlanmadan yazılamaz';
  END IF;

  INSERT INTO consent_events (id, consent_id, action,
    medical_read, medical_write, vaccination_read, prescription_read,
    chip_number_read, owner_contact_read, expires_at, actor_id)
  VALUES (gen_random_uuid(), NEW.id,
    (CASE
       WHEN TG_OP = 'INSERT'                                 THEN 'GRANTED'
       WHEN NEW.status = 'REVOKED' AND OLD.status = 'ACTIVE' THEN 'REVOKED'
       WHEN NEW.status = 'ACTIVE' AND OLD.status = 'REVOKED' THEN 'GRANTED'
       ELSE 'UPDATED'
     END)::"ConsentAction",
    NEW.medical_read, NEW.medical_write, NEW.vaccination_read, NEW.prescription_read,
    NEW.chip_number_read, NEW.owner_contact_read, NEW.expires_at, v_actor::uuid);

  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER consents_audit
  AFTER INSERT OR UPDATE ON consents
  FOR EACH ROW EXECUTE FUNCTION log_consent_event();

CREATE FUNCTION forbid_consent_event_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'consent_events yalnızca ekleme yapılabilir';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER consent_events_append_only
  BEFORE UPDATE OR DELETE ON consent_events
  FOR EACH ROW EXECUTE FUNCTION forbid_consent_event_change();
