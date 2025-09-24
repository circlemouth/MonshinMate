import { LicenseEntry, LicenseTone } from '../types/license';

const STRONG_COPYLEFT_KEYWORDS = ['gpl', 'agpl'];
const WEAK_COPYLEFT_KEYWORDS = ['lgpl', 'epl', 'mpl'];
const PERMISSIVE_KEYWORDS = ['mit', 'bsd', 'apache', 'isc', 'zlib', 'unlicense', 'cc0'];

export function detectLicenseTone(license: string): LicenseTone {
  const normalized = (license || '').toLowerCase();
  if (!normalized) return 'unknown';
  if (STRONG_COPYLEFT_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return 'strong-copyleft';
  }
  if (WEAK_COPYLEFT_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return 'weak-copyleft';
  }
  if (PERMISSIVE_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return 'permissive';
  }
  if (normalized.includes('proprietary')) {
    return 'proprietary';
  }
  return 'unknown';
}

export function licenseToneColor(tone: LicenseTone): string {
  switch (tone) {
    case 'strong-copyleft':
      return 'red';
    case 'weak-copyleft':
      return 'orange';
    case 'permissive':
      return 'green';
    case 'proprietary':
      return 'purple';
    default:
      return 'gray';
  }
}

export function normalizeLicenseEntry(raw: Partial<LicenseEntry>): LicenseEntry {
  return {
    name: raw.name ?? 'unknown',
    version: raw.version ?? 'unknown',
    license: raw.license ?? '',
    text: raw.text ?? '',
    source: raw.source ?? 'unknown',
    component: raw.component ?? 'backend',
    category: raw.category ?? 'runtime',
    homepage: raw.homepage ?? null,
    author: raw.author ?? null,
    license_url: raw.license_url ?? null,
  };
}

export async function fetchDependencyLicenses(): Promise<LicenseEntry[]> {
  const res = await fetch('/docs/dependency_licenses.json', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error('ライセンス情報の取得に失敗しました');
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    return [];
  }
  return data
    .map((item) => normalizeLicenseEntry(item))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveLicenseName(license: string): string {
  if (!license) return '不明';
  return license;
}
