import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
  StreamableFile,
} from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { NoSuchKey } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { firstValueFrom } from 'rxjs';
import { medicalRecord } from '@libs/proto';
import { BaseResponse, getCorrelationId, ResponseMessages } from '@libs/common';
import {
  CreateRecordRequestDto,
  GetDocumentFileRequestDto,
  ReviewDraftRequestDto,
} from '@libs/dto';
import {
  DocumentIntegrityError,
  DocumentStorageService,
} from '../storage/document-storage.service';
import { contentDisposition } from './content-disposition';

@Injectable()
export class ApiMedicalRecordService implements OnModuleInit {
  private readonly logger = new Logger(ApiMedicalRecordService.name);
  private medicalRecordClient!: medicalRecord.MedicalRecordServiceClient;

  constructor(
    @Inject('MEDICAL_RECORD_SERVICE') private readonly client: ClientGrpc,
    private readonly storage: DocumentStorageService,
  ) {}

  onModuleInit() {
    this.medicalRecordClient =
      this.client.getService<medicalRecord.MedicalRecordServiceClient>(
        medicalRecord.MEDICAL_RECORD_SERVICE_NAME,
      );
  }

  private static ok<T>(data: T): BaseResponse<T> {
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }

  async listRecordsByPet(
    request: medicalRecord.ListRecordsByPetRequest,
  ): Promise<BaseResponse<medicalRecord.ListRecordsResponse>> {
    return ApiMedicalRecordService.ok(
      await firstValueFrom(this.medicalRecordClient.listRecordsByPet(request)),
    );
  }

  async listVaccinations(
    request: medicalRecord.ListVaccinationsRequest,
  ): Promise<BaseResponse<medicalRecord.ListVaccinationsResponse>> {
    return ApiMedicalRecordService.ok(
      await firstValueFrom(this.medicalRecordClient.listVaccinations(request)),
    );
  }

  async listPrescriptions(
    request: medicalRecord.ListPrescriptionsRequest,
  ): Promise<BaseResponse<medicalRecord.ListPrescriptionsResponse>> {
    return ApiMedicalRecordService.ok(
      await firstValueFrom(this.medicalRecordClient.listPrescriptions(request)),
    );
  }

  async listLabResults(
    request: medicalRecord.ListLabResultsRequest,
  ): Promise<BaseResponse<medicalRecord.ListLabResultsResponse>> {
    return ApiMedicalRecordService.ok(
      await firstValueFrom(this.medicalRecordClient.listLabResults(request)),
    );
  }

  async getLabExplanation(
    request: medicalRecord.GetLabExplanationRequest,
  ): Promise<BaseResponse<medicalRecord.LabExplanationResponse>> {
    return ApiMedicalRecordService.ok(
      await firstValueFrom(this.medicalRecordClient.getLabExplanation(request)),
    );
  }

  async createRecord(
    request: CreateRecordRequestDto,
  ): Promise<BaseResponse<medicalRecord.RecordResponse>> {
    const data = await firstValueFrom(
      this.medicalRecordClient.createRecord({
        petId: request.petId,
        content: request.content,
        attachments: (request.attachments ?? []).map((attachment) => ({
          documentId: attachment.documentId,
          storagePath: '',
          originalName: '',
          mimeType: '',
          sizeBytes: 0,
          uploadedAt: '',
        })),
      }),
    );
    return new BaseResponse(
      data,
      ResponseMessages.CREATED,
      true,
      getCorrelationId(),
    );
  }

  async getDocument(
    request: medicalRecord.GetDocumentRequest,
  ): Promise<BaseResponse<medicalRecord.DocumentResponse>> {
    return ApiMedicalRecordService.ok(
      await firstValueFrom(this.medicalRecordClient.getDocument(request)),
    );
  }

  async listDocumentsByPet(
    request: medicalRecord.ListDocumentsByPetRequest,
  ): Promise<BaseResponse<medicalRecord.ListDocumentsResponse>> {
    return ApiMedicalRecordService.ok(
      await firstValueFrom(
        this.medicalRecordClient.listDocumentsByPet(request),
      ),
    );
  }

  async getDocumentFile(
    request: GetDocumentFileRequestDto,
  ): Promise<StreamableFile> {
    const { document } = await firstValueFrom(
      this.medicalRecordClient.getDocument({ id: request.id }),
    );
    if (!document) {
      this.logger.error(
        `getDocumentFile: medical_record.getDocument boş yanıt döndü (documentId=${request.id})`,
      );
      throw new InternalServerErrorException(
        ResponseMessages.INTERNAL_SERVER_ERROR,
      );
    }

    const content = await this.readDocument(document);
    return new StreamableFile(content, {
      type: document.mimeType,
      length: content.length,
      disposition: contentDisposition(
        request.download ? 'attachment' : 'inline',
        document.originalName,
      ),
    });
  }

  private async readDocument(
    document: medicalRecord.Document,
  ): Promise<Buffer> {
    let content: Buffer;
    try {
      content = await this.storage.get(
        document.storagePath,
        document.sizeBytes,
      );
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (e instanceof DocumentIntegrityError) {
        this.logger.error(
          `getDocumentFile: belge bütünlüğü bozuk (documentId=${document.id}): ${reason}`,
        );
        throw new InternalServerErrorException(
          ResponseMessages.INTERNAL_SERVER_ERROR,
        );
      }
      if (e instanceof NoSuchKey) {
        this.logger.error(
          `getDocumentFile: belge kaydı var ama dosya depoda yok (documentId=${document.id} storagePath=${document.storagePath})`,
        );
        throw new NotFoundException(ResponseMessages.NOT_FOUND);
      }
      this.logger.error(
        `getDocumentFile: dosya depodan okunamadı (documentId=${document.id}): ${reason}`,
      );
      throw new ServiceUnavailableException(
        ResponseMessages.SERVICE_UNAVAILABLE,
      );
    }

    const sha256 = createHash('sha256').update(content).digest('hex');
    if (sha256 !== document.sha256) {
      this.logger.error(
        `getDocumentFile: belge bütünlüğü bozuk, sha256 uyuşmuyor (documentId=${document.id})`,
      );
      throw new InternalServerErrorException(
        ResponseMessages.INTERNAL_SERVER_ERROR,
      );
    }
    return content;
  }

  async listDraftReviews(
    request: medicalRecord.ListDraftReviewsRequest,
  ): Promise<BaseResponse<medicalRecord.ListDraftReviewsResponse>> {
    return ApiMedicalRecordService.ok(
      await firstValueFrom(this.medicalRecordClient.listDraftReviews(request)),
    );
  }

  async reviewDraft(
    request: ReviewDraftRequestDto,
  ): Promise<BaseResponse<medicalRecord.DraftReviewResponse>> {
    return ApiMedicalRecordService.ok(
      await firstValueFrom(this.medicalRecordClient.reviewDraft(request)),
    );
  }
}
