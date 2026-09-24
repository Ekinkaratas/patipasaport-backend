import { LogAction } from '../logging';

export type LogLevel = 'log' | 'warn' | 'error';

/**
 * Ayrım şu soruya göre: bu satırı gece yarısı görsem ne yapardım?
 *   log   -> hiçbir şey; istemci hatası ya da normal iş akışı
 *   warn  -> not alırdım; tekrarlarsa bir saldırı/yanlış kullanım işareti
 *   error -> bakardım; bizim tarafımızda bir şey bozuk
 *
 * Record<LogAction, LogLevel> olması kasıtlı bir seçimdir: LogAction'a yeni bir değer
 * eklendiğinde derleyici burayı da doldurmaya zorlar.
 */
export const LogLevelMap: Readonly<Record<LogAction, LogLevel>> = Object.freeze(
  {
    // Yaşam döngüsü — olağan akış
    [LogAction.REQUEST_RECEIVED]: 'log',
    [LogAction.REQUEST_SUCCESS]: 'log',

    // İstemci hataları — beklenen durumlar, gürültü yapmamalı
    [LogAction.VALIDATION_FAILED]: 'log',
    [LogAction.NOT_FOUND]: 'log',
    [LogAction.CONFLICT]: 'log',

    // Güvenlikle ilgili — tekrarı anlamlı, izlenmeli
    [LogAction.UNAUTHORIZED]: 'warn',
    [LogAction.FORBIDDEN]: 'warn',
    [LogAction.RATE_LIMITED]: 'warn',

    // Bizim tarafımızdaki arızalar
    [LogAction.DEPENDENCY_FAILED]: 'error',
    [LogAction.INTERNAL_ERROR]: 'error',
    [LogAction.REQUEST_FAILED]: 'error',
  },
);
