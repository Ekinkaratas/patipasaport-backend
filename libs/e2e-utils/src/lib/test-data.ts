import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { connectDatabase } from './databases';
import {
  uniqueEmail,
  uniqueLandlinePhone,
  uniqueMobilePhone,
  validVkn,
} from './fixtures';
import { DatabaseName } from './ports';
import {
  AI_UPLOADED_QUEUE,
  DOCUMENT_EVENTS_DLQ,
  EventBus,
  messageSubject,
} from './rabbitmq';
import { ObjectStore } from './storage';

export interface SeededClinic {
  id: string;
  name: string;
  taxNumber: string;
  email: string;
  phone: string;
}

export interface SeededUser {
  id: string;
  email: string;
  phone: string;
  fullName: string;
}

const OUTBOX_DRAIN_TIMEOUT_MS = 10_000;

export interface TestDataOptions {
  medicalRecord?: boolean;
}

export class TestData {
  private readonly connections = new Map<DatabaseName, Promise<Client>>();
  private readonly messageIds = new Set<string>();
  private readonly clinicIds = new Set<string>();
  private readonly userIds = new Set<string>();
  private readonly petIds = new Set<string>();

  constructor(private readonly options: TestDataOptions = {}) {}

  db(name: DatabaseName): Promise<Client> {
    let connection = this.connections.get(name);
    if (!connection) {
      connection = connectDatabase(name);
      this.connections.set(name, connection);
    }
    return connection;
  }

  trackClinic(id: string): void {
    this.clinicIds.add(id);
  }

  trackUser(id: string): void {
    this.userIds.add(id);
  }

  trackPet(id: string): void {
    this.petIds.add(id);
  }

  trackMessage(id: string): void {
    this.messageIds.add(id);
  }

  async insertClinic(
    options: { name?: string; isActive?: boolean } = {},
  ): Promise<SeededClinic> {
    const clinic: SeededClinic = {
      id: randomUUID(),
      name: options.name ?? 'E2E Test Kliniği',
      taxNumber: validVkn(),
      email: uniqueEmail('klinik'),
      phone: uniqueLandlinePhone(),
    };
    this.trackClinic(clinic.id);
    await (
      await this.db('clinics')
    ).query(
      'INSERT INTO clinics (id, full_name, tax_number, contact_email, tel_no, is_active, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now())',
      [
        clinic.id,
        clinic.name,
        clinic.taxNumber,
        clinic.email,
        clinic.phone,
        options.isActive ?? true,
      ],
    );
    return clinic;
  }

  async insertUser(
    options: {
      fullName?: string;
      role?: 'PET_OWNER' | 'CLINIC';
      clinicId?: string;
      isActive?: boolean;
    } = {},
  ): Promise<SeededUser> {
    const user: SeededUser = {
      id: randomUUID(),
      email: uniqueEmail('kullanici'),
      phone: uniqueMobilePhone(),
      fullName: options.fullName ?? 'Ayşe Yılmaz',
    };
    this.trackUser(user.id);
    await (
      await this.db('users')
    ).query(
      'INSERT INTO users (id, email, full_name, tel_no, role, clinic_id, is_active, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())',
      [
        user.id,
        user.email,
        user.fullName,
        user.phone,
        options.role ?? 'PET_OWNER',
        options.clinicId ?? null,
        options.isActive ?? true,
      ],
    );
    return user;
  }

