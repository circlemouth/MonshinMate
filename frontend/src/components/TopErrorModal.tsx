import { useEffect } from 'react';
import { Modal, ModalOverlay, ModalContent, ModalHeader, ModalCloseButton, ModalBody } from '@chakra-ui/react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  message: string;
}

/** 画面上部に表示するエラーモーダル。 */
export default function TopErrorModal({ isOpen, onClose, message }: Props) {
  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(onClose, 10000);
    return () => clearTimeout(timer);
  }, [isOpen, onClose]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} isCentered={false} motionPreset="slideInTop">
      <ModalOverlay />
      <ModalContent mt={10}>
        <ModalHeader>エラー</ModalHeader>
        <ModalCloseButton />
        <ModalBody whiteSpace="pre-wrap">{message}</ModalBody>
      </ModalContent>
    </Modal>
  );
}

