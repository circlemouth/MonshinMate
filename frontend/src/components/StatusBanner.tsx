import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertProps,
  AlertStatus,
  AlertTitle,
  Box,
  HStack,
} from '@chakra-ui/react';
import { ReactNode } from 'react';

interface StatusBannerProps extends Omit<AlertProps, 'status'> {
  status: AlertStatus;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  showIcon?: boolean;
}

export function StatusBanner({
  status,
  title,
  description,
  actions,
  showIcon = true,
  ...alertProps
}: StatusBannerProps) {
  return (
    <Alert
      status={status}
      variant="subtle"
      borderRadius="md"
      alignItems="flex-start"
      py={3}
      px={4}
      {...alertProps}
    >
      {showIcon && <AlertIcon mt={title ? 0.5 : 0} />}
      <Box flex="1">
        {title && (
          <AlertTitle fontSize="sm" fontWeight="semibold" lineHeight="short">
            {title}
          </AlertTitle>
        )}
        {description && (
          <AlertDescription mt={title ? 1 : 0} fontSize="sm" lineHeight="shorter">
            {description}
          </AlertDescription>
        )}
        {!title && !description && (
          <AlertDescription fontSize="sm" lineHeight="shorter">
            通知情報がありません。
          </AlertDescription>
        )}
      </Box>
      {actions && (
        <HStack spacing={2} ml={4} align="center">
          {actions}
        </HStack>
      )}
    </Alert>
  );
}

export default StatusBanner;
