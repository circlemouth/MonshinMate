export type LicenseEntry = {
  name: string;
  version: string;
  license: string;
  text: string;
  source: string;
  component: string;
  category: string;
  homepage?: string | null;
  author?: string | null;
  license_url?: string | null;
};

export type LicenseTone =
  | 'strong-copyleft'
  | 'weak-copyleft'
  | 'permissive'
  | 'proprietary'
  | 'unknown';
