import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Logger,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { createHash } from 'crypto';
import { of, throwError } from 'rxjs';
import { ResponseMessages } from '@libs/common';
import { ApiClinicsService } from './clinics.service';
import { DocumentStorageService } from '../storage/document-storage.service';
import {
  PetResultFileInterceptor,
  petResultFilePipe,
  UploadedPetResultFile,
} from './pet-result-upload';

const CLINIC_ID = '6e2d4c1b-7a3f-4e8d-a1b2-c3d4e5f60718';
const PET_ID = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b';
const KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(pdf|jpg|png)$/;
const PDF = Buffer.from('%PDF-1.4 deneme');

// ---Amaç: multer'ın belleğe aldığı ve türü doğrulanmış dosyayı üretmek ---
const file = (
  over: Partial<UploadedPetResultFile> = {},
): UploadedPetResultFile => ({
  originalname: 'Kan Tahlili ğüşiöç.pdf',
  mimetype: 'application/pdf',
  size: PDF.length,
  buffer: PDF,
  ...over,
});

// ---Amaç: alt servisten dönen gRPC hatasını taklit etmek ---
const grpcError = (code: number, details?: string) =>
  Object.assign(new Error(details ?? 'grpc hatası'), { code, details });

describe('ApiClinicsService.uploadPetResult', () => {
  let service: ApiClinicsService;
  let storage: { put: jest.Mock; delete: jest.Mock };
  let clinicsClient: { uploadPetResult: jest.Mock };
  const response = {
    documentId: 'belge-1',
    uploadedAt: '2026-10-13T08:30:00.000Z',
    status: 'QUEUED',
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    storage = {
      put: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    clinicsClient = {
      uploadPetResult: jest.fn().mockReturnValue(of(response)),
    };
    service = new ApiClinicsService(
      { getService: () => clinicsClient } as unknown as ClientGrpc,
      storage as unknown as DocumentStorageService,
    );
    service.onModuleInit();
  });

  afterEach(() => jest.restoreAllMocks());

  // ---Amaç: dosyanın depoya yazılıp referansının clinics'e doğrulanmış olarak iletildiğini doğrulamak ---
  it("dosya depoya yazılır, referans clinics'e iletilir, 201 yanıtı döner", async () => {
    const result = await service.uploadPetResult(
      { clinicId: CLINIC_ID, petId: PET_ID, note: '  Açlık kan şekeri  ' },
      file(),
    );

    const [key, body, contentType] = storage.put.mock.calls[0];
    expect(key).toMatch(KEY_PATTERN);
    expect(key.endsWith('.pdf')).toBe(true);
    expect(body).toBe(PDF);
    expect(contentType).toBe('application/pdf');
    expect(clinicsClient.uploadPetResult).toHaveBeenCalledWith(
      expect.objectContaining({
        clinicId: CLINIC_ID,
        petId: PET_ID,
        storagePath: key,
        originalName: 'Kan Tahlili ğüşiöç.pdf',
        mimeType: 'application/pdf',
        sizeBytes: PDF.length,
        note: 'Açlık kan şekeri',
        sha256: createHash('sha256').update(PDF).digest('hex'),
      }),
    );
    expect(result).toMatchObject({
      data: response,
      message: ResponseMessages.CREATED,
      success: true,
    });
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it.each([
    ['image/jpeg', '.jpg'],
    ['image/png', '.png'],
  ])('%s için anahtar uzantısı %s', async (mimetype, extension) => {
    await service.uploadPetResult(
      { clinicId: CLINIC_ID, petId: PET_ID },
      file({ mimetype }),
    );
    expect(storage.put.mock.calls[0][0].endsWith(extension)).toBe(true);
  });

  // ---Amaç: geçersiz istekte depoya hiçbir şey yazılmadığını doğrulamak ---
  it.each([
    [
      'clinicId UUID değil',
      { clinicId: 'abc', petId: PET_ID },
      file(),
      'CLINIC_ID_WRONG DATA FORMAT',
    ],
    [
      'petId UUID değil',
      { clinicId: CLINIC_ID, petId: 'abc' },
      file(),
      'PET_ID_WRONG DATA FORMAT',
    ],
    [
      'not 501 karakter',
      { clinicId: CLINIC_ID, petId: PET_ID, note: 'a'.repeat(501) },
      file(),
      'NOTE_MAX_LENGTH|500',
    ],
    [
      'dosya adı 256 karakter',
      { clinicId: CLINIC_ID, petId: PET_ID },
      file({ originalname: `${'a'.repeat(252)}.pdf` }),
      'ORIGINAL_NAME_MAX_LENGTH|255',
    ],
  ])('%s → 400, depoya yazılmaz', async (_n, form, upload, message) => {
    const error = await service
      .uploadPetResult(form, upload)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(
      JSON.stringify((error as BadRequestException).getResponse()),
    ).toContain(message);
    expect(storage.put).not.toHaveBeenCalled();
    expect(clinicsClient.uploadPetResult).not.toHaveBeenCalled();
  });

  it('depoya yazılamazsa 503, clinics çağrılmaz', async () => {
    storage.put.mockRejectedValue(new Error('SeaweedFS kapalı'));
    const error = await service
      .uploadPetResult({ clinicId: CLINIC_ID, petId: PET_ID }, file())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toBe(ResponseMessages.SERVICE_UNAVAILABLE);
    expect(clinicsClient.uploadPetResult).not.toHaveBeenCalled();
  });

  // ---Amaç: kayıt başarısız olunca yalnızca bu istekte yüklenen dosyanın geri silindiğini doğrulamak ---
  it.each([
    [
      'rıza yok',
      grpcError(status.PERMISSION_DENIED, ResponseMessages.FORBIDDEN),
    ],
    ['clinics kapalı', grpcError(status.UNAVAILABLE)],
  ])('%s → yüklenen dosya silinir, hata aynen döner', async (_n, failure) => {
    clinicsClient.uploadPetResult.mockReturnValue(throwError(() => failure));
    await expect(
      service.uploadPetResult({ clinicId: CLINIC_ID, petId: PET_ID }, file()),
    ).rejects.toBe(failure);
    expect(storage.delete).toHaveBeenCalledWith(storage.put.mock.calls[0][0]);
  });

  it('zaman aşımında belge oluşmuş olabileceği için dosya silinmez', async () => {
    const failure = grpcError(status.DEADLINE_EXCEEDED);
    clinicsClient.uploadPetResult.mockReturnValue(throwError(() => failure));
    await expect(
      service.uploadPetResult({ clinicId: CLINIC_ID, petId: PET_ID }, file()),
    ).rejects.toBe(failure);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining('dosya silinmedi'),
    );
  });

  it('geri silme de başarısız olursa loglanır, asıl hata korunur', async () => {
    const failure = grpcError(
      status.PERMISSION_DENIED,
      ResponseMessages.FORBIDDEN,
    );
    clinicsClient.uploadPetResult.mockReturnValue(throwError(() => failure));
    storage.delete.mockRejectedValue(new Error('silinemedi'));
    await expect(
      service.uploadPetResult({ clinicId: CLINIC_ID, petId: PET_ID }, file()),
    ).rejects.toBe(failure);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining('yüklenen dosya silinemedi'),
    );
  });
});

