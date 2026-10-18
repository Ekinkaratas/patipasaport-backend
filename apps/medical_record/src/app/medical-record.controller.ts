import { Controller } from '@nestjs/common';
import { GrpcMethod, Payload } from '@nestjs/microservices';
import { AuthUser, CurrentUser, Roles } from '@libs/common';
import {
  CreateRecordRequestDto,
  GetDocumentRequestDto,
  ListDocumentsByPetRequestDto,
  ListDraftReviewsRequestDto,
  ListLabResultsRequestDto,
  ListPrescriptionsRequestDto,
  ListRecordsByPetRequestDto,
  ListVaccinationsRequestDto,
  RegisterDocumentRequestDto,
  ReviewDraftRequestDto,
} from '@libs/dto';
import { medicalRecord } from '@libs/proto';
import { MedicalRecordService } from './medical-record.service';

@Controller()
export class MedicalRecordController {
  constructor(private readonly medicalRecordService: MedicalRecordService) {}

  @Roles(['PET_OWNER', 'CLINIC'])
  @GrpcMethod(medicalRecord.MEDICAL_RECORD_SERVICE_NAME, 'ListRecordsByPet')
  async listRecordsByPet(
    @Payload() request: ListRecordsByPetRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<medicalRecord.ListRecordsResponse> {
    return this.medicalRecordService.listRecordsByPet(request, user);
  }

  @Roles(['CLINIC'])
  @GrpcMethod(medicalRecord.MEDICAL_RECORD_SERVICE_NAME, 'CreateRecord')
  async createRecord(
    @Payload() request: CreateRecordRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<medicalRecord.RecordResponse> {
    return this.medicalRecordService.createRecord(request, user);
  }

  @Roles(['PET_OWNER', 'CLINIC'])
  @GrpcMethod(medicalRecord.MEDICAL_RECORD_SERVICE_NAME, 'ListVaccinations')
  async listVaccinations(
    @Payload() request: ListVaccinationsRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<medicalRecord.ListVaccinationsResponse> {
    return this.medicalRecordService.listVaccinations(request, user);
  }

  @Roles(['PET_OWNER', 'CLINIC'])
  @GrpcMethod(medicalRecord.MEDICAL_RECORD_SERVICE_NAME, 'ListPrescriptions')
  async listPrescriptions(
    @Payload() request: ListPrescriptionsRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<medicalRecord.ListPrescriptionsResponse> {
    return this.medicalRecordService.listPrescriptions(request, user);
  }

  @Roles(['PET_OWNER', 'CLINIC'])
  @GrpcMethod(medicalRecord.MEDICAL_RECORD_SERVICE_NAME, 'ListLabResults')
  async listLabResults(
    @Payload() request: ListLabResultsRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<medicalRecord.ListLabResultsResponse> {
    return this.medicalRecordService.listLabResults(request, user);
  }

  @Roles(['CLINIC'])
  @GrpcMethod(medicalRecord.MEDICAL_RECORD_SERVICE_NAME, 'RegisterDocument')
  async registerDocument(
    @Payload() request: RegisterDocumentRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<medicalRecord.DocumentResponse> {
    return this.medicalRecordService.registerDocument(request, user);
  }

  @Roles(['PET_OWNER', 'CLINIC'])
  @GrpcMethod(medicalRecord.MEDICAL_RECORD_SERVICE_NAME, 'GetDocument')
  async getDocument(
    @Payload() request: GetDocumentRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<medicalRecord.DocumentResponse> {
    return this.medicalRecordService.getDocument(request, user);
  }

  @Roles(['PET_OWNER', 'CLINIC'])
  @GrpcMethod(medicalRecord.MEDICAL_RECORD_SERVICE_NAME, 'ListDocumentsByPet')
  async listDocumentsByPet(
    @Payload() request: ListDocumentsByPetRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<medicalRecord.ListDocumentsResponse> {
    return this.medicalRecordService.listDocumentsByPet(request, user);
  }

  @Roles(['CLINIC'])
  @GrpcMethod(medicalRecord.MEDICAL_RECORD_SERVICE_NAME, 'ListDraftReviews')
  async listDraftReviews(
    @Payload() request: ListDraftReviewsRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<medicalRecord.ListDraftReviewsResponse> {
    return this.medicalRecordService.listDraftReviews(request, user);
  }

  @Roles(['CLINIC'])
  @GrpcMethod(medicalRecord.MEDICAL_RECORD_SERVICE_NAME, 'ReviewDraft')
  async reviewDraft(
    @Payload() request: ReviewDraftRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<medicalRecord.DraftReviewResponse> {
    return this.medicalRecordService.reviewDraft(request, user);
  }
}
