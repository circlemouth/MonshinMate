import { useState, useRef, useEffect } from 'react';
import { VStack, HStack, Input, Button, Box, Text, Flex, Avatar, Icon } from '@chakra-ui/react';
import { FiSend } from 'react-icons/fi';

interface Message {
  from: 'user' | 'bot';
  text: string;
}

/** LLM と対話するための簡易チャット画面。 */
export default function LLMChat() {
  const [messages, setMessages] = useState<Message[]>([
    { from: 'bot', text: 'こんにちは。どのようなご用件でしょうか？' }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<null | HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(scrollToBottom, [messages]);

  const handleSend = async () => {
    if (!input.trim()) return;
    const newMessages: Message[] = [...messages, { from: 'user', text: input }];
    setMessages(newMessages);
    setInput('');
    setIsLoading(true);

    try {
      const res = await fetch('/llm/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: input }),
      });
      if (!res.ok) {
        throw new Error('Network response was not ok');
      }
      const data = await res.json();
      setMessages([...newMessages, { from: 'bot', text: data.reply }]);
    } catch (error) {
      console.error("Failed to fetch chat reply:", error);
      setMessages([...newMessages, { from: 'bot', text: '申し訳ありません、エラーが発生しました。' }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <Flex h="100%" direction="column">
      <Box flex="1" overflowY="auto" px={{ base: 2, md: 3 }} py={{ base: 2, md: 3 }} bg="bg.subtle">
        <VStack spacing={4} align="stretch">
          {messages.map((m, i) => (
            <Flex key={i} justify={m.from === 'user' ? 'flex-end' : 'flex-start'}>
              {m.from === 'bot' && <Avatar name="ボット" bg="accent.solid" color="accent.onFilled" mr={2} />}
              <Box
                bg={m.from === 'user' ? 'accent.solid' : 'bg.surface'}
                color={m.from === 'user' ? 'accent.onFilled' : 'fg.default'}
                p={3}
                borderRadius="lg"
                maxW="80%"
                boxShadow="sm"
                borderWidth={m.from === 'bot' ? '1px' : '0'}
                borderColor={m.from === 'bot' ? 'border.accent' : 'transparent'}
              >
                <Text whiteSpace="pre-wrap">{m.text}</Text>
              </Box>
              {m.from === 'user' && <Avatar name="ユーザー" bg="accentAlpha.16" color="fg.accent" ml={2} />}
            </Flex>
          ))}
          <div ref={messagesEndRef} />
        </VStack>
      </Box>
      <Box px={{ base: 2, md: 3 }} py={{ base: 2, md: 3 }} borderTopWidth="1px" borderColor="border.accent" bg="bg.surface">
        <HStack>
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="メッセージを入力..."
            size="lg"
            borderRadius="full"
            bg="bg.subtle"
            _hover={{ bg: 'bg.emphasis' }}
            _focus={{ bg: 'bg.surface', borderColor: 'accent.solid', boxShadow: '0 0 0 1px var(--chakra-colors-accent-solid)' }}
            isDisabled={isLoading}
          />
          <Button
            onClick={handleSend}
            colorScheme="primary"
            borderRadius="full"
            size="lg"
            px={6}
            isLoading={isLoading}
            aria-label="メッセージを送信"
          >
            <Icon as={FiSend} />
          </Button>
        </HStack>
      </Box>
    </Flex>
  );
}
