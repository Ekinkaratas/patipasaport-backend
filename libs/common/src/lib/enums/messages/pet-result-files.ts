export const PET_RESULT_FILE_EXTENSIONS = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
} as const satisfies Record<string, readonly string[]>;

export type PetResultMimeType = keyof typeof PET_RESULT_FILE_EXTENSIONS;

export const PET_RESULT_MIME_TYPES = Object.keys(
  PET_RESULT_FILE_EXTENSIONS,
) as PetResultMimeType[];

export const PET_RESULT_MAX_SIZE_BYTES = 10 * 1024 * 1024;
