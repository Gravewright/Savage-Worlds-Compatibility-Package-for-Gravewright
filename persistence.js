/** Serialize optimistic saves and keep edits made during an in-flight request. */
export function createSaveQueue({read, write, onState = () => {}, onError = () => {}, signal, delay = 350}) {
  let revision = 0, saved = 0, pending, timer, blocked, attempt;
  const state = value => { if (!signal?.aborted) onState(value); };
  async function drain() {
    if (blocked) throw blocked;
    if (saved === revision) return;
    state('saving');
    try {
      while (saved !== revision && !signal?.aborted) {
        attempt ??= {revision,snapshot:structuredClone(read()),requestId:globalThis.crypto.randomUUID()};
        await write(structuredClone(attempt.snapshot),{requestId:attempt.requestId});
        saved = attempt.revision;attempt=undefined;
      }
      state('saved');
    } catch (error) {
      if (error.code === 'conflict') blocked = error;
      state('error'); onError(error); throw error;
    }
  }
  function flush() {
    clearTimeout(timer);
    if (!pending) pending = drain().finally(() => { pending = undefined; });
    return pending;
  }
  function mark() {
    if (signal?.aborted) return;
    revision++; state('waiting'); clearTimeout(timer);
    if (!blocked) timer = setTimeout(() => { void flush().catch(() => {}); }, delay);
  }
  function reset() { clearTimeout(timer); revision = saved = 0; blocked = attempt = undefined; state('saved'); }
  function dispose() { clearTimeout(timer); }
  signal?.addEventListener('abort', dispose, {once: true});
  return {mark, flush, reset, dispose, get dirty() {return saved !== revision;}, get pending() {return !!pending;}, get conflicted() {return !!blocked;}};
}
