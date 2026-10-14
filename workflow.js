/** Small package-owned workflows; the host only supplies generic document APIs. */
export function searchText(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
}

/** A retry completes the same creation/copy instead of creating duplicates. */
export function createItemWorkflow({create, append, flush}) {
  const requestId = globalThis.crypto.randomUUID();
  let item, snapshot, added = false, pending;
  function run(input) {
    if (pending) return pending;
    snapshot ??= structuredClone(input);
    pending = (async () => {
      item ??= await create(structuredClone(snapshot), {requestId});
      if (!added) {await append(item); added = true;}
      await flush();
      return item;
    })().finally(() => {pending = undefined;});
    return pending;
  }
  return {run, get started() {return !!snapshot;}, get created() {return !!item;}};
}

/** One Add/Retry operation; a later intentional copy uses a new workflow. */
export function createCopyWorkflow({read, append, flush, signal}) {
  let item, added = false, pending, failed = false;
  const check = () => {
    if (signal?.aborted) throw Object.assign(new Error('The document context was cancelled.'), {code: 'cancelled'});
  };
  function run() {
    if (pending) return pending;
    pending = (async () => {
      check(); item ??= await read(); check();
      if (!added) {await append(structuredClone(item)); added = true;}
      check(); await flush(); failed = false; return item;
    })().catch(error => {failed = true; throw error;}).finally(() => {pending = undefined;});
    return pending;
  }
  return {run, get pending() {return !!pending;}, get failed() {return failed;}, get added() {return added;}};
}
