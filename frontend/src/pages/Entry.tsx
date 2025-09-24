import {
  VStack,
  FormControl,
  FormLabel,
  Button,
  FormErrorMessage,
  FormHelperText,
  SimpleGrid,
  Text,
  Flex,
} from '@chakra-ui/react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { track } from '../metrics';
import { refreshLlmStatus } from '../utils/llmStatus';

const VISIT_OPTIONS = [
  {
    value: 'initial',
    main: 'はい',
    caption: '（初診）',
  },
  {
    value: 'followup',
    main: 'いいえ',
    caption: '（再診）',
  },
] as const;

/** 初診/再診の選択を行うエントリページ。 */
export default function Entry() {
  const navigate = useNavigate();

  const [visitType, setVisitType] = useState('');
  const [entryMessage, setEntryMessage] = useState('不明点があれば受付にお知らせください');
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    [
      'session_id',
      'answers',
      'questionnaire_items',
      'summary',
      'visit_type',
      'llm_error',
      'patient_name',
      'dob',
      'gender',
      'personal_info',
    ].forEach((k) => sessionStorage.removeItem(k));
  }, []);

  useEffect(() => {
    refreshLlmStatus();
  }, []);

  useEffect(() => {
    fetch('/system/entry-message')
      .then((r) => r.json())
      .then((d) => setEntryMessage(d.message || '不明点があれば受付にお知らせください'));
  }, []);

  useEffect(() => {
    if (attempted && !visitType) {
      document.getElementById('visit-type-initial')?.focus();
    }
  }, [attempted, visitType]);

  const handleVisitTypeSelect = (value: string) => {
    setVisitType(value);
    setAttempted(false);
  };

  const handleStart = () => {
    setAttempted(true);
    if (!visitType) {
      track('validation_failed', { page: 'Entry', count: 1 });
      return;
    }

    sessionStorage.setItem('visit_type', visitType);
    [
      'patient_name',
      'dob',
      'gender',
      'personal_info',
      'session_id',
      'answers',
      'questionnaire_items',
      'summary',
      'llm_error',
    ].forEach((k) => sessionStorage.removeItem(k));

    navigate('/basic-info');
  };

  return (
    <form autoComplete="off" onSubmit={(e) => e.preventDefault()}>
      <VStack spacing={6} align="stretch">
        <FormControl isRequired isInvalid={attempted && !visitType}>
          <FormLabel textAlign="center" fontSize="2xl" fontWeight="bold">
            当院の受診は初めてですか？
          </FormLabel>
          <SimpleGrid
            columns={{ base: 1, md: 2 }}
            spacing={5}
            maxW="640px"
            mx="auto"
            w="full"
          >
            {VISIT_OPTIONS.map((option) => {
              const isSelected = visitType === option.value;
              return (
                <Button
                  key={option.value}
                  id={`visit-type-${option.value}`}
                  onClick={() => handleVisitTypeSelect(option.value)}
                  variant="outline"
                  height="104px"
                  py={5}
                  px={4}
                  borderRadius="lg"
                  borderWidth={isSelected ? 2 : 1}
                  w="full"
                  boxShadow={isSelected ? 'md' : 'base'}
                  aria-pressed={isSelected}
                  bg={isSelected ? 'accent.subtle' : 'white'}
                  color="fg.default"
                  borderColor={isSelected ? 'border.accent' : 'neutral.300'}
                  _hover={{ bg: isSelected ? 'accent.muted' : 'bg.subtle' }}
                  _active={{ bg: isSelected ? 'accent.muted' : 'bg.emphasis' }}
                >
                  <VStack spacing={1}>
                    <Text fontSize="lg" fontWeight="bold" textAlign="center">
                      {option.main}
                    </Text>
                    <Text fontSize="sm" color="fg.muted" textAlign="center">
                      {option.caption}
                    </Text>
                  </VStack>
                </Button>
              );
            })}
          </SimpleGrid>
          <FormHelperText textAlign="center">{entryMessage}</FormHelperText>
          <FormErrorMessage>選択してください</FormErrorMessage>
        </FormControl>

        <Flex justifyContent="center">
          <Button
            onClick={handleStart}
            colorScheme="primary"
            size="lg"
            w={{ base: '100%', sm: '280px' }}
            maxW="400px"
            py={6}
            fontSize="lg"
            isDisabled={!visitType}
          >
            問診を始める
          </Button>
        </Flex>
      </VStack>
    </form>
  );
}
