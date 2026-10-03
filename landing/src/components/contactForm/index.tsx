import { useState, type FormEvent } from "react";
import "./style.css";

type Status = "idle" | "loading" | "done" | "error";

/**
 * Posts to /api/contact (a Cloudflare Pages Function — see
 * landing/functions/api/contact.ts) rather than a mailto: link, so the
 * message arrives as a real support request with a Reply-To the owner
 * can answer directly, not whatever's left to a visitor's own mail app.
 */
export function ContactForm() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (status === "loading" || status === "done") return;
    setStatus("loading");
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, message }),
      });
      if (!response.ok) throw new Error("request failed");
      setStatus("done");
    } catch {
      setStatus("error");
    }
  }

  if (status === "done") {
    return <p className="contact-done">Sent. We'll reply to {email}.</p>;
  }

  return (
    <div className="contact">
      <form className="contact-form" onSubmit={onSubmit}>
        <input
          type="email"
          required
          placeholder="you@email.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={status === "loading"}
          aria-label="Your email address"
        />
        <textarea
          required
          placeholder="How can we help?"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          disabled={status === "loading"}
          aria-label="Your message"
          rows={5}
        />
        <button type="submit" disabled={status === "loading"}>
          {status === "loading" ? "Sending…" : "Send"}
        </button>
      </form>
      {status === "error" && <p className="contact-error">Something went wrong. Try again in a moment.</p>}
    </div>
  );
}
