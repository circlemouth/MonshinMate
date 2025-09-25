export const personalInfoFields = [
  { key: 'name', label: '患者名', placeholder: '問診 太郎', autoComplete: 'name' },
  { key: 'kana', label: 'よみがな', placeholder: 'もんしん たろう', autoComplete: 'off' },
  { key: 'postal_code', label: '郵便番号', placeholder: '123-4567', autoComplete: 'postal-code', inputMode: 'numeric' },
  { key: 'address', label: '住所', placeholder: '〇〇県〇〇市...', autoComplete: 'street-address' },
  { key: 'phone', label: '電話番号', placeholder: '090-1234-5678', autoComplete: 'tel', inputMode: 'tel' },
] as const;

export type PersonalInfoKey = typeof personalInfoFields[number]['key'];

export type PersonalInfoValue = Record<PersonalInfoKey, string>;

export const createPersonalInfoValue = (defaults?: Partial<PersonalInfoValue>): PersonalInfoValue => ({
  name: defaults?.name ?? '',
  kana: defaults?.kana ?? '',
  postal_code: defaults?.postal_code ?? '',
  address: defaults?.address ?? '',
  phone: defaults?.phone ?? '',
});

export const isPersonalInfoValue = (value: any): value is PersonalInfoValue => {
  if (!value || typeof value !== 'object') return false;
  return personalInfoFields.every(({ key }) => typeof value[key] === 'string');
};

export const mergePersonalInfoValue = (
  value: any,
  defaults?: Partial<PersonalInfoValue>
): PersonalInfoValue => {
  const base = createPersonalInfoValue(defaults);
  if (!isPersonalInfoValue(value)) {
    return base;
  }
  const merged: PersonalInfoValue = { ...base };
  personalInfoFields.forEach(({ key }) => {
    merged[key] = String(value[key] ?? '');
  });
  return merged;
};

export const personalInfoMissingKeys = (value: PersonalInfoValue): PersonalInfoKey[] =>
  personalInfoFields
    .filter(({ key }) => !value[key].trim())
    .map(({ key }) => key);

export interface PersonalInfoEntry {
  key: PersonalInfoKey;
  label: string;
  value: string;
  hasValue: boolean;
}

export interface BuildPersonalInfoOptions {
  defaults?: Partial<PersonalInfoValue>;
  skipKeys?: PersonalInfoKey[];
  hideEmpty?: boolean;
  placeholder?: string;
}

export const buildPersonalInfoEntries = (
  value: any,
  options?: BuildPersonalInfoOptions
): PersonalInfoEntry[] => {
  const normalized = mergePersonalInfoValue(value, options?.defaults);
  const skipSet = new Set(options?.skipKeys ?? []);
  const placeholder = options?.placeholder ?? '未回答';

  return personalInfoFields
    .filter(({ key }) => !skipSet.has(key))
    .map(({ key, label }) => {
      const raw = typeof normalized[key] === 'string' ? normalized[key].trim() : '';
      const hasValue = raw.length > 0;
      const displayValue = hasValue ? raw : placeholder;
      const entry: PersonalInfoEntry = { key, label, value: displayValue, hasValue };
      return entry;
    })
    .filter((entry) => !options?.hideEmpty || entry.hasValue);
};

export const formatPersonalInfoLines = (value: any): string[] =>
  buildPersonalInfoEntries(value).map(({ label, value }) => `${label}: ${value}`);
