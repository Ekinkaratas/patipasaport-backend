import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { BaseResponse, RequestWithParams } from '@libs/common';
import {
  CreateRecordRequestDto,
  GetDocumentFileRequestDto,
  GetDocumentRequestDto,
  ListDocumentsByPetRequestDto,
  ListDraftReviewsRequestDto,
  ListLabResultsRequestDto,
  ListPrescriptionsRequestDto,
  ListRecordsByPetRequestDto,
  ListVaccinationsRequestDto,
  ReviewDraftRequestDto,
} from '@libs/dto';
import { medicalRecord } from '@libs/proto';
import { ApiMedicalRecordService } from './medical-record.service';

@Controller()
export class ApiMedicalRecordController {
  constructor(private readonly medicalRecordService: ApiMedicalRecordService) {}

  @Get('pets/:petId/records')
  listRecordsByPet(
    @RequestWithParams('query') request: ListRecordsByPetRequestDto,
  ): Promise<BaseResponse<medicalRecord.ListRecordsResponse>> {
    return this.medicalRecordService.listRecordsByPet(request);
  }

  @Get('pets/:petId/vaccinations')
  listVaccinations(
    @RequestWithParams('query') request: ListVaccinationsRequestDto,
  ): Promise<BaseResponse<medicalRecord.ListVaccinationsResponse>> {
    return this.medicalRecordService.listVaccinations(request);
  }

  @Get('pets/:petId/prescriptions')
  listPrescriptions(
    @RequestWithParams('query') request: ListPrescriptionsRequestDto,
  ): Promise<BaseResponse<medicalRecord.ListPrescriptionsResponse>> {
    return this.medicalRecordService.listPrescriptions(request);
  }

  @Get('pets/:petId/lab-results')
  listLabResults(
    @RequestWithParams('query') request: ListLabResultsRequestDto,
  ): Promise<BaseResponse<medicalRecord.ListLabResultsResponse>> {
    return this.medicalRecordService.listLabResults(request);
  }

  @Post('pets/:petId/records')
  createRecord(
    @RequestWithParams('body') request: CreateRecordRequestDto,
  ): Promise<BaseResponse<medicalRecord.RecordResponse>> {
    return this.medicalRecordService.createRecord(request);
  }

  @Get('pets/:petId/documents')
  listDocumentsByPet(
    @RequestWithParams('query') request: ListDocumentsByPetRequestDto,
  ): Promise<BaseResponse<medicalRecord.ListDocumentsResponse>> {
    return this.medicalRecordService.listDocumentsByPet(request);
  }

  @Get('documents/:id')
  getDocument(
    @Param() request: GetDocumentRequestDto,
  ): Promise<BaseResponse<medicalRecord.DocumentResponse>> {
    return this.medicalRecordService.getDocument(request);
  }

  @Get('documents/:id/file')
  getDocumentFile(
    @RequestWithParams('query') request: GetDocumentFileRequestDto,
  ): Promise<StreamableFile> {
    return this.medicalRecordService.getDocumentFile(request);
  }

  @Get('draft-reviews')
  listDraftReviews(
    @Query() request: ListDraftReviewsRequestDto,
  ): Promise<BaseResponse<medicalRecord.ListDraftReviewsResponse>> {
    return this.medicalRecordService.listDraftReviews(request);
  }

  @Post('draft-reviews/:id/review')
  @HttpCode(HttpStatus.OK)
  reviewDraft(
    @RequestWithParams('body') request: ReviewDraftRequestDto,
  ): Promise<BaseResponse<medicalRecord.DraftReviewResponse>> {
    return this.medicalRecordService.reviewDraft(request);
  }
}
