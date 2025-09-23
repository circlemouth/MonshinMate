import { ChevronDownIcon } from '@chakra-ui/icons';
import {
  Box,
  IconButton,
  Input,
  InputGroup,
  InputRightElement,
  List,
  ListItem,
  Text,
  useOutsideClick,
} from '@chakra-ui/react';
import {
  KeyboardEvent,
  ChangeEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

interface ComboboxProps {
  value: string;
  options: string[];
  placeholder?: string;
  isDisabled?: boolean;
  emptyMessage?: string;
  onChange: (next: string) => void;
  onSelect?: (next: string) => void;
  openSignal?: number;
}

/**
 * シンプルな文字列用コンボボックス。
 */
export function Combobox({
  value,
  options,
  placeholder,
  isDisabled,
  emptyMessage = '一致する候補がありません',
  onChange,
  onSelect,
  openSignal,
}: ComboboxProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Array<HTMLLIElement | null>>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const listboxId = useId();
  const activeId = highlightIndex >= 0 ? `${listboxId}-option-${highlightIndex}` : undefined;
  const lastOpenSignal = useRef<number | undefined>(undefined);

  useOutsideClick({
    ref: containerRef,
    handler: () => setIsOpen(false),
  });

  const filteredOptions = useMemo(() => {
    const keyword = value.trim().toLowerCase();
    if (!keyword) return options;
    return options.filter((option) => option.toLowerCase().includes(keyword));
  }, [options, value]);

  useEffect(() => {
    if (openSignal === undefined) return;
    if (openSignal === lastOpenSignal.current) return;
    lastOpenSignal.current = openSignal;
    if (isDisabled || options.length === 0) return;
    setIsOpen(true);
    setHighlightIndex(filteredOptions.length > 0 ? 0 : -1);
    inputRef.current?.focus();
  }, [filteredOptions.length, isDisabled, openSignal, options.length]);

  useEffect(() => {
    if (highlightIndex >= filteredOptions.length) {
      setHighlightIndex(filteredOptions.length > 0 ? filteredOptions.length - 1 : -1);
    }
  }, [filteredOptions.length, highlightIndex]);

  useEffect(() => {
    if (!isOpen) {
      setHighlightIndex(-1);
    }
  }, [isOpen]);

  useEffect(() => {
    if (isDisabled) {
      setIsOpen(false);
    }
  }, [isDisabled]);

  useEffect(() => {
    const node = optionRefs.current[highlightIndex];
    if (node) {
      node.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightIndex]);

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    onChange(next);
    if (!isDisabled) {
      setIsOpen(true);
      setHighlightIndex(-1);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isDisabled) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        setHighlightIndex(filteredOptions.length > 0 ? 0 : -1);
        return;
      }
      if (filteredOptions.length === 0) return;
      setHighlightIndex((prev) => {
        const nextIndex = prev + 1;
        if (nextIndex >= filteredOptions.length) return 0;
        return nextIndex;
      });
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        setHighlightIndex(filteredOptions.length > 0 ? filteredOptions.length - 1 : -1);
        return;
      }
      if (filteredOptions.length === 0) return;
      setHighlightIndex((prev) => {
        const nextIndex = prev - 1;
        if (nextIndex < 0) return filteredOptions.length - 1;
        return nextIndex;
      });
      return;
    }
    if (event.key === 'Enter') {
      if (!isOpen) return;
      event.preventDefault();
      if (highlightIndex >= 0 && highlightIndex < filteredOptions.length) {
        const selected = filteredOptions[highlightIndex];
        onChange(selected);
        onSelect?.(selected);
        setIsOpen(false);
      }
      return;
    }
    if (event.key === 'Escape') {
      if (!isOpen) return;
      event.preventDefault();
      setIsOpen(false);
    }
  };

  const handleToggle = () => {
    if (isDisabled || options.length === 0) return;
    setIsOpen((prev) => {
      const next = !prev;
      if (next && filteredOptions.length > 0) {
        setHighlightIndex(0);
      }
      return next;
    });
    inputRef.current?.focus();
  };

  const handleOptionSelect = (option: string) => {
    onChange(option);
    onSelect?.(option);
    setIsOpen(false);
  };

  return (
    <Box ref={containerRef} position="relative">
      <InputGroup>
        <Input
          ref={inputRef}
          role="combobox"
          aria-controls={`${listboxId}-listbox`}
          aria-expanded={isOpen}
          aria-activedescendant={activeId}
          value={value}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (!isDisabled && options.length > 0) {
              setIsOpen(true);
            }
          }}
          placeholder={placeholder}
          autoComplete="off"
          isDisabled={isDisabled}
        />
        <InputRightElement height="100%" pr={1}>
          <IconButton
            aria-label="候補一覧を開く"
            icon={<ChevronDownIcon transform={isOpen ? 'rotate(180deg)' : undefined} />}
            size="sm"
            variant="ghost"
            onClick={handleToggle}
            onMouseDown={(event) => event.preventDefault()}
            isDisabled={isDisabled || options.length === 0}
            aria-haspopup="listbox"
          />
        </InputRightElement>
      </InputGroup>
      {isOpen && (
        <Box
          id={`${listboxId}-listbox`}
          role="listbox"
          position="absolute"
          top="calc(100% + 4px)"
          left={0}
          right={0}
          borderWidth="1px"
          borderRadius="md"
          bg="white"
          boxShadow="lg"
          zIndex={10}
          maxH="240px"
          overflowY="auto"
          borderColor="border.default"
        >
          {filteredOptions.length === 0 ? (
            <Box px={3} py={2}>
              <Text fontSize="sm" color="gray.500">
                {emptyMessage}
              </Text>
            </Box>
          ) : (
            <List spacing={1} py={1}>
              {filteredOptions.map((option, index) => (
                <ListItem
                  key={`${option}-${index}`}
                  ref={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  role="option"
                  id={`${listboxId}-option-${index}`}
                  px={3}
                  py={2}
                  fontSize="sm"
                  cursor="pointer"
                  bg={index === highlightIndex ? 'accent.subtle' : 'transparent'}
                  color={index === highlightIndex ? 'fg.accent' : 'fg.default'}
                  _hover={{ bg: 'bg.subtle' }}
                  borderRadius="md"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => handleOptionSelect(option)}
                  aria-selected={option === value}
                >
                  {option}
                </ListItem>
              ))}
            </List>
          )}
        </Box>
      )}
    </Box>
  );
}

export default Combobox;
