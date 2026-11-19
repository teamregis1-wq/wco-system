/**
 * Print a prepared, print-only layout without disturbing what is on screen.
 *
 * The caller mounts an off-screen copy (e.g. a map sized to A4) and resolves
 * `ready` once it has rendered (map tiles loaded). Printing starts as soon as
 * that happens — or after `timeoutMs` if the network is slow — and `cleanup`
 * runs when the print dialog closes.
 */
export async function printWhenReady(
  ready: Promise<unknown>,
  cleanup: () => void,
  { pageCss = "", bodyClass = "", timeoutMs = 8000 }: { pageCss?: string; bodyClass?: string; timeoutMs?: number } = {},
): Promise<void> {
  const style = document.createElement("style");
  style.textContent = pageCss;
  document.head.appendChild(style);
  if (bodyClass) document.body.classList.add(bodyClass);

  await Promise.race([ready, new Promise(r => setTimeout(r, timeoutMs))]);
  // Two frames: let the browser paint the last tiles and markers before printing.
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    window.removeEventListener("afterprint", finish);
    style.remove();
    if (bodyClass) document.body.classList.remove(bodyClass);
    cleanup();
  };
  window.addEventListener("afterprint", finish);
  window.print();
  // Safety net for browsers that never fire "afterprint". The print copy is
  // off-screen, so leaving it mounted a little longer is invisible.
  setTimeout(finish, 60_000);
}

/** A deferred promise: `promise` resolves when `resolve()` is called. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
