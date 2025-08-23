import { useEffect, useState } from 'react';
import { VStack, FormControl, FormLabel, Input, Button, HStack, Text } from '@chakra-ui/react';

/** システム表示名の設定画面。 */
export default function AdminSystemName() {
  const [name, setName] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/system/display-name')
      .then((r) => r.json())
      .then((d) => setName(d.display_name || 'Monshinクリニック'));
  }, []);

  const save = async () => {
    setLoading(true);
    setStatus('');
    try {
      const res = await fetch('/system/display-name', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: name || 'Monshinクリニック' }),
      });
      if (!res.ok) throw new Error('save_failed');
      const data = await res.json();
      setName(data.display_name || 'Monshinクリニック');
      setStatus('保存しました');
      try {
        // App ヘッダーへ即時反映させるためのイベントを発火
        window.dispatchEvent(new CustomEvent('systemDisplayNameUpdated', { detail: data.display_name }));
      } catch {}
    } catch (e) {
      setStatus('保存に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  return (
    <VStack spacing={4} align="stretch">
      <FormControl>
        <FormLabel>システム表示名</FormLabel>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例: Monshinクリニック" />
      </FormControl>
      <HStack>
        <Button onClick={save} colorScheme="primary" isLoading={loading}>保存</Button>
        <Text>{status}</Text>
      </HStack>
    </VStack>
  );
}

