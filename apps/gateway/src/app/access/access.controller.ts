import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { BaseResponse } from '@libs/common';
import {
  GetConsentStatusRequestDto,
  GrantConsentRequestDto,
  ListMyConsentsRequestDto,
  RevokeConsentRequestDto,
} from '@libs/dto';
import { access } from '@libs/proto';
import { ApiAccessService } from './access.service';

@Controller('consents')
export class ApiAccessController {
  constructor(private readonly accessService: ApiAccessService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  grantConsent(
    @Body() request: GrantConsentRequestDto,
  ): Promise<BaseResponse<access.ConsentResponse>> {
    return this.accessService.grantConsent(request);
  }

  @Post(':consentId/revoke')
  @HttpCode(HttpStatus.OK)
  revokeConsent(
    @Param() request: RevokeConsentRequestDto,
  ): Promise<BaseResponse<access.ConsentResponse>> {
    return this.accessService.revokeConsent(request);
  }

  @Get('status')
  getConsentStatus(
    @Query() request: GetConsentStatusRequestDto,
  ): Promise<BaseResponse<access.ConsentResponse>> {
    return this.accessService.getConsentStatus(request);
  }

  @Get()
  listMyConsents(
    @Query() request: ListMyConsentsRequestDto,
  ): Promise<BaseResponse<access.ListMyConsentsResponse>> {
    return this.accessService.listMyConsents(request);
  }
}
