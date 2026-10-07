import { useLayoutEffect, useRef } from 'react';
import { createRequestScope } from '../utils/requestScope';
export function useRequestScope() {
  const scope = useRef(createRequestScope());
  useLayoutEffect(() => () => scope.current.cancel(), []);
  return scope.current;
}
