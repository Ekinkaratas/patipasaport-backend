import { Controller } from '@nestjs/common';
import { ClinicsService } from './clinics.service';
import {
  AddStockItemRequestDto,
  CreateClinicRequestDto,
  DeactivateClinicRequestDto,
  GetClinicPetOverviewRequestDto,
  GetClinicRequestDto,
  ListStockItemsRequestDto,
  UploadPetResultRequestDto,
} from '@libs/dto';
import { GrpcMethod, Payload } from '@nestjs/microservices';
import { clinics } from '@libs/proto';
import { AuthUser, CurrentUser, Public, Roles } from '@libs/common';

@Controller()
export class ClinicsController {
  constructor(private readonly clinicsService: ClinicsService) {}

  @Roles(['PET_OWNER', 'CLINIC'])
  @GrpcMethod(clinics.CLINICS_SERVICE_NAME, 'GetClinic')
  async getClinic(
    @Payload() request: GetClinicRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<clinics.ClinicResponse> {
    return this.clinicsService.getClinic(request, user);
  }

  @Public()
  @GrpcMethod(clinics.CLINICS_SERVICE_NAME, 'CreateClinic')
  async createClinic(
    @Payload() request: CreateClinicRequestDto,
  ): Promise<clinics.ClinicResponse> {
    return this.clinicsService.createClinic(request);
  }

  @Roles(['CLINIC'])
  @GrpcMethod(clinics.CLINICS_SERVICE_NAME, 'DeactivateClinic')
  async deactivateClinic(
    @Payload() request: DeactivateClinicRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<clinics.ClinicResponse> {
    return this.clinicsService.deactivateClinic(request, user);
  }

  @Roles(['CLINIC'])
  @GrpcMethod(clinics.CLINICS_SERVICE_NAME, 'AddStockItem')
  async addStockItem(
    @Payload() request: AddStockItemRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<clinics.StockItemResponse> {
    return this.clinicsService.addStockItem(request, user);
  }

  @Roles(['CLINIC'])
  @GrpcMethod(clinics.CLINICS_SERVICE_NAME, 'ListStockItems')
  async listStockItems(
    @Payload() request: ListStockItemsRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<clinics.ListStockItemsResponse> {
    return this.clinicsService.listStockItems(request, user);
  }

  @Roles(['CLINIC'])
  @GrpcMethod(clinics.CLINICS_SERVICE_NAME, 'GetClinicPetOverview')
  async getClinicPetOverview(
    @Payload() request: GetClinicPetOverviewRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<clinics.GetClinicPetOverviewResponse> {
    return this.clinicsService.getClinicPetOverview(request, user);
  }

  @Roles(['CLINIC'])
  @GrpcMethod(clinics.CLINICS_SERVICE_NAME, 'UploadPetResult')
  async uploadPetResult(
    @Payload() request: UploadPetResultRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<clinics.UploadPetResultResponse> {
    return this.clinicsService.uploadPetResult(request, user);
  }
}