// ---Amaç: dosya doğrulama pipe'ının ve boyut hatası eşlemesinin proje mesaj kodlarını döndürdüğünü doğrulamak ---
describe('pet-result-upload', () => {
  afterEach(() => jest.restoreAllMocks());

  it('dosya yoksa FILE_NOT_EMPTY', async () => {
    const error = await petResultFilePipe()
      .transform(undefined)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe('FILE_NOT_EMPTY');
  });

  it('10 MB sınırı aşılırsa SIZE_BYTES_MAX|10485760 (400)', async () => {
    const parent = Object.getPrototypeOf(PetResultFileInterceptor.prototype);
    jest
      .spyOn(parent, 'intercept')
      .mockRejectedValue(new PayloadTooLargeException('File too large'));
    const error = await new PetResultFileInterceptor()
      .intercept({} as ExecutionContext, {} as CallHandler)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe('SIZE_BYTES_MAX|10485760');
  });

  it('diğer multer hataları olduğu gibi geçer', async () => {
    const parent = Object.getPrototypeOf(PetResultFileInterceptor.prototype);
    const original = new BadRequestException('Unexpected field - belge');
    jest.spyOn(parent, 'intercept').mockRejectedValue(original);
    await expect(
      new PetResultFileInterceptor().intercept(
        {} as ExecutionContext,
        {} as CallHandler,
      ),
    ).rejects.toBe(original);
  });
});
