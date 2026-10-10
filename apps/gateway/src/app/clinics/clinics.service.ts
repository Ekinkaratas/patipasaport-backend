import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { clinics } from '@libs/proto';
import {
  BaseResponse,
  getCorrelationId,
  ResponseMessages,
} from '@libs/common';

@Injectable()
export class ApiClinicsService implements OnModuleInit {
  private clinicsClient!: clinics.ClinicsServiceClient;

  constructor(@Inject('CLINICS_SERVICE') private readonly client: ClientGrpc) {}

  onModuleInit() {
    this.clinicsClient = this.client.getService<clinics.ClinicsServiceClient>(
      clinics.CLINICS_SERVICE_NAME,
    );
  }

  async getClinic(
    request: clinics.GetClinicRequest,
  ): Promise<BaseResponse<clinics.ClinicResponse>> {
    const data = await firstValueFrom(this.clinicsClient.getClinic(request));
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }

  async deactivateClinic(
    request: clinics.DeactivateClinicRequest,
  ): Promise<BaseResponse<clinics.ClinicResponse>> {
    const data = await firstValueFrom(
      this.clinicsClient.deactivateClinic(request),
    );
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }

  async addStockItem(
    request: clinics.AddStockItemRequest,
  ): Promise<BaseResponse<clinics.StockItemResponse>> {
    const data = await firstValueFrom(
      this.clinicsClient.addStockItem(request),
    );
    return new BaseResponse(
      data,
      ResponseMessages.CREATED,
      true,
      getCorrelationId(),
    );
  }

  async listStockItems(
    request: clinics.ListStockItemsRequest,
  ): Promise<BaseResponse<clinics.ListStockItemsResponse>> {
    const data = await firstValueFrom(
      this.clinicsClient.listStockItems(request),
    );
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }

  async getClinicPetOverview(
    request: clinics.GetClinicPetOverviewRequest,
  ): Promise<BaseResponse<clinics.GetClinicPetOverviewResponse>> {
    const data = await firstValueFrom(
      this.clinicsClient.getClinicPetOverview(request),
    );
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }
}
