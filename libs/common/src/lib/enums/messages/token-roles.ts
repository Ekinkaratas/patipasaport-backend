/**
 * Opaque token kaydında ve JWT'de taşınan rol değerleri.
 * users.proto UserRole enum'unun string karşılıkları; USER_ROLE_UNSPECIFIED
 * bilinçli olarak dışarıda — kimliği belirsiz token üretilemez.
 */
export const TOKEN_ROLES = ['CLINIC', 'PET_OWNER'] as const;

export type TokenRole = (typeof TOKEN_ROLES)[number];
