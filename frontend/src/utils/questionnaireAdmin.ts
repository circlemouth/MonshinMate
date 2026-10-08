/** Keep template selection IDs as validated strings at the API boundary. */
export function parseQuestionnaireList(value: unknown): { id: string }[] {
  if (!Array.isArray(value)) throw new Error('Invalid questionnaire list');
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || !('id' in item) ||
        typeof item.id !== 'string' || !item.id.trim()) {
      throw new Error('Invalid questionnaire ID');
    }
    ids.add(item.id);
  }
  return Array.from(ids, (id) => ({ id }));
}

/** Upload first so a failed replacement cannot delete the editor's current image. */
export async function replaceUploadedImage(
  file: File,
  previousUrl: string | undefined,
  upload: (file: File) => Promise<string | null>,
  remove: (url?: string) => Promise<void>,
): Promise<string | null> {
  const url = await upload(file);
  if (!url) return null;
  await remove(previousUrl);
  return url;
}

/** An unsuccessful or malformed image upload never becomes an editor URL. */
export function parseUploadedImageUrl(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('url' in value)) return null;
  return typeof value.url === 'string' && value.url.trim() ? value.url : null;
}
