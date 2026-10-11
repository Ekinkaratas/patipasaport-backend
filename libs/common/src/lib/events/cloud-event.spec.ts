import {
  CLOUD_EVENT_SOURCES,
  createCloudEvent,
  DOCUMENT_EVENT_SCHEMAS,
  DOCUMENT_EVENT_TYPES,
  parseCloudEvent,
} from './cloud-event';

const DOCUMENT_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ---Amaç: belge yüklendi olayını varsayılan id ve zamanla oluşturmak ---
const uploaded = () =>
  createCloudEvent({
    type: DOCUMENT_EVENT_TYPES.UPLOADED,
    source: CLOUD_EVENT_SOURCES.MEDICAL_RECORD,
    subject: DOCUMENT_ID,
    data: { documentId: DOCUMENT_ID },
  });

// ---Amaç: CloudEvents zarfının standart alanlarla ve URN şemasıyla kurulduğunu doğrulamak ---
describe('createCloudEvent', () => {
  it('zarfı onaylanan değerlerle kurar', () => {
    const event = uploaded();

    expect(event).toEqual({
      specversion: '1.0',
      id: expect.stringMatching(UUID_PATTERN),
      source: '/patipasaport/medical-record',
      type: 'com.patipasaport.document.uploaded.v1',
      subject: DOCUMENT_ID,
      time: expect.any(String),
      datacontenttype: 'application/json',
      dataschema: 'urn:patipasaport:events:DocumentUploaded:v1',
      data: { documentId: DOCUMENT_ID },
    });
    expect(new Date(event.time).toISOString()).toBe(event.time);
  });

  it('her olaya yeni id verir', () =>
    expect(uploaded().id).not.toBe(uploaded().id));

  it('verilen id ve zamanı kullanır', () => {
    const event = createCloudEvent({
      type: DOCUMENT_EVENT_TYPES.ANALYZED,
      source: CLOUD_EVENT_SOURCES.AI_SERVICE,
      subject: DOCUMENT_ID,
      data: {},
      id: 'sabit-id',
      time: new Date('2026-10-11T12:00:00.000Z'),
    });

    expect(event.id).toBe('sabit-id');
    expect(event.time).toBe('2026-10-11T12:00:00.000Z');
    expect(event.dataschema).toBe(
      'urn:patipasaport:events:DocumentAnalyzed:v1',
    );
  });

  it('her olay türünün URN şeması tanımlıdır', () =>
    expect(DOCUMENT_EVENT_SCHEMAS).toEqual({
      'com.patipasaport.document.uploaded.v1':
        'urn:patipasaport:events:DocumentUploaded:v1',
      'com.patipasaport.document.processing_started.v1':
        'urn:patipasaport:events:DocumentProcessingStarted:v1',
      'com.patipasaport.document.analyzed.v1':
        'urn:patipasaport:events:DocumentAnalyzed:v1',
      'com.patipasaport.document.analysis_failed.v1':
        'urn:patipasaport:events:DocumentAnalysisFailed:v1',
    }));
});

// ---Amaç: kuyruktan gelen zarfın standart alanlarını doğrulayıp geçersizleri reddetmek ---
describe('parseCloudEvent', () => {
  const valid = () => JSON.parse(JSON.stringify(uploaded()));

  it('geçerli zarfı aynen döndürür', () => {
    const raw = valid();
    expect(parseCloudEvent(raw)).toEqual(raw);
  });

  it('bilinmeyen ek alanları atar', () =>
    expect(parseCloudEvent({ ...valid(), extra: 'x' })).not.toHaveProperty(
      'extra',
    ));

  it.each([
    ['nesne değil', 'metin'],
    ['null', null],
    ['dizi', []],
  ])('%s → null', (_n, raw) => expect(parseCloudEvent(raw)).toBeNull());

  it.each([
    ['specversion 0.3', { specversion: '0.3' }],
    ['id boş', { id: '' }],
    ['source yok', { source: undefined }],
    ['type bilinmiyor', { type: 'com.patipasaport.document.deleted.v1' }],
    ['subject boş', { subject: '  ' }],
    ['time tarih değil', { time: 'dün' }],
    ['datacontenttype farklı', { datacontenttype: 'application/protobuf' }],
    [
      'dataschema başka türe ait',
      { dataschema: 'urn:patipasaport:events:DocumentAnalyzed:v1' },
    ],
    ['dataschema göreli yol', { dataschema: 'proto/events/events.proto' }],
    ['data yok', { data: undefined }],
    ['data dizi', { data: [] }],
  ])('%s → null', (_n, override) =>
    expect(parseCloudEvent({ ...valid(), ...override })).toBeNull(),
  );
});
