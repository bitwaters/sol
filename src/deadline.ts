export class DeadlineError extends Error {
  constructor() { super('request_deadline_exceeded'); this.name = 'DeadlineError'; }
}

/** A deadline must settle the caller even if the transport ignores cancellation. */
export async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new DeadlineError();
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try { return await Promise.race([expired, Promise.resolve().then(() => operation(controller.signal))]); }
  finally { if (timer) clearTimeout(timer); }
}
