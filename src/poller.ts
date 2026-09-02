/**
 * The one background tick loop: run the tick immediately, then every
 * intervalMs; never overlap a tick that is still in flight; log failures
 * visibly instead of leaking unhandled rejections; never keep the process
 * alive on its own. Returns a stop function.
 */
export function startPoller(name: string, intervalMs: number, tick: () => Promise<void>): () => void {
  let ticking = false;
  const run = () => {
    if (ticking) return;
    ticking = true;
    void tick()
      .catch((error) => {
        console.error(`${name} tick failed:`, error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        ticking = false;
      });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
