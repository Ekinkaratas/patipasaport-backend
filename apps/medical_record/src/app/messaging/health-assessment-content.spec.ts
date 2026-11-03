import { medicalRecord } from '@libs/proto';
import {
  DOSE_PATTERNS,
  validateHealthAssessment,
} from './health-assessment-content';

const TEST_NAMES = new Set(['HCT', 'HGB']);

// ---Amaç: AI servisinin yayınladığı biçimde geçerli bir değerlendirme üretmek ---
const valid = (over: Record<string, unknown> = {}) => ({
  summary: 'Hematokrit düşüyor.',
  riskLevel: 'HEALTH_RISK_MODERATE',
  findings: [
    {
      testName: 'HCT',
      trend: 'LAB_TREND_FALLING',
      interpretation: 'Son üç ölçümde azalmış.',
    },
  ],
  possibleConditions: [
    {
      name: 'Anemi',
      likelihood: 'CONDITION_LIKELIHOOD_MEDIUM',
      evidence: ['HCT', 'HGB'],
      explanation: 'Anemiyle ilişkili olabilir.',
    },
  ],
  recommendations: [
    {
      category: 'RECOMMENDATION_FOLLOW_UP_TEST',
      text: 'Hemogramın tekrarı konuşulabilir.',
    },
  ],
  vaccinationReminders: [
    {
      vaccineName: 'Kuduz',
      nextDueAt: '2026-10-05',
      status: 'VACCINATION_OVERDUE',
    },
  ],
  questionsForVet: ['Retikülosit sayımı gerekli mi?'],
  ...over,
});

const check = (raw: unknown, confidence = 0.7) =>
  validateHealthAssessment(raw, confidence, TEST_NAMES);

