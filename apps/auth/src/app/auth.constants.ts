/** Access (opaque) token ömrü — istemci seçemez. access servisi kendi OPAQUE_TOKEN_TTL'i ile ayrıca sınırlar. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Refresh token ömrü: "Oturumu hatırla" işaretli değilse 12 saat, işaretliyse 30 gün. */
export const REFRESH_TOKEN_TTL_SECONDS = 12 * 60 * 60;
export const REMEMBER_ME_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** proto3'te gönderilmeyen bool undefined gelir; yalnızca açıkça true "hatırla" demektir. */
export function refreshTokenTtlSeconds(
  rememberMe: boolean | undefined,
): number {
  return rememberMe === true
    ? REMEMBER_ME_REFRESH_TOKEN_TTL_SECONDS
    : REFRESH_TOKEN_TTL_SECONDS;
}
