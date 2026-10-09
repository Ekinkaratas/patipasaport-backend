export const PET_SPECIES = [
  'DOG',
  'CAT',
  'BIRD',
  'RABBIT',
  'HAMSTER',
  'GUINEA_PIG',
  'FERRET',
  'TURTLE',
] as const;

export type PetSpecies = (typeof PET_SPECIES)[number];
