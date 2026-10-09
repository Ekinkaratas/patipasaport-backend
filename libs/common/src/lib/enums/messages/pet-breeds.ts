import { PetSpecies } from './pet-species';

export const PET_BREEDS = {
  DOG: [
    'GOLDEN_RETRIEVER',
    'LABRADOR_RETRIEVER',
    'GERMAN_SHEPHERD',
    'KANGAL',
    'SIBERIAN_HUSKY',
    'POODLE',
    'POMERANIAN',
    'YORKSHIRE_TERRIER',
    'MIXED',
  ],
  CAT: [
    'BRITISH_SHORTHAIR',
    'SCOTTISH_FOLD',
    'PERSIAN',
    'TURKISH_VAN',
    'TURKISH_ANGORA',
    'SIAMESE',
    'MAINE_COON',
    'RAGDOLL',
    'MIXED',
  ],
  BIRD: [
    'BUDGERIGAR',
    'CANARY',
    'COCKATIEL',
    'LOVEBIRD',
    'AFRICAN_GREY',
    'MIXED',
  ],
  RABBIT: [
    'HOLLAND_LOP',
    'NETHERLAND_DWARF',
    'LIONHEAD',
    'ANGORA',
    'REX',
    'MIXED',
  ],
  HAMSTER: [
    'SYRIAN',
    'CAMPBELL_DWARF',
    'WINTER_WHITE_DWARF',
    'ROBOROVSKI',
    'MIXED',
  ],
  GUINEA_PIG: ['AMERICAN', 'ABYSSINIAN', 'PERUVIAN', 'TEDDY', 'MIXED'],
  FERRET: ['MIXED'],
  TURTLE: [
    'RED_EARED_SLIDER',
    'YELLOW_BELLIED_SLIDER',
    'RUSSIAN_TORTOISE',
    'MIXED',
  ],
} as const satisfies Record<PetSpecies, readonly string[]>;

export type PetBreedCode = (typeof PET_BREEDS)[PetSpecies][number];

export const PET_BREED_CODES: readonly PetBreedCode[] = [
  ...new Set(Object.values(PET_BREEDS).flat()),
];
