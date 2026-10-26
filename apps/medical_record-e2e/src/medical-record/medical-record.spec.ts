import { Client } from '@grpc/grpc-js';
import {
  AI_LAB_EXPLANATION_QUEUE,
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
  LAB_EXPLANATION_EVENTS_DLQ,
  LAB_EXPLANATION_EVENTS_QUEUE,
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

  describe('tahlil açıklaması', () => {
    const { LabExplanationStatus } = medicalRecord;
    const sampledAt = shiftDays(today, -1);
    const birthDate = shiftDays(today, -800);
    let labPetId: string;
    let approvedRecordId: string;

    const labContent = () => ({
      type: medicalRecord.RecordType.LAB_RESULT,
      title: 'Biyokimya paneli',
      notes: 'Açlık kan şekeri',
      recordedAt: sampledAt,
      labResult: {
        sampledAt,
        items: [
          {
            testName: 'ALT',
            value: '142',
            unit: 'U/L',
            referenceRange: '12-130',
            flag: medicalRecord.LabResultFlag.HIGH,
          },
          {
            testName: 'Kreatinin',
            value: '1.4',
            unit: '',
            referenceRange: '',
            flag: medicalRecord.LabResultFlag.LAB_RESULT_FLAG_UNSPECIFIED,
          },
        ],
      },
    });

    const expectedData = (recordId: string) => ({
      recordId,
      title: 'Biyokimya paneli',
      sampledAt,
      species: 'DOG',
      birthDate,
      isBirthDateEstimated: true,
      items: [
        {
          testName: 'ALT',
          value: '142',
          unit: 'U/L',
          referenceRange: '12-130',
          flag: 'HIGH',
        },
        {
          testName: 'Kreatinin',
          value: '1.4',
          unit: '',
          referenceRange: '',
          flag: 'LAB_RESULT_FLAG_UNSPECIFIED',
        },
      ],
    });

    const generated = (recordId: string, over: object = {}) => ({
      recordId,
      modelVersion: 'fake-ai-1/explain-v1',
      confidence: 0.82,
      explanation: {
        summary: 'Değerlerin çoğu referans aralığında.',
        items: [{ testName: 'ALT', explanation: 'ALT karaciğer enzimidir.' }],
      },
      generatedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    });

    const explanationRow = async (recordId: string) =>
      (
        await (
          await data.db('medical_record')
        ).query<{
          status: string;
          summary: string | null;
          items: unknown;
          confidence: number | null;
          model_version: string | null;
          failure_reason: string | null;
          generated_at: Date | null;
        }>(
          'SELECT status::text, summary, items, confidence, model_version, failure_reason, generated_at FROM lab_result_explanations WHERE record_id = $1',
          [recordId],
        )
      ).rows[0];

    const takeRequest = async (recordId: string) => {
      const [message] = await waitFor(async () => {
        const taken = await bus.takeWhere(
          AI_LAB_EXPLANATION_QUEUE,
          (m) => messageSubject(m) === recordId,
        );
        return taken.length > 0 ? taken : undefined;
      });
      return message;
    };

    const createRecord = async (content: object) =>
      expectOk(
        await call<medicalRecord.RecordResponse>(
          'CreateRecord',
          { petId: labPetId, content, attachments: [] },
          await clinicToken(clinicA.id),
        ),
        'CreateRecord',
      ).record as medicalRecord.MedicalRecord;

    const createLabRecord = async () => {
      const record = await createRecord(labContent());
      await takeRequest(record.id);
      return record;
    };

    const getExplanation = async (recordId: string, token?: string) =>
      call<medicalRecord.LabExplanationResponse>(
        'GetLabExplanation',
        { recordId },
        token ?? (await ownerToken()),
      );

    beforeAll(async () => {
      const ownerJwt = await ownerToken();
      labPetId =
        expectOk(
          await callGrpc<pets.PetResponse>(
            petsClient,
            'CreatePet',
            {
              name: 'Zeytin',
              species: 'DOG',
              breed: 'KANGAL',
              sex: pets.PetSex.MALE,
              birthDate,
              isBirthDateEstimated: true,
              isNeutered: false,
              chipNumber: '',
              ownerUserId: owner.id,
            },
            ownerJwt,
          ),
          'pets.CreatePet',
        ).pet?.id ?? '';
      data.trackPet(labPetId);
      expectOk(
        await callGrpc<access.ConsentResponse>(
          accessClient,
          'GrantConsent',
          {
            clinicId: clinicA.id,
            petId: labPetId,
            scopes: ['medical_read', 'medical_write'],
            expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          },
          ownerJwt,
        ),
        'access.GrantConsent',
      );
    });

    it('LAB_RESULT taslağı onaylanınca istek AI kuyruğuna doğru veriyle düşer, açıklama satırı PENDING olur', async () => {
      const document = expectOk(
        await register(undefined, { petId: labPetId }),
        'RegisterDocument',
      ).document as medicalRecord.Document;
      await bus.publishAiEvent('analyzed', {
        documentId: document.id,
        modelVersion: 'fake-ai-1',
        confidence: 0.9,
        analyzedAt: new Date().toISOString(),
        proposal: {
          type: 'LAB_RESULT',
          title: 'Biyokimya paneli',
          notes: 'Açlık kan şekeri',
          recordedAt: sampledAt,
          labResult: {
            sampledAt,
            items: [
              {
                testName: 'ALT',
                value: '142',
                unit: 'U/L',
                referenceRange: '12-130',
                flag: 'HIGH',
              },
              { testName: 'Kreatinin', value: '1.4' },
            ],
          },
        },
      });
      await waitFor(
        async () => (await documentRow(document.id))?.status === 'DRAFT_READY',
      );

      const token = await clinicToken(clinicA.id);
      const draft = expectOk(
        await call<medicalRecord.ListDraftReviewsResponse>(
          'ListDraftReviews',
          { petId: labPetId, page: 1, pageSize: 8 },
          token,
        ),
        'ListDraftReviews',
      ).draftReviews.find((d) => d.documentId === document.id);
      approvedRecordId =
        expectOk(
          await call<medicalRecord.DraftReviewResponse>(
            'ReviewDraft',
            { id: draft?.id, approved: true },
            token,
          ),
          'ReviewDraft',
        ).draftReview?.createdRecordId ?? '';
      expect(approvedRecordId).not.toBe('');

      const message = await takeRequest(approvedRecordId);
      const event = JSON.parse(message.content.toString('utf8'));
      expect(message.properties).toMatchObject({
        contentType: 'application/cloudevents+json',
        type: 'com.patipasaport.lab_explanation.requested.v1',
        messageId: event.id,
        deliveryMode: 2,
      });
      expect(event).toMatchObject({
        specversion: '1.0',
        source: '/patipasaport/medical-record',
        type: 'com.patipasaport.lab_explanation.requested.v1',
        subject: approvedRecordId,
        datacontenttype: 'application/json',
        dataschema: 'urn:patipasaport:events:LabExplanationRequested:v1',
      });
      expect(event.data).toEqual(expectedData(approvedRecordId));
      expect((await explanationRow(approvedRecordId)).status).toBe('PENDING');
    });

    it('sahte generated olayı satırı READY yapar ve hasta sahibi açıklamayı okur; ikinci sonuçlar yok sayılır', async () => {
      const startedAt = Date.now();
      expect(
        expectOk(await getExplanation(approvedRecordId), 'GetLabExplanation'),
      ).toEqual({
        status: LabExplanationStatus.LAB_EXPLANATION_PENDING,
        summary: '',
        items: [],
        confidence: 0,
        generatedAt: '',
      });

      await bus.publishAiEvent(
        'lab_explanation_generated',
        generated(approvedRecordId, {
          confidence: 1.3,
          explanation: {
            summary: '  Değerlerin çoğu referans aralığında.  ',
            items: [
              { testName: ' ALT ', explanation: 'ALT karaciğer enzimidir.' },
            ],
          },
        }),
      );
      await waitFor(
        async () =>
          (await explanationRow(approvedRecordId))?.status === 'READY',
      );
      const row = await explanationRow(approvedRecordId);
      expect(row).toMatchObject({
        summary: 'Değerlerin çoğu referans aralığında.',
        items: [{ testName: 'ALT', explanation: 'ALT karaciğer enzimidir.' }],
        confidence: 1,
        model_version: 'fake-ai-1/explain-v1',
        failure_reason: null,
      });

      const ready = expectOk(
        await getExplanation(approvedRecordId),
        'GetLabExplanation',
      );
      expect(ready).toMatchObject({
        status: LabExplanationStatus.LAB_EXPLANATION_READY,
        summary: 'Değerlerin çoğu referans aralığında.',
        items: [{ testName: 'ALT', explanation: 'ALT karaciğer enzimidir.' }],
        confidence: 1,
      });
      expect(new Date(ready.generatedAt).toISOString()).toBe(ready.generatedAt);
      expect(Date.parse(ready.generatedAt)).toBeGreaterThanOrEqual(
        startedAt - 1_000,
      );

      const dlqBefore = await bus.messageCount(LAB_EXPLANATION_EVENTS_DLQ);
      await bus.publishAiEvent(
        'lab_explanation_generated',
        generated(approvedRecordId, {
          explanation: { summary: 'İkinci sonuç', items: [] },
        }),
      );
      await bus.publishAiEvent('lab_explanation_failed', {
        recordId: approvedRecordId,
        modelVersion: 'fake-ai-1/explain-v1',
        errorCode: 'INTERNAL_ERROR',
        errorMessage: 'Beklenmeyen hata',
        failedAt: new Date().toISOString(),
      });
      await waitFor(
        async () =>
          (await bus.messageCount(LAB_EXPLANATION_EVENTS_QUEUE)) === 0,
      );
      for (const deadline = Date.now() + 3_000; Date.now() < deadline; ) {
        expect(await explanationRow(approvedRecordId)).toEqual(row);
        await sleep(250);
      }
      expect(await explanationRow(approvedRecordId)).toEqual(row);
      expect(await bus.messageCount(LAB_EXPLANATION_EVENTS_DLQ)).toBe(
        dlqBefore,
      );
    });

    it('elle girilen LAB_RESULT kaydı da istek doğurur', async () => {
      const record = await createRecord(labContent());
      const message = await takeRequest(record.id);
      expect(JSON.parse(message.content.toString('utf8')).data).toEqual(
        expectedData(record.id),
      );
      expect((await explanationRow(record.id)).status).toBe('PENDING');
    });

    it('failed olayı satırı FAILED yapar; hasta sahibi yalnızca durumu görür', async () => {
      const record = await createLabRecord();
      await bus.publishAiEvent('lab_explanation_failed', {
        recordId: record.id,
        modelVersion: 'fake-ai-1/explain-v1',
        errorCode: 'AI_PROVIDER_UNAVAILABLE',
        errorMessage: "AI API'ye 5 denemede ulaşılamadı",
        failedAt: new Date().toISOString(),
      });
      await waitFor(
        async () => (await explanationRow(record.id))?.status === 'FAILED',
      );
      expect((await explanationRow(record.id)).failure_reason).toBe(
        'AI_PROVIDER_UNAVAILABLE',
      );
      expect(
        expectOk(await getExplanation(record.id), 'GetLabExplanation'),
      ).toEqual({
        status: LabExplanationStatus.LAB_EXPLANATION_FAILED,
        summary: '',
        items: [],
        confidence: 0,
        generatedAt: '',
      });
    });

    it('kurallara uymayan açıklama satırı FAILED (INVALID_AI_OUTPUT) yapar', async () => {
      const record = await createLabRecord();
      await bus.publishAiEvent(
        'lab_explanation_generated',
        generated(record.id, {
          explanation: {
            summary: 'Özet',
            items: [{ testName: 'AST', explanation: 'Kayıtta olmayan test.' }],
          },
        }),
      );
      await waitFor(
        async () => (await explanationRow(record.id))?.status === 'FAILED',
      );
      expect(await explanationRow(record.id)).toMatchObject({
        failure_reason: 'INVALID_AI_OUTPUT',
        model_version: 'fake-ai-1/explain-v1',
        summary: null,
        items: null,
        generated_at: null,
      });
    });

    it("bozuk modelVersion ve satırı olmayan kayıt DLQ'ya gider, satıra dokunulmaz", async () => {
      const record = await createLabRecord();
      const before = await bus.messageCount(LAB_EXPLANATION_EVENTS_DLQ);
      const sent = [
        await bus.publishAiEvent(
          'lab_explanation_generated',
          generated(record.id, { modelVersion: 'm'.repeat(65) }),
        ),
        await bus.publishAiEvent(
          'lab_explanation_generated',
          generated(record.id, { modelVersion: '' }),
        ),
        await bus.publishAiEvent('lab_explanation_failed', {
          recordId: randomUUID(),
          modelVersion: 'fake-ai-1/explain-v1',
          errorCode: 'INTERNAL_ERROR',
        }),
      ];
      sent.forEach((id) => data.trackMessage(id));

      await waitFor(
        async () =>
          (await bus.messageCount(LAB_EXPLANATION_EVENTS_DLQ)) >=
          before + sent.length,
        15_000,
      );
      expect((await explanationRow(record.id)).status).toBe('PENDING');
    });

    it('klinik FORBIDDEN; başka sahip, olmayan kayıt NOT_FOUND; bozuk kimlik INVALID_ARGUMENT alır', async () => {
      const record = await createLabRecord();
      expect(
        outcome(await getExplanation(record.id, await clinicToken(clinicA.id))),
      ).toBe('PERMISSION_DENIED/FORBIDDEN');
      expect(
        outcome(
          await getExplanation(
            record.id,
            await tokens.jwtFor({ role: 'PET_OWNER', userId: stranger.id }),
          ),
        ),
      ).toBe('NOT_FOUND/NOT_FOUND');
      expect(outcome(await getExplanation(randomUUID()))).toBe(
        'NOT_FOUND/NOT_FOUND',
      );
      expect(outcome(await getExplanation('abc'))).toBe(
        'INVALID_ARGUMENT/RECORD_ID_WRONG DATA FORMAT',
      );
    });

    it('tahlil olmayan kayıtta olay çıkmaz, açıklama NOT_FOUND döner', async () => {
      const record = await createRecord({
        type: medicalRecord.RecordType.EXAMINATION,
        title: 'Genel muayene',
        recordedAt: today,
      });
      const { rows } = await (
        await data.db('medical_record')
      ).query<{ count: number }>(
        "SELECT count(*)::int AS count FROM outbox WHERE payload->>'subject' = $1",
        [record.id],
      );
      expect(rows[0].count).toBe(0);
      expect(await explanationRow(record.id)).toBeUndefined();
      expect(outcome(await getExplanation(record.id))).toBe(
        'NOT_FOUND/NOT_FOUND',
      );
    });
  });
});
