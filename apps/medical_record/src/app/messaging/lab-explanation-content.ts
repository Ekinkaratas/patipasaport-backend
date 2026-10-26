import { isPlainMultilineText, isPlainText } from '@libs/dto';
import { medicalRecord } from '@libs/proto';
import { maxLength, minLength } from 'class-validator';

export const LAB_EXPLANATION_SUMMARY_MAX_LENGTH = 2000;
export const LAB_EXPLANATION_ITEMS_MAX = 50;
export const LAB_EXPLANATION_ITEM_MAX_LENGTH = 500;

export interface LabExplanationContent {
  summary: string;
  items: medicalRecord.LabExplanationItem[];
  confidence: number;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textOrEmpty = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : undefined;
};

const isMultilineTextWithin = (value: string, max: number): boolean =>
  minLength(value, 1) && maxLength(value, max) && isPlainMultilineText(value);

function readItem(
  raw: unknown,
  testNames: ReadonlySet<string>,
): medicalRecord.LabExplanationItem | null {
  if (!isPlainObject(raw)) return null;

  const testName = textOrEmpty(raw['testName'] ?? raw['test_name'])?.trim();
  const explanation = textOrEmpty(raw['explanation'])?.trim();

  if (
    testName === undefined ||
    explanation === undefined ||
    !isPlainText(testName) ||
    !testNames.has(testName) ||
    !isMultilineTextWithin(explanation, LAB_EXPLANATION_ITEM_MAX_LENGTH)
  ) {
    return null;
  }
  return { testName, explanation };
}

export function validateLabExplanation(
  raw: unknown,
  confidence: number,
  testNames: ReadonlySet<string>,
): LabExplanationContent | null {
  const explanation = raw ?? {};
  if (!Number.isFinite(confidence) || !isPlainObject(explanation)) return null;

  const summary = textOrEmpty(explanation['summary'])?.trim();
  if (
    summary === undefined ||
    !isMultilineTextWithin(summary, LAB_EXPLANATION_SUMMARY_MAX_LENGTH)
  ) {
    return null;
  }

  const rawItems = explanation['items'] ?? [];
  if (!Array.isArray(rawItems) || rawItems.length > LAB_EXPLANATION_ITEMS_MAX) {
    return null;
  }

  const items: medicalRecord.LabExplanationItem[] = [];
  const seen = new Set<string>();
  for (const rawItem of rawItems) {
    const item = readItem(rawItem, testNames);
    if (!item || seen.has(item.testName)) return null;
    seen.add(item.testName);
    items.push(item);
  }

  return {
    summary,
    items,
    confidence: Math.min(Math.max(confidence, 0), 1),
  };
}
