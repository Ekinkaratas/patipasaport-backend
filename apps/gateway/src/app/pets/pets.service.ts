import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { pets } from '@libs/proto';
import {
  BaseResponse,
  getCorrelationId,
  ResponseMessages,
} from '@libs/common';

@Injectable()
export class ApiPetsService implements OnModuleInit {
  private petsClient!: pets.PetsServiceClient;

  constructor(@Inject('PETS_SERVICE') private readonly client: ClientGrpc) {}

  onModuleInit() {
    this.petsClient = this.client.getService<pets.PetsServiceClient>(
      pets.PETS_SERVICE_NAME,
    );
  }

  async createPet(
    request: pets.CreatePetRequest,
  ): Promise<BaseResponse<pets.PetResponse>> {
    const data = await firstValueFrom(this.petsClient.createPet(request));
    return new BaseResponse(
      data,
      ResponseMessages.CREATED,
      true,
      getCorrelationId(),
    );
  }

  async listMyPets(): Promise<BaseResponse<pets.ListMyPetsResponse>> {
    const data = await firstValueFrom(this.petsClient.listMyPets({}));
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }

  async searchClinicPets(
    request: pets.SearchClinicPetsRequest,
  ): Promise<BaseResponse<pets.SearchClinicPetsResponse>> {
    const data = await firstValueFrom(
      this.petsClient.searchClinicPets(request),
    );
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }

  async getPet(
    request: pets.GetPetRequest,
  ): Promise<BaseResponse<pets.PetResponse>> {
    const data = await firstValueFrom(this.petsClient.getPet(request));
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }

  async updatePet(
    request: pets.UpdatePetRequest,
  ): Promise<BaseResponse<pets.PetResponse>> {
    const data = await firstValueFrom(this.petsClient.updatePet(request));
    return new BaseResponse(
      data,
      ResponseMessages.SUCCESS,
      true,
      getCorrelationId(),
    );
  }
}
