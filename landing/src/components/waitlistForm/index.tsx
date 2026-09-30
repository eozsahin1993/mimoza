import { useState, type FormEvent } from "react";
import "./style.css";

type Status = "idle" | "loading" | "done" | "error";

/**
 * Posts to /api/subscribe (a Cloudflare Pages Function — see
 * landing/functions/api/subscribe.ts) rather than calling Resend
 * directly: Resend's API needs a secret key, which can't sit in code
 * that ships to the browser.
 */
export function WaitlistForm({ centered = false }: { centered?: boolean }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (status === "loading" || status === "done") return;
    setStatus("loading");
    try {
      const response = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!response.ok) throw new Error("request failed");
      setStatus("done");
    } catch {
      setStatus("error");
    }
  }

  if (status === "done") {
    return <p className={centered ? "waitlist-done centered" : "waitlist-done"}>You're on the list—we'll email you the day we launch.</p>;
  }

  return (
    <div className={centered ? "waitlist centered" : "waitlist"}>
      <form className="waitlist-form" onSubmit={onSubmit}>
        <input
          type="email"
          required
          placeholder="you@email.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={status === "loading"}
          aria-label="Email address"
        />
        <button type="submit" disabled={status === "loading"}>
          {status === "loading" ? "Joining…" : "Notify me at launch"}
        </button>
      </form>
      {status === "error" && <p className="waitlist-error">Something went wrong—try again in a moment.</p>}
      <p className="waitlist-note">Not live yet. One email when it is, nothing else. Unsubscribe anytime.</p>
    </div>
  );
}
