export async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.clone().json();
    const detail =
      typeof data?.detail === 'string'
        ? data.detail
        : typeof data?.message === 'string'
        ? data.message
        : null;
    if (detail) return detail;
  } catch {
    try {
      const text = await res.clone().text();
      if (text) return text;
    } catch {
      // ignore parsing errors
    }
  }
  return fallback;
}
