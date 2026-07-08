import { LoginPage } from "@/components/login-page";
import { PlaudeConsole } from "@/components/plaude-console";
import { ensureAutomationScheduler } from "@/lib/automation";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  ensureAutomationScheduler();
  const user = await getSessionUser();
  return user ? <PlaudeConsole sessionUser={user} /> : <LoginPage />;
}
