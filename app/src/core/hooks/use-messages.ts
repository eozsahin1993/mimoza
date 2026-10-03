import { useCallback, useEffect, useRef, useState } from 'react';

import { setMessageListener, type Message } from '@/core/services/messages';

/** How long each tone stands. An error stands longest, as the one worth reading twice. */
const HOLD_MS: Record<Message['tone'], number> = { done: 3000, neutral: 4000, error: 6000 };

/** Longer than any tone's own time, so there's room to reach the way out. */
const WITH_ACTION_MS = 8000;

export type MessageController = {
  /** What to draw, still set while it leaves so there's something to animate. */
  message: Message | null;
  /** Whether it should be on screen. False while it's on its way out. */
  visible: boolean;
  /** Take it away early — the swipe, or an action that has been taken. */
  dismiss: () => void;
  /** Called once it has finished leaving, which is when the next one can take the slot. */
  settle: () => void;
};

/**
 * Which message is on screen and for how long — everything about
 * messaging except how it looks, which is `Snackbar`'s alone.
 *
 * Here rather than in the component because a message outlives any one
 * screen, and because the timing rules are the interesting part: a
 * component that also owned them would be hard to change without
 * touching layout, and hard to reason about without rendering.
 */
export function useMessages(): MessageController {
  const [message, setMessage] = useState<Message | null>(null);
  const [visible, setVisible] = useState(false);
  /**
   * One behind the one on screen, and no more. A burst means something is
   * wrong at a scale a queue can't narrate, so the rest are dropped
   * rather than played out to someone who has stopped reading.
   */
  const queued = useRef<Message | null>(null);

  const dismiss = useCallback(() => setVisible(false), []);

  useEffect(() => {
    setMessageListener((next) => {
      // Replace rather than stack: whatever is on screen starts leaving,
      // and this takes the slot once it's gone.
      setVisible((showing) => {
        if (showing) {
          queued.current ??= next;
          return false;
        }
        setMessage(next);
        return true;
      });
    });
    return () => setMessageListener(null);
  }, []);

  const settle = useCallback(() => {
    const next = queued.current;
    queued.current = null;
    setMessage(next);
    setVisible(next !== null);
  }, []);

  useEffect(() => {
    if (!message || !visible) return;
    const holdMs = message.action ? WITH_ACTION_MS : HOLD_MS[message.tone];

    const timer = setTimeout(dismiss, holdMs);
    return () => clearTimeout(timer);
  }, [message, visible, dismiss]);

  return { message, visible, dismiss, settle };
}
