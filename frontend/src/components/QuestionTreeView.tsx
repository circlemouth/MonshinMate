import { useMemo } from 'react';
import { AddIcon } from '@chakra-ui/icons';
import { Badge, Box, Button, HStack, Stack, Text, useColorModeValue } from '@chakra-ui/react';

export interface QuestionTreeItem {
  id: string;
  label: string;
  followups?: Record<string, QuestionTreeItem[] | undefined>;
}

interface QuestionTreeViewProps {
  items: QuestionTreeItem[];
  selectedItemId?: string | null;
  onSelect?: (itemId: string) => void;
  onInsertAt?: (index: number) => void;
}

const OPTION_LABEL_MAP: Record<string, string> = {
  yes: 'はい',
  no: 'いいえ',
};

const formatOptionLabel = (option: string): string => {
  if (!option) return '未設定';
  return OPTION_LABEL_MAP[option] ?? option;
};

const InsertDivider = ({ onClick }: { onClick?: () => void }) => {
  if (!onClick) return null;
  return (
    <Button
      size="xs"
      leftIcon={<AddIcon boxSize={2.5} />}
      variant="ghost"
      colorScheme="primary"
      justifyContent="flex-start"
      onClick={onClick}
      aria-label="この位置に問診項目を追加"
    >
      この位置に追加
    </Button>
  );
};

const QuestionTreeView = ({ items, selectedItemId, onSelect, onInsertAt }: QuestionTreeViewProps) => {
  const lineColor = useColorModeValue('gray.300', 'gray.600');

  const elements = useMemo(() => {
    const renderNode = (
      item: QuestionTreeItem,
      depth: number,
      optionLabel?: string,
      keyPrefix?: string
    ): JSX.Element[] => {
      const nodes: JSX.Element[] = [];
      const indentPx = depth * 24;
      const selected = selectedItemId === item.id;
      const followupEntries = Object.entries(item.followups ?? {}).filter(([, arr]) => (arr?.length ?? 0) > 0);
      const hasFollowups = followupEntries.length > 0;
      const keyBase = keyPrefix ? `${keyPrefix}-${item.id}` : item.id;

      nodes.push(
        <Box
          key={`${keyBase}-node`}
          role="treeitem"
          aria-level={depth + 1}
          aria-selected={selected}
          pl={`${indentPx}px`}
          position="relative"
        >
          {depth > 0 && (
            <>
              <Box
                position="absolute"
                left={`${Math.max(indentPx - 12, 0)}px`}
                top="0.4rem"
                bottom="0.4rem"
                borderLeftWidth="1px"
                borderLeftColor={lineColor}
              />
              <Box
                position="absolute"
                left={`${Math.max(indentPx - 12, 0)}px`}
                top="1.2rem"
                width="12px"
                borderTopWidth="1px"
                borderTopColor={lineColor}
              />
            </>
          )}
          <HStack align="center" spacing={2} py={1} pr={2}>
            {optionLabel && (
              <Badge colorScheme="gray" variant="subtle">
                {optionLabel}
              </Badge>
            )}
            <Button
              size="sm"
              variant={selected ? 'solid' : 'ghost'}
              colorScheme={selected ? 'primary' : undefined}
              justifyContent="flex-start"
              whiteSpace="normal"
              height="auto"
              fontWeight={selected ? 'bold' : 'normal'}
              onClick={() => onSelect?.(item.id)}
            >
              {item.label || '無題の質問'}
            </Button>
            {hasFollowups && (
              <Badge colorScheme="blue" variant="solid">
                追
              </Badge>
            )}
          </HStack>
        </Box>
      );

      followupEntries.forEach(([optionKey, children], optionIndex) => {
        const formatted = formatOptionLabel(optionKey);
        children?.forEach((child, childIndex) => {
          nodes.push(
            ...renderNode(child, depth + 1, formatted, `${keyBase}-${optionIndex}-${childIndex}`)
          );
        });
      });

      return nodes;
    };

    const treeNodes: JSX.Element[] = [];
    items.forEach((item, index) => {
      if (onInsertAt) {
        treeNodes.push(
          <Box key={`divider-${item.id}`} pl={1}>
            <InsertDivider onClick={() => onInsertAt(index)} />
          </Box>
        );
      }
      treeNodes.push(...renderNode(item, 0, undefined, `root-${index}`));
    });
    if (onInsertAt) {
      treeNodes.push(
        <Box key="divider-end" pl={1}>
          <InsertDivider onClick={() => onInsertAt(items.length)} />
        </Box>
      );
    }
    return treeNodes;
  }, [items, onInsertAt, selectedItemId, lineColor, onSelect]);

  return (
    <Stack spacing={1} role="tree" aria-label="問診項目の分岐ツリー" align="stretch">
      {items.length === 0 ? (
        <Box py={2} pl={1}>
          <Text fontSize="sm" color="gray.600" mb={2}>
            まだ問診項目がありません。下の「追加」ボタンから新しい質問を挿入できます。
          </Text>
          {onInsertAt && <InsertDivider onClick={() => onInsertAt(0)} />}
        </Box>
      ) : (
        elements
      )}
    </Stack>
  );
};

export default QuestionTreeView;
