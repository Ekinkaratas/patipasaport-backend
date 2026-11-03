export const CONSENT_PAGE_SIZE = 128;

// Sözleşme 7A.9: aynı hayvan için yeni AI isteği en az 10 dakika arayla,
// 30 dakikadan uzun süren PENDING takılmış sayılır.
export const HEALTH_ASSESSMENT_MIN_INTERVAL_MS = 10 * 60 * 1000;
export const HEALTH_ASSESSMENT_STALE_PENDING_MS = 30 * 60 * 1000;
