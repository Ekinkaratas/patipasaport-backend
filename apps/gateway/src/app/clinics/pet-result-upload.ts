import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  FileTypeValidator,
  Injectable,
  NestInterceptor,
  ParseFilePipe,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Observable } from 'rxjs';
import {
  DtoPrefix,
  getValidationMessage,
  PET_RESULT_MAX_SIZE_BYTES,
  PET_RESULT_MIME_TYPES,
  ValidationType,
} from '@libs/common';

export const PET_RESULT_FILE_FIELD = 'file';

export interface UploadedPetResultFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const FILE_REQUIRED_MESSAGE = 'File is required';

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const PET_RESULT_MIME_PATTERN = new RegExp(
  `^(${PET_RESULT_MIME_TYPES.map(escapeRegExp).join('|')})$`,
);

const MULTER_FILE_SIZE_LIMIT = PET_RESULT_MAX_SIZE_BYTES + 1;

const PetResultMulterInterceptor = FileInterceptor(PET_RESULT_FILE_FIELD, {
  limits: { fileSize: MULTER_FILE_SIZE_LIMIT, files: 1 },
  defParamCharset: 'utf8',
});

@Injectable()
export class PetResultFileInterceptor
  extends PetResultMulterInterceptor
  implements NestInterceptor
{
  override async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    try {
      return await super.intercept(context, next);
    } catch (e) {
      if (e instanceof PayloadTooLargeException) {
        throw new BadRequestException(
          getValidationMessage(
            DtoPrefix.SIZE_BYTES,
            ValidationType.MAX,
            PET_RESULT_MAX_SIZE_BYTES,
          ),
        );
      }
      throw e;
    }
  }
}

export const petResultFilePipe = (): ParseFilePipe =>
  new ParseFilePipe({
    validators: [
      new FileTypeValidator({
        fileType: PET_RESULT_MIME_PATTERN,
        overrideMimeType: true,
        errorMessage: getValidationMessage(
          DtoPrefix.MIME_TYPE,
          ValidationType.NOT_VALID,
        ),
      }),
    ],
    exceptionFactory: (message: string) =>
      new BadRequestException(
        message === FILE_REQUIRED_MESSAGE
          ? getValidationMessage(DtoPrefix.FILE, ValidationType.NOT_EMPTY)
          : message,
      ),
  });
