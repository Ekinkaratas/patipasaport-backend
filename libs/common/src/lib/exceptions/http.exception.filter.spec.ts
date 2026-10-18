import {
  ArgumentsHost,
  BadRequestException,
  HttpStatus,
  ValidationPipe,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsNotEmpty, MinLength, ValidateNested } from 'class-validator';
import {
  DtoPrefix,
  getValidationMessage,
  ResponseMessages,
  ValidationType,
} from '../enums';
import { HttpsExceptionFilter } from './http.exception.filter';

const TITLE_TOO_SHORT = getValidationMessage(
  DtoPrefix.TITLE,
  ValidationType.MIN_LENGTH,
  2,
);
const DOCUMENT_ID_EMPTY = getValidationMessage(
  DtoPrefix.DOCUMENT_ID,
  ValidationType.NOT_EMPTY,
);

class ContentDto {
  @MinLength(2, { message: TITLE_TOO_SHORT })
  title!: string;
}

class AttachmentDto {
  @IsNotEmpty({ message: DOCUMENT_ID_EMPTY })
  documentId!: string;
}

class RecordDto {
  @ValidateNested()
  @Type(() => ContentDto)
  content!: ContentDto;

  @ValidateNested({ each: true })
  @Type(() => AttachmentDto)
  attachments!: AttachmentDto[];
}

const validationPipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  stopAtFirstError: true,
});

// ---Amaç: gateway'deki ValidationPipe'ın gerçek hatasını üretmek ---
const validationError = (plain: object): Promise<BadRequestException> =>
  validationPipe.transform(plain, { type: 'body', metatype: RecordDto }).then(
    () => {
      throw new Error('doğrulama hatası bekleniyordu');
    },
    (e: unknown) => e as BadRequestException,
  );

// ---Amaç: filtrenin istemciye yazdığı durum kodunu ve gövdeyi yakalamak ---
const respond = (exception: unknown) => {
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  new HttpsExceptionFilter().catch(exception, host);
  return {
    status: response.status.mock.calls[0][0],
    message: response.json.mock.calls[0][0].message,
  };
};

describe('HttpsExceptionFilter', () => {
  // ---Amaç: iç içe alanlarda Nest'in eklediği alan yolunun silinip alanı belirten kodun döndüğünü doğrulamak ---
  it.each([
    [
      'iç içe nesne',
      { content: { title: 'a' }, attachments: [] },
      `content.${TITLE_TOO_SHORT}`,
      TITLE_TOO_SHORT,
    ],
    [
      'dizi elemanı',
      { content: { title: 'ab' }, attachments: [{ documentId: '' }] },
      `attachments.0.${DOCUMENT_ID_EMPTY}`,
      DOCUMENT_ID_EMPTY,
    ],
  ])('%s: %s → %s', async (_n, plain, nestMessage, expected) => {
    const error = await validationError(plain);
    expect(error.getResponse()).toMatchObject({ message: [nestMessage] });
    expect(respond(error)).toEqual({
      status: HttpStatus.BAD_REQUEST,
      message: expected,
    });
  });

  // ---Amaç: üst düzey kodların, kod olmayan iç içe metinlerin ve noktalı yanıt mesajlarının eskisi gibi işlendiğini doğrulamak ---
  it.each([
    ['üst düzey kod', TITLE_TOO_SHORT, TITLE_TOO_SHORT],
    [
      'kod olmayan iç içe metin',
      'content.title must be longer',
      ResponseMessages.BAD_REQUEST,
    ],
    [
      'noktalı yanıt mesajı',
      ResponseMessages.REQUEST_BODY_TOO_DEEP,
      ResponseMessages.REQUEST_BODY_TOO_DEEP,
    ],
  ])('%s: %s → %s', (_n, raw, expected) =>
    expect(respond(new BadRequestException([raw]))).toEqual({
      status: HttpStatus.BAD_REQUEST,
      message: expected,
    }),
  );
});
