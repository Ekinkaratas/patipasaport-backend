import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { BaseResponse, RequestWithParams } from '@libs/common';
import {
  CreatePetRequestDto,
  GetPetRequestDto,
  SearchClinicPetsRequestDto,
  UpdatePetRequestDto,
} from '@libs/dto';
import { pets } from '@libs/proto';
import { ApiPetsService } from './pets.service';

@Controller('pets')
export class ApiPetsController {
  constructor(private readonly petsService: ApiPetsService) {}

  @Post()
  createPet(
    @Body() request: CreatePetRequestDto,
  ): Promise<BaseResponse<pets.PetResponse>> {
    return this.petsService.createPet(request);
  }

  @Get()
  listMyPets(): Promise<BaseResponse<pets.ListMyPetsResponse>> {
    return this.petsService.listMyPets();
  }

  @Get('search')
  searchClinicPets(
    @Query() request: SearchClinicPetsRequestDto,
  ): Promise<BaseResponse<pets.SearchClinicPetsResponse>> {
    return this.petsService.searchClinicPets(request);
  }

  @Get(':id')
  getPet(
    @Param() request: GetPetRequestDto,
  ): Promise<BaseResponse<pets.PetResponse>> {
    return this.petsService.getPet(request);
  }

  @Patch(':id')
  updatePet(
    @RequestWithParams('body') request: UpdatePetRequestDto,
  ): Promise<BaseResponse<pets.PetResponse>> {
    return this.petsService.updatePet(request);
  }
}
