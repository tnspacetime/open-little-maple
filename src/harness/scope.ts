/** One reversible lifetime for installed services and related resources. */
import type { Cleanup } from "./json.js";

export class Scope {
  private cleanups: Cleanup[] = [];
  private state: "open" | "closing" | "closed" = "open";
  private closeTask: Promise<void> | undefined;

  defer(cleanup: Cleanup): void {
    if (this.state !== "open") throw new Error("Scope is not open");
    this.cleanups.push(cleanup);
  }

  child(): Scope {
    const child = new Scope();
    this.defer(() => child.close());
    return child;
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.state = "closing";
    this.closeTask = (async () => {
      const failures: unknown[] = [];
      for (const cleanup of [...this.cleanups].reverse()) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
      this.cleanups = [];
      this.state = "closed";
      if (failures.length > 0) {
        throw new AggregateError(failures, "Scope cleanup failed");
      }
    })();
    return this.closeTask;
  }
}
