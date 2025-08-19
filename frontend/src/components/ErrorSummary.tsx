import { Alert, AlertIcon, AlertTitle, AlertDescription, UnorderedList, ListItem } from '@chakra-ui/react';
import { useEffect, useRef } from 'react';

interface Props {
  title?: string;
  errors: string[];
}

// 入力エラーの上部サマリー（スクリーンリーダに配慮して自動フォーカス）
export default function ErrorSummary({ title = '入力内容を確認してください', errors }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (errors.length && ref.current) {
      ref.current.focus();
    }
  }, [errors.length]);

  if (!errors.length) return null;

  return (
    <Alert status="error" role="alert" variant="subtle" tabIndex={-1} ref={ref} borderRadius="8px">
      <AlertIcon />
      <AlertTitle mr={2}>{title}</AlertTitle>
      <AlertDescription>
        <UnorderedList mt={1} style={{ marginInlineStart: '1.25rem' }}>
          {errors.map((e, idx) => (
            <ListItem key={idx}>{e}</ListItem>
          ))}
        </UnorderedList>
      </AlertDescription>
    </Alert>
  );
}

