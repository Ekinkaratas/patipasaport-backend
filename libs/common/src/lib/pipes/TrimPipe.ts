/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  PipeTransform,
  Injectable,
  ArgumentMetadata,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ResponseMessages } from '../enums';

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_BODY_DEPTH = 50;

@Injectable()
export class TrimPipe implements PipeTransform {
  private readonly logger = new Logger(TrimPipe.name);

  private isObj(obj: any): boolean {
    return typeof obj === 'object' && obj !== null;
  }

  private exceedsDepth(values: any, depth: number): boolean {
    if (depth > MAX_BODY_DEPTH) return true;
    return Object.values(values).some(
      (value) => this.isObj(value) && this.exceedsDepth(value, depth + 1),
    );
  }

  private assertDepth(values: any): void {
    if (this.exceedsDepth(values, 1)) {
      this.logger.warn(
        `TrimPipe: JSON gövdesi maksimum derinlik sınırını aştı (Limit: ${MAX_BODY_DEPTH})`,
      );
      throw new BadRequestException(ResponseMessages.REQUEST_BODY_TOO_DEEP);
    }
  }

  private trim(values: any): any {
    Object.keys(values).forEach((key) => {
      if (UNSAFE_KEYS.has(key)) {
        delete values[key];
      } else if (key !== 'password') {
        if (this.isObj(values[key])) {
          values[key] = this.trim(values[key]);
        } else if (typeof values[key] === 'string') {
          values[key] = values[key].trim();
        }
      }
    });
    return values;
  }

  transform(values: any, metadata: ArgumentMetadata) {
    if (this.isObj(values) && metadata.type === 'body') {
      this.assertDepth(values);
      return this.trim(values);
    }
    if (
      this.isObj(values) &&
      metadata.type === 'custom' &&
      metadata.data === 'body'
    ) {
      this.assertDepth(values);
    }
    return values;
  }
}
