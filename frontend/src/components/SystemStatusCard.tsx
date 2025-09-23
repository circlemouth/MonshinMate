import { Badge, Box, BoxProps, HStack, Icon, Stat, StatHelpText, StatLabel, StatNumber, Text } from '@chakra-ui/react';
import { ReactNode } from 'react';
import { IconType } from 'react-icons';

type SystemStatusTone = 'success' | 'warning' | 'error' | 'info';

const STATUS_COLOR_SCHEME: Record<SystemStatusTone, string> = {
  success: 'green',
  warning: 'orange',
  error: 'red',
  info: 'primary',
};

type SystemStatusCardProps = {
  icon: IconType;
  label: string;
  value: string;
  tone?: SystemStatusTone;
  description?: string | ReactNode;
  footer?: ReactNode;
} & BoxProps;

export default function SystemStatusCard({
  icon,
  label,
  value,
  tone = 'info',
  description,
  footer,
  ...boxProps
}: SystemStatusCardProps) {
  const colorScheme = STATUS_COLOR_SCHEME[tone];

  return (
    <Box
      bg="bg.surface"
      borderRadius="lg"
      px={4}
      py={3}
      boxShadow="xs"
      borderWidth="1px"
      borderColor="border.emphasized"
      {...boxProps}
    >
      <HStack spacing={3} align="flex-start">
        <Box
          bg={`${colorScheme}.50`}
          color={`${colorScheme}.600`}
          borderRadius="md"
          w={10}
          h={10}
          display="flex"
          alignItems="center"
          justifyContent="center"
        >
          <Icon as={icon} boxSize={5} />
        </Box>
        <Stat>
          <StatLabel fontSize="sm" color="fg.muted">
            {label}
          </StatLabel>
          <HStack spacing={2} align="center">
            <StatNumber fontSize="lg">{value}</StatNumber>
            <Badge colorScheme={colorScheme} variant="subtle" borderRadius="full" px={2} py={0.5}>
              {tone === 'success' && '正常'}
              {tone === 'warning' && '注意'}
              {tone === 'error' && '要確認'}
              {tone === 'info' && '情報'}
            </Badge>
          </HStack>
          {description && (
            <StatHelpText mb={footer ? 1 : 0}>
              {typeof description === 'string' ? <Text fontSize="sm">{description}</Text> : description}
            </StatHelpText>
          )}
          {footer && <Box fontSize="xs" color="fg.muted">{footer}</Box>}
        </Stat>
      </HStack>
    </Box>
  );
}
