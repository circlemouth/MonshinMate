// A mounted view owns its requests. Cancel also invalidates mocks/non-abortable responses.
export function createRequestScope() {
  let active: AbortController | null = null;
  const cancel = () => { active?.abort(); active = null; };
  const start = () => {
    cancel();
    const controller = new AbortController(); active = controller;
    const current = () => active === controller && !controller.signal.aborted;
    return { signal: controller.signal, current, assertCurrent: () => {
      if (!current()) throw new DOMException('画面の操作を中止しました', 'AbortError');
    } };
  };
  return { start, cancel };
}
export type ViewRequest = ReturnType<ReturnType<typeof createRequestScope>['start']>;
