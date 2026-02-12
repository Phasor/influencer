import { createWorkerRuntime } from "./index";

async function main(): Promise<void> {
  const runtime = createWorkerRuntime();
  const controller = new AbortController();

  const stop = () => {
    controller.abort();
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await runtime.runUntilStopped(controller.signal);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(message);
  process.exitCode = 1;
});
