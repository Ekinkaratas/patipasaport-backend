export type DispositionType = 'inline' | 'attachment';

export function contentDisposition(
  type: DispositionType,
  fileName: string,
): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\%]/gu, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
