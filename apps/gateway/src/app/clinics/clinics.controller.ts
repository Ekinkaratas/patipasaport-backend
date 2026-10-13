import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { BaseResponse, RequestWithParams } from '@libs/common';
import {
  AddStockItemRequestDto,
  DeactivateClinicRequestDto,
  GetClinicPetOverviewRequestDto,
  GetClinicRequestDto,
  ListStockItemsRequestDto,
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