  async cleanup(): Promise<void> {
    const clinicIds = [...this.clinicIds];
    const users = await this.db('users');
    const { rows: clinicUsers } = await users.query<{ id: string }>(
      'SELECT id FROM users WHERE clinic_id = ANY($1::uuid[])',
      [clinicIds],
    );
    clinicUsers.forEach((row) => this.userIds.add(row.id));
    const userIds = [...this.userIds];

    const pets = await this.db('pets');
    const { rows: petRows } = await pets.query<{ id: string }>(
      'SELECT id FROM pets WHERE id = ANY($1::uuid[]) OR owner_user_id = ANY($2::uuid[])',
      [[...this.petIds], userIds],
    );
    const petIds = [...new Set([...this.petIds, ...petRows.map((row) => row.id)])];

    if (this.options.medicalRecord) {
      await this.cleanupMedicalRecord(petIds);
    }

    const access = await this.db('access');
    await access.query('BEGIN');
    try {
      await access.query('SET LOCAL session_replication_role = replica');
      const { rows: consentRows } = await access.query<{ id: string }>(
        'SELECT id FROM consents WHERE pet_id = ANY($1::uuid[]) OR clinic_id = ANY($2::uuid[]) OR pet_owner_id = ANY($3::uuid[])',
        [petIds, clinicIds, userIds],
      );
      const consentIds = consentRows.map((row) => row.id);
      await access.query(
        'DELETE FROM consent_events WHERE consent_id = ANY($1::uuid[])',
        [consentIds],
      );
      await access.query('DELETE FROM consents WHERE id = ANY($1::uuid[])', [
        consentIds,
      ]);
      await access.query('COMMIT');
    } catch (e) {
      await access.query('ROLLBACK');
      throw e;
    }

    await pets.query('DELETE FROM pets WHERE id = ANY($1::uuid[])', [petIds]);

    const clinics = await this.db('clinics');
    await clinics.query(
      'DELETE FROM stock_sales WHERE clinic_id = ANY($1::uuid[])',
      [clinicIds],
    );
    await clinics.query(
      'DELETE FROM stock_items WHERE clinic_id = ANY($1::uuid[])',
      [clinicIds],
    );
    await clinics.query('DELETE FROM clinics WHERE id = ANY($1::uuid[])', [
      clinicIds,
    ]);

    await (
      await this.db('auth')
    ).query('DELETE FROM credentials WHERE user_id = ANY($1::uuid[])', [
      userIds,
    ]);
    await users.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
      userIds,
    ]);
  }

  private async cleanupMedicalRecord(petIds: string[]): Promise<void> {
    const medical = await this.db('medical_record');
    const { rows: documents } = await medical.query<{
      id: string;
      storage_path: string;
    }>('SELECT id, storage_path FROM documents WHERE pet_id = ANY($1::uuid[])', [
      petIds,
    ]);
    const documentIds = documents.map((row) => row.id);

    const deadline = Date.now() + OUTBOX_DRAIN_TIMEOUT_MS;
    while (documentIds.length > 0 && Date.now() < deadline) {
      const { rows } = await medical.query<{ pending: number }>(
        "SELECT count(*)::int AS pending FROM outbox WHERE payload->>'subject' = ANY($1::text[]) AND published_at IS NULL",
        [documentIds],
      );
      if (rows[0].pending === 0) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }

    if (documentIds.length > 0 || this.messageIds.size > 0) {
      const bus = new EventBus();
      const tracked = (message: Parameters<typeof messageSubject>[0]) =>
        documentIds.includes(messageSubject(message) ?? '') ||
        this.messageIds.has(String(message.properties.messageId));
      try {
        await bus.takeWhere(AI_UPLOADED_QUEUE, tracked);
        await bus.takeWhere(DOCUMENT_EVENTS_DLQ, tracked);
      } finally {
        await bus.close();
      }
    }

    if (documents.length > 0) {
      const store = new ObjectStore();
      try {
        for (const document of documents) {
          await store.remove(document.storage_path).catch(() => undefined);
        }
      } finally {
        store.close();
      }
    }

    await medical.query('BEGIN');
    try {
      await medical.query('SET LOCAL session_replication_role = replica');
      const { rows: records } = await medical.query<{ id: string }>(
        'SELECT id FROM medical_records WHERE pet_id = ANY($1::uuid[])',
        [petIds],
      );
      const recordIds = records.map((row) => row.id);
      for (const table of [
        'record_attachments',
        'lab_results',
        'prescriptions',
        'vaccinations',
      ]) {
        await medical.query(
          `DELETE FROM ${table} WHERE record_id = ANY($1::uuid[])`,
          [recordIds],
        );
      }
      await medical.query(
        'DELETE FROM draft_reviews WHERE pet_id = ANY($1::uuid[])',
        [petIds],
      );
      await medical.query(
        'DELETE FROM medical_records WHERE id = ANY($1::uuid[])',
        [recordIds],
      );
      await medical.query(
        "DELETE FROM outbox WHERE payload->>'subject' = ANY($1::text[])",
        [documentIds],
      );
      await medical.query(
        'DELETE FROM documents WHERE pet_id = ANY($1::uuid[])',
        [petIds],
      );
      await medical.query('COMMIT');
    } catch (e) {
      await medical.query('ROLLBACK');
      throw e;
    }
  }

  async close(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    for (const connection of connections) {
      await (await connection).end();
    }
  }
}
