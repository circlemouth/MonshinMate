import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertStatus,
  AlertTitle,
  Box,
  Button,
  CloseButton,
  Flex,
  ToastId,
  useToast,
} from '@chakra-ui/react';
import { ReactNode, createContext, useCallback, useContext, useMemo } from 'react';

type NotifyChannel = 'admin' | 'patient';

export interface NotifyOptions {
  title?: ReactNode;
  description?: ReactNode;
  status?: AlertStatus;
  channel?: NotifyChannel;
  actionLabel?: string;
  onAction?: () => void;
  dismissOnAction?: boolean;
  duration?: number | null;
  isClosable?: boolean;
  id?: ToastId;
}

interface NotificationContextValue {
  notify: (options: NotifyOptions) => ToastId;
  close: (id: ToastId) => void;
  closeAll: () => void;
}

const NotificationContext = createContext<NotificationContextValue | undefined>(undefined);

interface ToastContentProps {
  title?: ReactNode;
  description?: ReactNode;
  status: AlertStatus;
  channel: NotifyChannel;
  isClosable: boolean;
  onClose: () => void;
  actionLabel?: string;
  onAction?: () => void;
}

function ToastContent({
  title,
  description,
  status,
  channel,
  isClosable,
  onClose,
  actionLabel,
  onAction,
}: ToastContentProps) {
  const variant = channel === 'patient' ? 'solid' : 'left-accent';
  const textColor = channel === 'patient' ? 'whiteAlpha.900' : undefined;

  return (
    <Alert
      status={status}
      variant={variant}
      borderRadius="md"
      boxShadow="xl"
      alignItems="flex-start"
      minW={channel === 'patient' ? '280px' : '320px'}
      maxW="480px"
      pr={3}
      py={3}
    >
      <AlertIcon mt={1} color={textColor} />
      <Box flex="1" color={textColor}>
        {title && (
          <AlertTitle fontSize="md" lineHeight="short">
            {title}
          </AlertTitle>
        )}
        {description && (
          <AlertDescription mt={title ? 1 : 0} fontSize="sm" lineHeight="shorter">
            {description}
          </AlertDescription>
        )}
      </Box>
      {(isClosable || (actionLabel && onAction)) && (
        <Flex direction="column" align="flex-end" gap={2} ml={3} mt={title || description ? 0 : 1}>
          {actionLabel && onAction && (
            <Button
              size="sm"
              variant={channel === 'patient' ? 'outline' : 'ghost'}
              colorScheme={channel === 'patient' ? 'whiteAlpha' : 'primary'}
              onClick={onAction}
            >
              {actionLabel}
            </Button>
          )}
          {isClosable && <CloseButton size="sm" onClick={onClose} color={textColor} />}
        </Flex>
      )}
    </Alert>
  );
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const toast = useToast();

  const notify = useCallback(
    ({
      channel = 'admin',
      status = 'info',
      actionLabel,
      onAction,
      dismissOnAction = true,
      duration,
      isClosable = true,
      title,
      description,
      id,
    }: NotifyOptions) => {
      const position = channel === 'patient' ? 'bottom' : 'top-right';
      const resolvedDuration = duration !== undefined ? duration : channel === 'patient' ? 8000 : 5000;

      const toastId = toast({
        id,
        position,
        duration: resolvedDuration === null ? null : resolvedDuration,
        isClosable,
        render: ({ onClose }) => (
          <ToastContent
            title={title}
            description={description}
            status={status}
            channel={channel}
            isClosable={isClosable}
            onClose={onClose}
            actionLabel={actionLabel}
            onAction={
              actionLabel && onAction
                ? () => {
                    onAction();
                    if (dismissOnAction) {
                      onClose();
                    }
                  }
                : undefined
            }
          />
        ),
      });

      return toastId;
    },
    [toast],
  );

  const close = useCallback((id: ToastId) => toast.close(id), [toast]);
  const closeAll = useCallback(() => toast.closeAll(), [toast]);

  const value = useMemo(
    () => ({ notify, close, closeAll }),
    [notify, close, closeAll],
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

export function useNotify() {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error('useNotify must be used within NotificationProvider');
  }
  return ctx;
}
