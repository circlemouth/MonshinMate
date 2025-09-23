import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  Box,
  Button,
  FormControl,
  FormErrorMessage,
  FormLabel,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Text,
} from '@chakra-ui/react';
import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';

type DialogTone = 'info' | 'danger';

type ConfirmDialogOptions = {
  title: ReactNode;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  tone?: DialogTone;
};

type PromptDialogOptions = {
  title: ReactNode;
  description?: ReactNode;
  placeholder?: string;
  initialValue?: string;
  confirmText?: string;
  cancelText?: string;
  helperText?: ReactNode;
  validate?: (value: string) => string | null;
};

type DialogState =
  | { type: 'confirm'; options: ConfirmDialogOptions; resolve: (result: boolean) => void }
  | { type: 'prompt'; options: PromptDialogOptions; resolve: (result: string | null) => void };

interface DialogContextValue {
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  prompt: (options: PromptDialogOptions) => Promise<string | null>;
}

const DialogContext = createContext<DialogContextValue | undefined>(undefined);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);

  const closeDialog = useCallback(() => {
    setDialog(null);
    setInputValue('');
    setInputError(null);
  }, []);

  const confirm = useCallback((options: ConfirmDialogOptions) => {
    return new Promise<boolean>((resolve) => {
      setDialog({ type: 'confirm', options, resolve });
    });
  }, []);

  const prompt = useCallback((options: PromptDialogOptions) => {
    return new Promise<string | null>((resolve) => {
      setInputValue(options.initialValue ?? '');
      setInputError(null);
      setDialog({ type: 'prompt', options, resolve });
    });
  }, []);

  const handleCancel = useCallback(() => {
    if (!dialog) return;
    if (dialog.type === 'confirm') {
      dialog.resolve(false);
    } else if (dialog.type === 'prompt') {
      dialog.resolve(null);
    }
    closeDialog();
  }, [dialog, closeDialog]);

  const handleConfirm = useCallback(() => {
    if (!dialog) return;
    if (dialog.type === 'confirm') {
      dialog.resolve(true);
      closeDialog();
      return;
    }
    const value = inputValue ?? '';
    if (dialog.options.validate) {
      const result = dialog.options.validate(value);
      if (result) {
        setInputError(result);
        return;
      }
    }
    dialog.resolve(value);
    closeDialog();
  }, [dialog, inputValue, closeDialog]);

  const dialogTone = dialog?.type === 'confirm' ? dialog.options.tone ?? 'info' : 'info';
  const confirmColorScheme = dialogTone === 'danger' ? 'red' : 'primary';

  const value = useMemo(() => ({ confirm, prompt }), [confirm, prompt]);

  return (
    <DialogContext.Provider value={value}>
      {children}

      <AlertDialog
        isOpen={dialog?.type === 'confirm'}
        leastDestructiveRef={cancelRef}
        onClose={handleCancel}
        isCentered
        closeOnOverlayClick={false}
      >
        <AlertDialogOverlay />
        <AlertDialogContent>
          <AlertDialogHeader fontSize="lg" fontWeight="bold">
            {dialog?.type === 'confirm' ? dialog.options.title : null}
          </AlertDialogHeader>
          <AlertDialogBody>
            {dialog?.type === 'confirm' && dialog.options.description}
          </AlertDialogBody>
          <AlertDialogFooter>
            <Button ref={cancelRef} onClick={handleCancel} mr={3}>
              {dialog?.type === 'confirm' ? dialog.options.cancelText ?? 'キャンセル' : 'キャンセル'}
            </Button>
            <Button colorScheme={confirmColorScheme} onClick={handleConfirm}>
              {dialog?.type === 'confirm' ? dialog.options.confirmText ?? '実行' : '確定'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Modal
        isOpen={dialog?.type === 'prompt'}
        onClose={handleCancel}
        isCentered
        closeOnOverlayClick={false}
      >
        <ModalOverlay />
        <ModalContent
          as="form"
          onSubmit={(event) => {
            event.preventDefault();
            handleConfirm();
          }}
        >
          <ModalHeader>{dialog?.type === 'prompt' ? dialog.options.title : null}</ModalHeader>
          <ModalBody>
            {dialog?.type === 'prompt' && (
              <FormControl isInvalid={!!inputError}>
                {dialog.options.description && (
                  <Text mb={3} fontSize="sm">
                    {dialog.options.description}
                  </Text>
                )}
                <FormLabel srOnly>入力</FormLabel>
                <Input
                  value={inputValue}
                  placeholder={dialog.options.placeholder}
                  onChange={(event) => {
                    setInputValue(event.target.value);
                    setInputError(null);
                  }}
                  autoFocus
                />
                {dialog.options.helperText && (
                  <Box mt={2} fontSize="xs" color="fg.muted">
                    {dialog.options.helperText}
                  </Box>
                )}
                {inputError && <FormErrorMessage>{inputError}</FormErrorMessage>}
              </FormControl>
            )}
          </ModalBody>
          <ModalFooter>
            <Button mr={3} onClick={handleCancel}>
              {dialog?.type === 'prompt' ? dialog.options.cancelText ?? 'キャンセル' : 'キャンセル'}
            </Button>
            <Button colorScheme="primary" onClick={handleConfirm} type="submit">
              {dialog?.type === 'prompt' ? dialog.options.confirmText ?? '確定' : '確定'}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </DialogContext.Provider>
  );
}

export function useDialog() {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error('useDialog must be used within DialogProvider');
  }
  return ctx;
}
