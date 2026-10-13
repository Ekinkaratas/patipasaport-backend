import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { medicalRecord } from '@libs/proto';
import { BaseResponse, getCorrelationId, ResponseMessages } from '@libs/common';
import { CreateRecordRequestDto, ReviewDraftRequestDto } from '@libs/dto';

@Injectable()
export class ApiMedicalRecordService implements OnModuleInit {
  private medicalRecordClient!: medicalRecord.MedicalRecordServiceClient;

  constructor(
    @Inject('MEDICAL_RECORD_SERVICE') private readonly client: ClientGrpc,
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
