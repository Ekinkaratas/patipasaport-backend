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

export class TestData {
  private readonly connections = new Map<DatabaseName, Promise<Client>>();
  private readonly clinicIds = new Set<string>();
  private readonly userIds = new Set<string>();
  private readonly petIds = new Set<string>();

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

  async close(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    for (const connection of connections) {
      await (await connection).end();
    }
  }
}