describe('validateHealthAssessment', () => {
  it('geçerli değerlendirme özet, risk, payload ve güvenle döner', () => {
    expect(check(valid({ summary: '  Özet.\nİkinci satır.  ' }))).toEqual({
      summary: 'Özet.\nİkinci satır.',
      riskLevel: medicalRecord.HealthRiskLevel.HEALTH_RISK_MODERATE,
      payload: {
        findings: [
          {
            testName: 'HCT',
            trend: 'LAB_TREND_FALLING',
            interpretation: 'Son üç ölçümde azalmış.',
          },
        ],
        possibleConditions: [
          {
            name: 'Anemi',
            likelihood: 'CONDITION_LIKELIHOOD_MEDIUM',
            evidence: ['HCT', 'HGB'],
            explanation: 'Anemiyle ilişkili olabilir.',
          },
        ],
        recommendations: [
          {
            category: 'RECOMMENDATION_FOLLOW_UP_TEST',
            text: 'Hemogramın tekrarı konuşulabilir.',
          },
        ],
        vaccinationReminders: [
          {
            vaccineName: 'Kuduz',
            nextDueAt: '2026-10-05',
            status: 'VACCINATION_OVERDUE',
          },
        ],
        questionsForVet: ['Retikülosit sayımı gerekli mi?'],
      },
      confidence: 0.7,
    });
  });

  it('boş listeler ve eğilimi olmayan bulgu kabul edilir', () => {
    const result = check(
      valid({
        findings: [{ testName: 'HGB', interpretation: 'Aralıkta.' }],
        possibleConditions: [],
        recommendations: [],
        vaccinationReminders: [],
        questionsForVet: [],
      }),
    );
    expect(result?.payload['findings']).toEqual([
      { testName: 'HGB', interpretation: 'Aralıkta.' },
    ]);
  });

  it.each([
    [1.5, 1],
    [-0.2, 0],
  ])('güven %p [0, 1] aralığına kırpılır', (confidence, expected) =>
    expect(check(valid(), confidence)?.confidence).toBe(expected),
  );

  it.each([
    ['sonsuz güven', valid(), Infinity],
    ['NaN güven', valid(), NaN],
  ])('%s reddedilir', (_label, raw, confidence) =>
    expect(check(raw, confidence)).toBeNull(),
  );

  it.each([
    ['nesne değil', 'metin'],
    ['dizi', []],
    ['null', null],
    ['boş özet', valid({ summary: '   ' })],
    ['uzun özet', valid({ summary: 'a'.repeat(2001) })],
    ['kontrol karakterli özet', valid({ summary: 'a\u0007b' })],
    ['dozlu özet', valid({ summary: 'Günde 50 mg verin.' })],
    ['bilinmeyen risk', valid({ riskLevel: 'HEALTH_RISK_EXTREME' })],
    ['risk yok', valid({ riskLevel: undefined })],
    ['findings dizi değil', valid({ findings: {} })],
    [
      'bilinmeyen test',
      valid({ findings: [{ testName: 'ALT', interpretation: 'x' }] }),
    ],
    [
      'tekrarlanan test',
      valid({
        findings: [
          { testName: 'HCT', interpretation: 'x' },
          { testName: 'HCT', interpretation: 'y' },
        ],
      }),
    ],
    [
      'bilinmeyen eğilim',
      valid({
        findings: [{ testName: 'HCT', trend: 'UP', interpretation: 'x' }],
      }),
    ],
    [
      'uzun yorum',
      valid({
        findings: [{ testName: 'HCT', interpretation: 'a'.repeat(501) }],
      }),
    ],
    [
      'çok fazla bulgu',
      valid({
        findings: Array.from({ length: 51 }, () => ({
          testName: 'HCT',
          interpretation: 'x',
        })),
      }),
    ],
    [
      'kanıtsız olası durum',
      valid({
        possibleConditions: [
          {
            name: 'Anemi',
            likelihood: 'CONDITION_LIKELIHOOD_LOW',
            evidence: [],
            explanation: 'x',
          },
        ],
      }),
    ],
    [
      'tekrarlanan kanıt',
      valid({
        possibleConditions: [
          {
            name: 'Anemi',
            likelihood: 'CONDITION_LIKELIHOOD_LOW',
            evidence: ['HCT', 'HCT'],
            explanation: 'x',
          },
        ],
      }),
    ],
    [
      'bilinmeyen kanıt',
      valid({
        possibleConditions: [
          {
            name: 'Anemi',
            likelihood: 'CONDITION_LIKELIHOOD_LOW',
            evidence: ['ALT'],
            explanation: 'x',
          },
        ],
      }),
    ],
    [
      'olasılığı belirtilmemiş durum',
      valid({
        possibleConditions: [
          { name: 'Anemi', evidence: ['HCT'], explanation: 'x' },
        ],
      }),
    ],
    [
      'çok satırlı durum adı',
      valid({
        possibleConditions: [
          {
            name: 'Ane\nmi',
            likelihood: 'CONDITION_LIKELIHOOD_LOW',
            evidence: ['HCT'],
            explanation: 'x',
          },
        ],
      }),
    ],
    [
      'çok fazla olası durum',
      valid({
        possibleConditions: Array.from({ length: 11 }, () => ({
          name: 'Anemi',
          likelihood: 'CONDITION_LIKELIHOOD_LOW',
          evidence: ['HCT'],
          explanation: 'x',
        })),
      }),
    ],
    ['kategorisiz öneri', valid({ recommendations: [{ text: 'Dinlenme.' }] })],
    [
      'dozlu öneri',
      valid({
        recommendations: [
          { category: 'RECOMMENDATION_NUTRITION', text: '2 tablet verin.' },
        ],
      }),
    ],
    [
      'çok fazla öneri',
      valid({
        recommendations: Array.from({ length: 16 }, () => ({
          category: 'RECOMMENDATION_CARE',
          text: 'x',
        })),
      }),
    ],
    [
      'tarihi geçersiz hatırlatma',
      valid({
        vaccinationReminders: [
          {
            vaccineName: 'Kuduz',
            nextDueAt: '05.10.2026',
            status: 'VACCINATION_OVERDUE',
          },
        ],
      }),
    ],
    [
      'durumsuz hatırlatma',
      valid({
        vaccinationReminders: [
          { vaccineName: 'Kuduz', nextDueAt: '2026-10-05' },
        ],
      }),
    ],
    ['boş soru', valid({ questionsForVet: [' '] })],
    ['uzun soru', valid({ questionsForVet: ['a'.repeat(301)] })],
    [
      'çok fazla soru',
      valid({ questionsForVet: Array.from({ length: 11 }, () => 'Soru?') }),
    ],
  ])('%s reddedilir', (_label, raw) => expect(check(raw)).toBeNull());
});

describe('DOSE_PATTERNS', () => {
  const hasDose = (text: string) =>
    DOSE_PATTERNS.some((pattern) => pattern.test(text));

  it.each([
    '50 mg',
    '2,5 ml',
    '1 tablet',
    '5mg/kg',
    '10 IU',
    '2 kapsül',
    '1,5g',
  ])('"%s" doz sayılır', (text) => expect(hasDose(text)).toBe(true));

  it.each(['2 gün', 'günde 2 öğün', '3 hafta', '%20', 'T4', '100 gram', 'B12'])(
    '"%s" doz sayılmaz',
    (text) => expect(hasDose(text)).toBe(false),
  );
});
