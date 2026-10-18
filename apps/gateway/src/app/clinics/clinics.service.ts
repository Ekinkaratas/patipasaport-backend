import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { createHash, randomUUID } from 'crypto';
import { firstValueFrom } from 'rxjs';
import { clinics } from '@libs/proto';
import {
  BaseResponse,
  getCorrelationId,
  PET_RESULT_FILE_EXTENSIONS,
  PetResultMimeType,
  ResponseMessages,
} from '@libs/common';
import { UploadPetResultRequestDto } from '@libs/dto';
import { DocumentStorageService } from '../storage/document-storage.service';
import { UploadedPetResultFile } from './pet-result-upload';

export interface PetResultUploadForm {
  clinicId: string;
  petId: string;
  note?: string;
}

@Injectable()
export class ApiClinicsService implements OnModuleInit {
  private readonly logger = new Logger(ApiClinicsService.name);
  private readonly uploadValidation = new ValidationPipe({
    whitelist: true,
    transform: true,
    stopAtFirstError: true,
  });
  private clinicsClient!: clinics.ClinicsServiceClient;

  constructor(
    @Inject('CLINICS_SERVICE') private readonly client: ClientGrpc,
    private readonly storage: DocumentStorageService,
  ) {}

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

  async updateStockItem(
    request: clinics.UpdateStockItemRequest,
  ): Promise<BaseResponse<clinics.StockItemResponse>> {
    const data = await firstValueFrom(
      this.clinicsClient.updateStockItem(request),
    );
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }

  async adjustStockItem(
    request: clinics.AdjustStockItemRequest,
  ): Promise<BaseResponse<clinics.StockItemResponse>> {
    const data = await firstValueFrom(
      this.clinicsClient.adjustStockItem(request),
    );
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }

  async deleteStockItem(
    request: clinics.DeleteStockItemRequest,
  ): Promise<BaseResponse<clinics.StockItemResponse>> {
    const data = await firstValueFrom(
      this.clinicsClient.deleteStockItem(request),
    );
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }

  async createStockSale(
    request: clinics.CreateStockSaleRequest,
  ): Promise<BaseResponse<clinics.StockSaleResponse>> {
    const data = await firstValueFrom(
      this.clinicsClient.createStockSale(request),
    );
    return new BaseResponse(
      data,
      ResponseMessages.CREATED,
      true,
      getCorrelationId(),
    );
  }

  async listStockSales(
    request: clinics.ListStockSalesRequest,
  ): Promise<BaseResponse<clinics.ListStockSalesResponse>> {
    const data = await firstValueFrom(
      this.clinicsClient.listStockSales(request),
    );
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }

  async cancelStockSale(
    request: clinics.CancelStockSaleRequest,
  ): Promise<BaseResponse<clinics.StockSaleResponse>> {
    const data = await firstValueFrom(
      this.clinicsClient.cancelStockSale(request),
    );
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }

  async getStockSalesSummary(
    request: clinics.GetStockSalesSummaryRequest,
  ): Promise<BaseResponse<clinics.StockSalesSummaryResponse>> {
    const data = await firstValueFrom(
      this.clinicsClient.getStockSalesSummary(request),
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

  async uploadPetResult(
    form: PetResultUploadForm,
    file: UploadedPetResultFile,
  ): Promise<BaseResponse<clinics.UploadPetResultResponse>> {
    const extension =
      PET_RESULT_FILE_EXTENSIONS[file.mimetype as PetResultMimeType][0];

    const request: UploadPetResultRequestDto =
      await this.uploadValidation.transform(
        {
          clinicId: form.clinicId,
          petId: form.petId,
          storagePath: `${randomUUID()}.${extension}`,
          originalName: file.originalname,
          mimeType: file.mimetype,
          sizeBytes: file.size,
          note: form.note,
          sha256: createHash('sha256').update(file.buffer).digest('hex'),
        },
        { type: 'body', metatype: UploadPetResultRequestDto },
      );

    try {
      await this.storage.put(
        request.storagePath,
        file.buffer,
        request.mimeType,
      );
    } catch (e) {
      this.logger.error(
        `uploadPetResult: dosya depoya yazılamadı (storagePath=${request.storagePath}): ${e instanceof Error ? e.message : String(e)}`,
      );
      throw new ServiceUnavailableException(
        ResponseMessages.SERVICE_UNAVAILABLE,
      );
    }

    try {
      const data = await firstValueFrom(
        this.clinicsClient.uploadPetResult(request),
      );
      return new BaseResponse(
        data,
        ResponseMessages.CREATED,
        true,
        getCorrelationId(),
      );
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === status.DEADLINE_EXCEEDED) {
        this.logger.error(
          `uploadPetResult: clinics.uploadPetResult zaman aşımına uğradı, belge kaydı oluşmuş olabileceği için dosya silinmedi (storagePath=${request.storagePath})`,
        );
        throw e;
      }
      await this.storage
        .delete(request.storagePath)
        .catch((deleteError) =>
          this.logger.error(
            `uploadPetResult: kayıt başarısız, yüklenen dosya silinemedi (storagePath=${request.storagePath}): ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`,
          ),
        );
      throw e;
    }
  }
}
