import { DtoPrefix, ValidationType } from '../messages';

export function getValidationMessage(
  prefix: DtoPrefix,
  validationType: ValidationType,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...args: any
): string {
  const message = `${prefix}_${validationType}${args.length > 0 ? '|' + args.join('|') : ''}`;
  return message;
}
