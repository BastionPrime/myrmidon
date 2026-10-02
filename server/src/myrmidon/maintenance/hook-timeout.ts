
export async function withHookTimeout<T>(
  hook: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => void = () => {},
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      hook(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          timer = undefined;
          onTimeout();
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
