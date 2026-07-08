export async function register() {
  if (process.env.NEXT_RUNTIME !== "edge") {
    const { ensureAutomationScheduler } = await import("@/lib/automation");
    ensureAutomationScheduler();
  }
}
