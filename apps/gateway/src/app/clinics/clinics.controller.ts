import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { BaseResponse, RequestWithParams } from '@libs/common';
import {
  AddStockItemRequestDto,
  AdjustStockItemRequestDto,
  CancelStockSaleRequestDto,
  CreateStockSaleRequestDto,
  DeactivateClinicRequestDto,
  DeleteStockItemRequestDto,
  GetClinicPetOverviewRequestDto,
  GetClinicRequestDto,
  GetStockSalesSummaryRequestDto,
  ListStockItemsRequestDto,
  ListStockSalesRequestDto,
  UpdateStockItemRequestDto,
} from '@libs/dto';
import { clinics } from '@libs/proto';
import { RateLimit } from '../security/rate-limit';
import { ApiClinicsService } from './clinics.service';
import {
  PetResultFileInterceptor,
  petResultFilePipe,
  UploadedPetResultFile,
} from './pet-result-upload';

@Controller('clinics')
export class ApiClinicsController {
  constructor(private readonly clinicsService: ApiClinicsService) {}

  @Get(':id')
  getClinic(
    @Param() request: GetClinicRequestDto,
  ): Promise<BaseResponse<clinics.ClinicResponse>> {
    return this.clinicsService.getClinic(request);
  }

  @Post(':clinicId/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivateClinic(
    @Param() request: DeactivateClinicRequestDto,
  ): Promise<BaseResponse<clinics.ClinicResponse>> {
    return this.clinicsService.deactivateClinic(request);
  }

  @Post(':clinicId/stock-items')
  addStockItem(
    @RequestWithParams('body') request: AddStockItemRequestDto,
  ): Promise<BaseResponse<clinics.StockItemResponse>> {
    return this.clinicsService.addStockItem(request);
  }

  @Get(':clinicId/stock-items')
  listStockItems(
    @RequestWithParams('query') request: ListStockItemsRequestDto,
  ): Promise<BaseResponse<clinics.ListStockItemsResponse>> {
    return this.clinicsService.listStockItems(request);
  }

  @Patch(':clinicId/stock-items/:itemId')
  updateStockItem(
    @RequestWithParams('body') request: UpdateStockItemRequestDto,
  ): Promise<BaseResponse<clinics.StockItemResponse>> {
    return this.clinicsService.updateStockItem(request);
  }

  @Post(':clinicId/stock-items/:itemId/adjust')
  @HttpCode(HttpStatus.OK)
  adjustStockItem(
    @RequestWithParams('body') request: AdjustStockItemRequestDto,
  ): Promise<BaseResponse<clinics.StockItemResponse>> {
    return this.clinicsService.adjustStockItem(request);
  }

  @Delete(':clinicId/stock-items/:itemId')
  deleteStockItem(
    @Param() request: DeleteStockItemRequestDto,
  ): Promise<BaseResponse<clinics.StockItemResponse>> {
    return this.clinicsService.deleteStockItem(request);
  }

  @Post(':clinicId/stock-items/:itemId/sales')
  createStockSale(
    @RequestWithParams('body') request: CreateStockSaleRequestDto,
  ): Promise<BaseResponse<clinics.StockSaleResponse>> {
    return this.clinicsService.createStockSale(request);
  }

  @Get(':clinicId/stock-sales/summary')
  getStockSalesSummary(
    @RequestWithParams('query') request: GetStockSalesSummaryRequestDto,
  ): Promise<BaseResponse<clinics.StockSalesSummaryResponse>> {
    return this.clinicsService.getStockSalesSummary(request);
  }

  @Get(':clinicId/stock-sales')
  listStockSales(
    @RequestWithParams('query') request: ListStockSalesRequestDto,
  ): Promise<BaseResponse<clinics.ListStockSalesResponse>> {
    return this.clinicsService.listStockSales(request);
  }

  @Post(':clinicId/stock-sales/:saleId/cancel')
  @HttpCode(HttpStatus.OK)
  cancelStockSale(
    @Param() request: CancelStockSaleRequestDto,
  ): Promise<BaseResponse<clinics.StockSaleResponse>> {
    return this.clinicsService.cancelStockSale(request);
  }

  @Get(':clinicId/pets/:petId/overview')
  getClinicPetOverview(
    @Param() request: GetClinicPetOverviewRequestDto,
  ): Promise<BaseResponse<clinics.GetClinicPetOverviewResponse>> {
    return this.clinicsService.getClinicPetOverview(request);
  }

  @RateLimit('upload')
  @Post(':clinicId/pets/:petId/documents')
  @UseInterceptors(PetResultFileInterceptor)
  uploadPetResult(
    @Param('clinicId') clinicId: string,
    @Param('petId') petId: string,
    @Body('note') note: string | undefined,
    @UploadedFile(petResultFilePipe()) file: UploadedPetResultFile,
  ): Promise<BaseResponse<clinics.UploadPetResultResponse>> {
    return this.clinicsService.uploadPetResult({ clinicId, petId, note }, file);
  }
}
