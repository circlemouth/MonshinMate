import { forwardRef } from 'react';
import { Box, BoxProps } from '@chakra-ui/react';

/**
 * Common container that applies accent background & outline.
 * Useful for cards or selection states to keep styling consistent.
 */
const AccentOutlineBox = forwardRef<HTMLDivElement, BoxProps>((props, ref) => (
  <Box
    ref={ref}
    borderWidth="1px"
    borderColor="border.accent"
    bg="bg.subtle"
    borderRadius="lg"
    {...props}
  />
));

AccentOutlineBox.displayName = 'AccentOutlineBox';

export default AccentOutlineBox;
