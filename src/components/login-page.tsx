"use client";

import { AlertCircle, Loader2, LockKeyhole, LogIn, RadioTower, Waves } from "lucide-react";
import { type FormEvent, useState } from "react";

function loginErrorMessage(payload: unknown, fallback: string): string {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }
  return fallback;
}

export function LoginPage() {
  const [username, setUsername] = useState("dpp0548");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(loginErrorMessage(payload, "Login failed."));
      }
      window.location.replace("/");
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Login failed.");
      setBusy(false);
    }
  };

  return (
    <main className="login-shell">
      <section className="login-panel" aria-label="Plaude STT login">
        <div className="login-signal" aria-hidden="true">
          <div className="login-signal-head">
            <div className="brand-mark compact">
              <Waves size={22} strokeWidth={2.2} />
            </div>
            <div>
              <p className="eyebrow">Plaude STT</p>
              <h1>Recorder dock access</h1>
            </div>
          </div>
          <div className="login-waveform">
            {Array.from({ length: 42 }, (_, index) => (
              <span key={index} style={{ height: `${18 + ((index * 23) % 76)}%` }} />
            ))}
          </div>
          <div className="login-lockline">
            <RadioTower size={18} />
            <span>Local console</span>
          </div>
        </div>

        <form className="login-form" onSubmit={submit}>
          <div className="login-form-heading">
            <div className="login-form-icon" aria-hidden="true">
              <LockKeyhole size={20} />
            </div>
            <div>
              <p className="panel-label">Private workspace</p>
              <h2>Sign in to continue</h2>
            </div>
          </div>

          <label className="login-field">
            <span>ID</span>
            <input
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={busy}
            />
          </label>

          <label className="login-field">
            <span>Password</span>
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              autoFocus
            />
          </label>

          {error && (
            <div className="login-error" role="alert">
              <AlertCircle size={17} />
              <span>{error}</span>
            </div>
          )}

          <button className="primary-button login-submit" type="submit" disabled={busy}>
            {busy ? <Loader2 className="spin" size={18} /> : <LogIn size={18} />}
            <span>Sign in</span>
          </button>
        </form>
      </section>
    </main>
  );
}
