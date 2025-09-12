import { HStack, Select } from '@chakra-ui/react';
import { useMemo } from 'react';

/** 年月日をプルダウンで選択する日付入力コンポーネント */
export default function DateSelect({ value, onChange }: { value?: string; onChange: (val: string) => void; }) {
  const [year, month, day] = (value || '').split('-');
  const years = useMemo(() => {
    const current = new Date().getFullYear();
    return Array.from({ length: current - 1899 }, (_, i) => String(current - i));
  }, []);
  const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
  const daysInMonth = useMemo(() => {
    if (!year || !month) return 31;
    return new Date(Number(year), Number(month), 0).getDate();
  }, [year, month]);
  const days = Array.from({ length: daysInMonth }, (_, i) => String(i + 1).padStart(2, '0'));

  const update = (y: string, m: string, d: string) => {
    if (y && m && d) {
      onChange(`${y}-${m}-${d}`);
    } else {
      onChange('');
    }
  };

  return (
    <HStack>
      <Select placeholder="年" value={year || ''} onChange={(e) => update(e.target.value, month, day)} autoComplete="off">
        {years.map((y) => (
          <option key={y} value={y}>{y}</option>
        ))}
      </Select>
      <Select placeholder="月" value={month || ''} onChange={(e) => update(year, e.target.value, day)} autoComplete="off">
        {months.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </Select>
      <Select placeholder="日" value={day || ''} onChange={(e) => update(year, month, e.target.value)} autoComplete="off">
    {days.map((d) => (
      <option key={d} value={d}>{d}</option>
    ))}
      </Select>
    </HStack>
  );
}
