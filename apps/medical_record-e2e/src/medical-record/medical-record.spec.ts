import { Client } from '@grpc/grpc-js';
import {
  AI_UPLOADED_QUEUE,
  callGrpc,
  DOCKER_GRPC_PORTS,
  DOCUMENT_EVENTS_DLQ,
  EventBus,
  expectOk,
  grpcClient,
  GrpcResult,
  istanbulToday,
  JwtIssuer,
  messageSubject,
  RunningService,
  SeededClinic,
  SeededUser,
  shiftDays,
  startService,
  TestData,
} from '@libs/e2e-utils';
import { access, medicalRecord, pets } from '@libs/proto';
import { randomBytes, randomUUID } from 'crypto';

const outcome = (result: GrpcResult<unknown>): string =>
  result.ok ? 'ok' : `${result.code}/${result.details}`;

const sleep = (ms: number) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

// ---Amaç: bir koşul sağlanana kadar kısa aralıklarla yeniden denemek ---
async function waitFor<T>(
  check: () => Promise<T | undefined | null | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`${timeoutMs} ms içinde koşul sağlanmadı`);
    }
    await sleep(250);
  }
}

describe('medical_record servisi (e2e)', () => {
  const data = new TestData({ medicalRecord: true });
  const tokens = new JwtIssuer();
  const bus = new EventBus();
  const today = istanbulToday();

  let service: RunningService;
  let medicalClient: Client;
  let accessClient: Client;
  let petsClient: Client;
  let owner: SeededUser;
  let stranger: SeededUser;
  let clinicA: SeededClinic;
  let clinicB: SeededClinic;
  let petId: string;
  const clinicUsers = new Map<string, string>();

  const clinicToken = (clinicId: string) => {
    if (!clinicUsers.has(clinicId)) clinicUsers.set(clinicId, randomUUID());
    return tokens.jwtFor({
      role: 'CLINIC',
      userId: clinicUsers.get(clinicId) as string,
      clinicId,
    });
  };
  const ownerToken = () =>
    tokens.jwtFor({ role: 'PET_OWNER', userId: owner.id });

  const call = <T>(method: string, request: object, token: string) =>
    callGrpc<T>(medicalClient, method, request, token);

  const documentRow = async (id: string) =>
    (
      await (
        await data.db('medical_record')
      ).query<{
        status: string;
        failure_reason: string | null;
      }>('SELECT status::text, failure_reason FROM documents WHERE id = $1', [
        id,
      ])
    ).rows[0];

  const register = async (token?: string, override: object = {}) =>
    call<medicalRecord.DocumentResponse>(
      'RegisterDocument',
      {
        petId,
        storagePath: `${randomUUID()}.pdf`,
        originalName: 'Kan Tahlili.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        sha256: randomBytes(32).toString('hex'),
        note: '',
        ...override,
      },
      token ?? (await clinicToken(clinicA.id)),
    );

  const registered = async () =>
    expectOk(await register(), 'RegisterDocument')
      .document as medicalRecord.Document;

  beforeAll(async () => {
    service = await startService('medical_record');
    medicalClient = grpcClient('medical_record', service.port);
    accessClient = grpcClient('access', DOCKER_GRPC_PORTS.access);
    petsClient = grpcClient('pets', DOCKER_GRPC_PORTS.pets);

    owner = await data.insertUser({ fullName: 'Ayşe Yılmaz' });
    stranger = await data.insertUser({ fullName: 'Başka Kişi' });
    clinicA = await data.insertClinic({ name: 'Rızalı Klinik' });
    clinicB = await data.insertClinic({ name: 'Okuma Kliniği' });

    const created = expectOk(
      await callGrpc<pets.PetResponse>(
        petsClient,
        'CreatePet',
        {
          name: 'Pamuk',
          species: 'CAT',
          breed: 'TURKISH_VAN',
          sex: pets.PetSex.FEMALE,
          birthDate: '',
          isBirthDateEstimated: false,
          isNeutered: false,
          chipNumber: '',
          ownerUserId: owner.id,
        },
        await ownerToken(),
      ),
      'pets.CreatePet',
    );
    petId = created.pet?.id ?? '';
    data.trackPet(petId);

    const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    for (const [clinicId, scopes] of [
      [
        clinicA.id,
        [
          'medical_read',
          'medical_write',
          'vaccination_read',
          'prescription_read',
        ],
      ],
      [clinicB.id, ['medical_read']],
    ] as const) {
      expectOk(
        await callGrpc<access.ConsentResponse>(
          accessClient,
          'GrantConsent',
          { clinicId, petId, scopes: [...scopes], expiresAt },
          await ownerToken(),
        ),
        'access.GrantConsent',
      );
    }
  }, 120_000);

  afterAll(async () => {
    try {
      await data.cleanup();
    } finally {
      await data.close();
      await bus.close();
      [medicalClient, accessClient, petsClient].forEach((client) =>
        client?.close(),
      );
      tokens.close();
      await service?.stop();
    }
  });

  // ---Amaç: belge kaydının rıza ve rol kurallarını, outbox üzerinden AI kuyruğuna düşen olayı doğrulamak ---
  describe('RegisterDocument ve outbox', () => {
    it('rızalı klinik belgeyi kaydeder, olay CloudEvents zarfıyla AI kuyruğuna düşer', async () => {
      const document = await registered();
      expect(document).toMatchObject({
        petId,
        clinicId: clinicA.id,
        status: medicalRecord.DocumentStatus.QUEUED,
        draftReviewId: '',
      });

      const [message] = await waitFor(async () => {
        const taken = await bus.takeWhere(
          AI_UPLOADED_QUEUE,
          (m) => messageSubject(m) === document.id,
        );
        return taken.length > 0 ? taken : undefined;
      });
      const event = JSON.parse(message.content.toString('utf8'));
      expect(message.properties).toMatchObject({
        contentType: 'application/cloudevents+json',
        type: 'com.patipasaport.document.uploaded.v1',
        messageId: event.id,
        deliveryMode: 2,
      });
      expect(message.properties.headers?.['x-correlation-id']).toEqual(
        expect.any(String),
      );
      expect(event).toMatchObject({
        specversion: '1.0',
        source: '/patipasaport/medical-record',
        subject: document.id,
        dataschema: 'urn:patipasaport:events:DocumentUploaded:v1',
        data: {
          documentId: document.id,
          petId,
          clinicId: clinicA.id,
          sizeBytes: 2048,
        },
      });
    });

    it('medical_write olmayan klinik, hasta sahibi ve aynı dosya yolu reddedilir', async () => {
      expect(outcome(await register(await clinicToken(clinicB.id)))).toBe(
        'PERMISSION_DENIED/FORBIDDEN',
      );
      expect(outcome(await register(await ownerToken()))).toBe(
        'PERMISSION_DENIED/FORBIDDEN',
      );
      const storagePath = `${randomUUID()}.pdf`;
      expectOk(await register(undefined, { storagePath }), 'RegisterDocument');
      expect(outcome(await register(undefined, { storagePath }))).toBe(
        'ALREADY_EXISTS/CONFLICT',
      );
    });

    it('GetDocument yükleyen kliniğe ve hayvanın sahibine açıktır', async () => {
      const document = await registered();
      for (const token of [await clinicToken(clinicA.id), await ownerToken()]) {
        expect(
          expectOk(
            await call<medicalRecord.DocumentResponse>(
              'GetDocument',
              { id: document.id },
              token,
            ),
            'GetDocument',
          ).document?.id,
        ).toBe(document.id);
      }
      for (const token of [
        await clinicToken(clinicB.id),
        await tokens.jwtFor({ role: 'PET_OWNER', userId: stranger.id }),
      ]) {
        expect(
          outcome(await call('GetDocument', { id: document.id }, token)),
        ).toBe('NOT_FOUND/NOT_FOUND');
      }
    });

    it('ListDocumentsByPet: klinik yalnızca kendi yüklediklerini, hasta sahibi tüm kliniklerin belgelerini en yeni önce görür', async () => {
      const ownerJwt = await ownerToken();
      const listedPetId =
        expectOk(
          await callGrpc<pets.PetResponse>(
            petsClient,
            'CreatePet',
            {
              name: 'Tarçın',
              species: 'DOG',
              breed: 'KANGAL',
              sex: pets.PetSex.MALE,
              birthDate: '',
              isBirthDateEstimated: false,
              isNeutered: false,
              chipNumber: '',
              ownerUserId: owner.id,
            },
            ownerJwt,
          ),
          'pets.CreatePet',
        ).pet?.id ?? '';
      data.trackPet(listedPetId);
      const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
      for (const clinicId of [clinicA.id, clinicB.id]) {
        expectOk(
          await callGrpc<access.ConsentResponse>(
            accessClient,
            'GrantConsent',
            {
              clinicId,
              petId: listedPetId,
              scopes: ['medical_read', 'medical_write'],
              expiresAt,
            },
            ownerJwt,
          ),
          'access.GrantConsent',
        );
      }
      const registerFor = async (clinicId: string) =>
        expectOk(
          await register(await clinicToken(clinicId), { petId: listedPetId }),
          'RegisterDocument',
        ).document as medicalRecord.Document;
      const firstA = await registerFor(clinicA.id);
      const fromB = await registerFor(clinicB.id);
      const secondA = await registerFor(clinicA.id);

      const list = (token: string, override: object = {}) =>
        call<medicalRecord.ListDocumentsResponse>(
          'ListDocumentsByPet',
          { petId: listedPetId, page: 1, pageSize: 8, ...override },
          token,
        );
      const idsOf = (result: GrpcResult<medicalRecord.ListDocumentsResponse>) =>
        expectOk(result, 'ListDocumentsByPet').documents.map((d) => d.id);

      expect(idsOf(await list(await clinicToken(clinicA.id)))).toEqual([
        secondA.id,
        firstA.id,
      ]);
      expect(idsOf(await list(await clinicToken(clinicB.id)))).toEqual([
        fromB.id,
      ]);
      expect(idsOf(await list(ownerJwt))).toEqual([
        secondA.id,
        fromB.id,
        firstA.id,
      ]);
      expect(
        idsOf(
          await list(ownerJwt, { status: medicalRecord.DocumentStatus.FAILED }),
        ),
      ).toEqual([]);
      expect(
        expectOk(
          await list(ownerJwt, { page: 2, pageSize: 8 }),
          'ListDocumentsByPet',
        ),
      ).toMatchObject({ documents: [], total: 3, page: 2, pageSize: 8 });
      expect(
        outcome(
          await list(
            await tokens.jwtFor({ role: 'PET_OWNER', userId: stranger.id }),
          ),
        ),
      ).toBe('NOT_FOUND/NOT_FOUND');
      expect(
        outcome(
          await call(
            'ListDocumentsByPet',
            { petId, page: 1, pageSize: 8 },
            await clinicToken(clinicB.id),
          ),
        ),
      ).toBe('PERMISSION_DENIED/FORBIDDEN');
    });
  });

  // ---Amaç: elle kayıt girişini ve listelerin hasta sahibi/klinik erişim kurallarını doğrulamak ---
  describe('CreateRecord ve listeler', () => {
    let attachmentId: string;

    beforeAll(async () => {
      attachmentId = (await registered()).id;
      const records = [
        {
          type: medicalRecord.RecordType.VACCINATION,
          title: 'Kuduz aşısı',
          recordedAt: shiftDays(today, -1),
          vaccination: {
            vaccineName: 'Kuduz',
            administeredAt: shiftDays(today, -1),
            nextDueAt: shiftDays(today, 364),
          },
        },
        {
          type: medicalRecord.RecordType.PRESCRIPTION,
          title: 'Antibiyotik',
          recordedAt: today,
          prescription: {
            medicationName: 'Amoksisilin',
            dosage: '250 mg',
            frequency: 'günde 2 kez',
            durationDays: 7,
            prescribedAt: today,
          },
        },
        {
          type: medicalRecord.RecordType.LAB_RESULT,
          title: 'Kan tahlili',
          recordedAt: shiftDays(today, -2),
          labResult: {
            sampledAt: shiftDays(today, -2),
            items: [
              {
                testName: 'Hemoglobin',
                value: '13.5',
                unit: 'g/dL',
                referenceRange: '12-18',
                flag: medicalRecord.LabResultFlag.NORMAL,
              },
            ],
          },
        },
      ];
      for (const [index, content] of records.entries()) {
        expectOk(
          await call(
            'CreateRecord',
            {
              petId,
              content,
              attachments: index === 0 ? [{ documentId: attachmentId }] : [],
            },
            await clinicToken(clinicA.id),
          ),
          'CreateRecord',
        );
      }
    });

    it('hasta sahibi kendi hayvanının tüm kayıtlarını en yeni önce görür, ek dosya bilgisiyle', async () => {
      const result = expectOk(
        await call<medicalRecord.ListRecordsResponse>(
          'ListRecordsByPet',
          { petId, page: 1, pageSize: 8 },
          await ownerToken(),
        ),
        'ListRecordsByPet',
      );
      expect(result.total).toBe(3);
      expect(result.records.map((r) => r.recordedAt)).toEqual([
        today,
        shiftDays(today, -1),
        shiftDays(today, -2),
      ]);
      const vaccination = result.records.find(
        (r) => r.type === medicalRecord.RecordType.VACCINATION,
      );
      expect(vaccination?.attachments.map((a) => a.documentId)).toEqual([
        attachmentId,
      ]);
    });

    it('başka kullanıcı NOT_FOUND, medical_read olmayan klinik ilgili listede FORBIDDEN alır', async () => {
      const strangerToken = await tokens.jwtFor({
        role: 'PET_OWNER',
        userId: stranger.id,
      });
      expect(
        outcome(
          await call(
            'ListRecordsByPet',
            { petId, page: 1, pageSize: 8 },
            strangerToken,
          ),
        ),
      ).toBe('NOT_FOUND/NOT_FOUND');
      const readOnly = await clinicToken(clinicB.id);
      expect(
        expectOk(
          await call<medicalRecord.ListRecordsResponse>(
            'ListRecordsByPet',
            { petId, page: 1, pageSize: 8 },
            readOnly,
          ),
          'liste',
        ).total,
      ).toBe(3);
      expect(
        outcome(
          await call(
            'ListVaccinations',
            { petId, page: 1, pageSize: 8 },
            readOnly,
          ),
        ),
      ).toBe('PERMISSION_DENIED/FORBIDDEN');
      expect(
        outcome(
          await call(
            'ListPrescriptions',
            { petId, page: 1, pageSize: 8 },
            readOnly,
          ),
        ),
      ).toBe('PERMISSION_DENIED/FORBIDDEN');
    });

    it('aşı, reçete ve tahlil listeleri filtrelerle çalışır', async () => {
      const token = await clinicToken(clinicA.id);
      const upcoming = expectOk(
        await call<medicalRecord.ListVaccinationsResponse>(
          'ListVaccinations',
          { petId, onlyUpcoming: true, page: 1, pageSize: 8 },
          token,
        ),
        'ListVaccinations',
      );
      expect(upcoming.vaccinations.map((v) => v.vaccineName)).toEqual([
        'Kuduz',
      ]);
      const active = expectOk(
        await call<medicalRecord.ListPrescriptionsResponse>(
          'ListPrescriptions',
          { petId, onlyActive: true, page: 1, pageSize: 8 },
          token,
        ),
        'ListPrescriptions',
      );
      expect(active.total).toBe(1);
      const labs = expectOk(
        await call<medicalRecord.ListLabResultsResponse>(
          'ListLabResults',
          { petId, testName: 'HEMO', page: 1, pageSize: 8 },
          await ownerToken(),
        ),
        'ListLabResults',
      );
      expect(labs.labResults.map((l) => l.testName)).toEqual(['Hemoglobin']);
    });

    it('başka hayvanın belgesi ek olarak verilemez, ayrıntısız aşı kaydı reddedilir', async () => {
      const token = await clinicToken(clinicA.id);
      expect(
        outcome(
          await call(
            'CreateRecord',
            {
              petId,
              content: {
                type: medicalRecord.RecordType.EXAMINATION,
                title: 'Muayene',
                recordedAt: today,
              },
              attachments: [{ documentId: randomUUID() }],
            },
            token,
          ),
        ),
      ).toBe('NOT_FOUND/NOT_FOUND');
      expect(
        outcome(
          await call(
            'CreateRecord',
            {
              petId,
              content: {
                type: medicalRecord.RecordType.VACCINATION,
                title: 'Aşı',
                recordedAt: today,
              },
            },
            token,
          ),
        ),
      ).toBe('INVALID_ARGUMENT/VACCINATION_NOT_EMPTY');
    });
  });

  // ---Amaç: sahte AI servisiyle belge → taslak → onay/red döngüsünü ve hatalı olayların DLQ'ya gittiğini doğrulamak ---
  describe('AI döngüsü', () => {
    const analyzed = (documentId: string, proposal: object) => ({
      documentId,
      modelVersion: 'fake-ai-1',
      confidence: 0.91,
      analyzedAt: new Date().toISOString(),
      proposal,
    });

    it('processing_started ve analyzed belgeyi DRAFT_READY yapar, taslak düzeltmeden onaylanır', async () => {
      const document = await registered();
      await bus.publishAiEvent('processing_started', {
        documentId: document.id,
        modelVersion: 'fake-ai-1',
      });
      await waitFor(
        async () => (await documentRow(document.id))?.status === 'PROCESSING',
      );

      await bus.publishAiEvent(
        'analyzed',
        analyzed(document.id, {
          type: 'VACCINATION',
          title: 'Karma aşı',
          recordedAt: today,
          vaccination: { vaccineName: 'Karma', administeredAt: today },
        }),
      );
      await waitFor(
        async () => (await documentRow(document.id))?.status === 'DRAFT_READY',
      );

      const token = await clinicToken(clinicA.id);
      const drafts = expectOk(
        await call<medicalRecord.ListDraftReviewsResponse>(
          'ListDraftReviews',
          {
            petId,
            status: medicalRecord.DraftReviewStatus.PENDING,
            page: 1,
            pageSize: 8,
          },
          token,
        ),
        'ListDraftReviews',
      );
      const draft = drafts.draftReviews.find(
        (d) => d.documentId === document.id,
      );
      expect(draft?.proposal?.type).toBe(medicalRecord.RecordType.VACCINATION);
      expect(draft?.sourceFiles.map((f) => f.documentId)).toEqual([
        document.id,
      ]);

      const approved = expectOk(
        await call<medicalRecord.DraftReviewResponse>(
          'ReviewDraft',
          { id: draft?.id, approved: true },
          token,
        ),
        'ReviewDraft',
      ).draftReview;
      expect(approved?.status).toBe(medicalRecord.DraftReviewStatus.APPROVED);
      expect(
        outcome(
          await call('ReviewDraft', { id: draft?.id, approved: true }, token),
        ),
      ).toBe('ALREADY_EXISTS/CONFLICT');

      const records = expectOk(
        await call<medicalRecord.ListRecordsResponse>(
          'ListRecordsByPet',
          { petId, page: 1, pageSize: 16 },
          await ownerToken(),
        ),
        'ListRecordsByPet',
      );
      const created = records.records.find(
        (r) => r.id === approved?.createdRecordId,
      );
      expect(created).toMatchObject({
        sourceDraftReviewId: draft?.id,
        title: 'Karma aşı',
      });
      expect(created?.attachments.map((a) => a.documentId)).toEqual([
        document.id,
      ]);
    });

    it('notsuz red reddedilir, notlu red taslağı kapatır', async () => {
      const document = await registered();
      await bus.publishAiEvent(
        'analyzed',
        analyzed(document.id, {
          type: 'EXAMINATION',
          title: 'Kontrol',
          recordedAt: today,
        }),
      );
      await waitFor(
        async () => (await documentRow(document.id))?.status === 'DRAFT_READY',
      );
      const token = await clinicToken(clinicA.id);
      const draft = expectOk(
        await call<medicalRecord.ListDraftReviewsResponse>(
          'ListDraftReviews',
          { petId, page: 1, pageSize: 16 },
          token,
        ),
        'ListDraftReviews',
      ).draftReviews.find((d) => d.documentId === document.id);

      expect(
        outcome(
          await call('ReviewDraft', { id: draft?.id, approved: false }, token),
        ),
      ).toBe('INVALID_ARGUMENT/REVIEW_NOTE_NOT_EMPTY');
      const rejected = expectOk(
        await call<medicalRecord.DraftReviewResponse>(
          'ReviewDraft',
          { id: draft?.id, approved: false, reviewNote: 'Yanlış belge' },
          token,
        ),
        'ReviewDraft',
      ).draftReview;
      expect(rejected).toMatchObject({
        status: medicalRecord.DraftReviewStatus.REJECTED,
        reviewNote: 'Yanlış belge',
        createdRecordId: '',
      });
    });

    it('analysis_failed belgeyi FAILED yapar ve hata kodunu saklar', async () => {
      const document = await registered();
      await bus.publishAiEvent('analysis_failed', {
        documentId: document.id,
        modelVersion: 'fake-ai-1',
        errorCode: 'UNREADABLE',
        errorMessage: 'Belge okunamadı',
      });
      await waitFor(
        async () => (await documentRow(document.id))?.status === 'FAILED',
      );
      expect((await documentRow(document.id)).failure_reason).toBe(
        'UNREADABLE',
      );
    });

    it("geçersiz olaylar DLQ'ya gider, belgeye dokunulmaz", async () => {
      const document = await registered();
      const before = await bus.messageCount(DOCUMENT_EVENTS_DLQ);
      const sent = [
        await bus.publishRaw(
          'com.patipasaport.document.analyzed.v1',
          'json değil {',
        ),
        await bus.publishAiEvent(
          'analyzed',
          analyzed(document.id, {
            type: 'RECORD_TYPE_UNSPECIFIED',
            title: 'X',
            recordedAt: today,
          }),
        ),
        await bus.publishAiEvent('analyzed', {
          ...analyzed(document.id, {
            type: 'EXAMINATION',
            title: 'X',
            recordedAt: today,
          }),
          confidence: 1.5,
        }),
        await bus.publishAiEvent(
          'analyzed',
          analyzed(randomUUID(), {
            type: 'EXAMINATION',
            title: 'X',
            recordedAt: today,
          }),
        ),
      ];
      sent.forEach((id) => data.trackMessage(id));

      await waitFor(
        async () =>
          (await bus.messageCount(DOCUMENT_EVENTS_DLQ)) >= before + sent.length,
        15_000,
      );
      expect((await documentRow(document.id)).status).toBe('QUEUED');
    });
  });
});
