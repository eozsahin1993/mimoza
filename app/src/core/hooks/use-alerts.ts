import { useCallback, useEffect, useRef, useState } from 'react';

import { setAlertListener, type AlertRequest } from '@/core/services/alerts';

export type AlertController = {
  /** What to draw, still set while it leaves so there's something to animate. */
  request: AlertRequest | null;
  /** Whether it should be on screen. False while it's on its way out. */
  visible: boolean;
  /** Closes it early. `Dialog` never calls this on its own — a caller that wants any button press to also close wraps it into that button's own action (see `_layout.tsx`). */
  dismiss: () => void;
  /** Called once it has finished leaving, which is when the next one queued can take the slot. */
  settle: () => void;
};

/**
 * Which alert is on screen and what comes after it — everything about
 * showing one except how it looks, which is `Dialog`'s alone. See
 * `useMessages`, which this mirrors: queued rather than replaced, because
 * a dialog is a question, and dropping one changes the answer someone
 * thinks they're about to give.
 */
export function useAlerts(): AlertController {
  const [request, setRequest] = useState<AlertRequest | null>(null);
  const [visible, setVisible] = useState(false);
  const queue = useRef<AlertRequest[]>([]);
  /**
   * Mirrors `request`, but readable synchronously from the listener below,
   * which subscribes once and so can't close over fresh state. Stays set
   * for the whole time a request is showing *or* fading out — unlike
   * `visible`, which flips false the moment `dismiss` runs, before
   * `Dialog`'s close animation finishes — so a `showAlert` mid-fade queues
   * behind it instead of overwriting what's still on screen. Also keeps
   * this listener a plain callback rather than a `setState` updater: React
   * can invoke an updater twice in Strict Mode, which would otherwise
   * double-queue.
   */
  const current = useRef<AlertRequest | null>(null);

  const dismiss = useCallback(() => setVisible(false), []);

  useEffect(() => {
    setAlertListener((next) => {
      if (current.current) {
        queue.current.push(next);
        return;
      }
      current.current = next;
      setRequest(next);
      setVisible(true);
    });
    return () => setAlertListener(null);
  }, []);

  const settle = useCallback(() => {
    const next = queue.current.shift() ?? null;
    current.current = next;
    setRequest(next);
    setVisible(next !== null);
  }, []);

  return { request, visible, dismiss, settle };
}
