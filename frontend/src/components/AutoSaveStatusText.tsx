import { Text } from '@chakra-ui/react';
import { AutoSaveStatus } from '../hooks/useAutoSave';

interface Props {
  status: AutoSaveStatus;
  message?: string | null;
}

export default function AutoSaveStatusText({ status, message }: Props) {
  if (status === 'saving') {
    return (
      <Text fontSize="xs" color="fg.muted" aria-live="polite">
        保存中...
      </Text>
    );
  }
  if (status === 'saved') {
    return (
      <Text fontSize="xs" color="green.500" aria-live="polite">
        保存しました
      </Text>
    );
  }
  if (status === 'error') {
    return (
      <Text fontSize="xs" color="red.500" aria-live="assertive">
        {message || '保存に失敗しました。少し待って再度お試しください。'}
      </Text>
    );
  }
  return null;
}
