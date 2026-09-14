/** Collection has an independent lock: old, slow outcome requests must not block the capture deadline.
 * All network calls still use the same low-priority gateway and global budget. */
export function createResearchSchedule(options: {
  collect: () => Promise<unknown>;
  pending: () => boolean;
  backgroundJobs: Array<() => Promise<unknown>>;
  onError: (error: unknown) => void;
}) {
  let collecting = false, measuring = false;
  return {
    async collectOnce() {
      if (collecting) return;
      collecting = true;
      try { await options.collect(); }
      catch (error) { options.onError(error); }
      finally { collecting = false; }
    },
    async measureOnce() {
      if (measuring) return;
      measuring = true;
      try {
        for (const job of options.backgroundJobs) {
          if (options.pending()) break;
          try { await job(); } catch (error) { options.onError(error); }
        }
      } finally { measuring = false; }
    },
  };
}
