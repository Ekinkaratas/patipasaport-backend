import { Controller } from '@nestjs/common';
import { PetsService } from './pets.service';
import { GrpcMethod, Payload } from '@nestjs/microservices';
import { AuthUser, CurrentUser, Roles } from '@libs/common';
import { pets } from '@libs/proto';
import {
  CreatePetRequestDto,
  GetPetOwnerRequestDto,
  GetPetRequestDto,
  SearchClinicPetsRequestDto,
  UpdatePetRequestDto,
} from '@libs/dto';

@Controller()
export class PetsController {
  constructor(private readonly petsService: PetsService) {}

  @Roles(['PET_OWNER', 'CLINIC'])
  @GrpcMethod(pets.PETS_SERVICE_NAME, 'GetPet')
  async getPet(
    @Payload() request: GetPetRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<pets.PetResponse> {
    return this.petsService.getPet(request, user);
  }

  @Roles(['CLINIC'])
  @GrpcMethod(pets.PETS_SERVICE_NAME, 'SearchClinicPets')
  async searchClinicPets(
    @Payload() request: SearchClinicPetsRequestDto,
  ): Promise<pets.SearchClinicPetsResponse> {
    return this.petsService.searchClinicPets(request);
  }

  @Roles(['PET_OWNER'])
  @GrpcMethod(pets.PETS_SERVICE_NAME, 'ListMyPets')
  async listMyPets(
    @CurrentUser() user: AuthUser,
  ): Promise<pets.ListMyPetsResponse> {
    return this.petsService.listMyPets(user);
  }

  @Roles(['PET_OWNER'])
  @GrpcMethod(pets.PETS_SERVICE_NAME, 'GetPetOwner')
  async getPetOwner(
    @Payload() request: GetPetOwnerRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<pets.GetPetOwnerResponse> {
    return this.petsService.getPetOwner(request, user);
  }

  @Roles(['PET_OWNER'])
  @GrpcMethod(pets.PETS_SERVICE_NAME, 'CreatePet')
  async createPet(
    @Payload() request: CreatePetRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<pets.PetResponse> {
    return this.petsService.createPet(request, user);
  }

  @Roles(['PET_OWNER', 'CLINIC'])
  @GrpcMethod(pets.PETS_SERVICE_NAME, 'UpdatePet')
  async updatePet(
    @Payload() request: UpdatePetRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<pets.PetResponse> {
    return this.petsService.updatePet(request, user);
  }
}
