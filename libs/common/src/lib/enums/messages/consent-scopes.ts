export const CONSENT_SCOPES = [
  'medical_read',
  'medical_write',
  'vaccination_read',
  'prescription_read',
  'chip_number_read',
  'owner_contact_read',
] as const;

export type ConsentScope = (typeof CONSENT_SCOPES)[number];
