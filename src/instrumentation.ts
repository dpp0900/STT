export async function register() {
  if (process.env.NEXT_RUNTIME !== "edge") {
    const { ensureCleanupJobRuntime } = await import("@/lib/stt/cleanup-jobs");
    const { ensureAutomationScheduler } = await import("@/lib/automation");
    await ensureCleanupJobRuntime();
    ensureAutomationScheduler();
  }
}
