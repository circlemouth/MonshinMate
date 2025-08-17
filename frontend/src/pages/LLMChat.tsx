import { useState } from 'react';
import { VStack, HStack, Input, Button, Box, Text } from '@chakra-ui/react';

interface Message {
  from: 'user' | 'bot';
  text: string;
}

/** LLM と対話するための簡易チャット画面。 */
export default function LLMChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');

  const send = async () => {
    if (!input) return;
    const newMessages = [...messages, { from: 'user', text: input }];
    setMessages(newMessages);
    const res = await fetch('/llm/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: input }),
    });
    const data = await res.json();
    setMessages([...newMessages, { from: 'bot', text: data.reply }]);
    setInput('');
  };

  return (
    <VStack spacing={4} align="stretch">
      <Box border="1px" borderColor="gray.200" p={2} h="300px" overflowY="auto">
        {messages.map((m, i) => (
          <Text key={i} color={m.from === 'user' ? 'blue.600' : 'green.600'}>
            {m.text}
          </Text>
        ))}
      </Box>
      <HStack>
        <Input value={input} onChange={(e) => setInput(e.target.value)} />
        <Button onClick={send} colorScheme="orange">
          送信
        </Button>
      </HStack>
    </VStack>
  );
}
