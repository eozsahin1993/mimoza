import { useCallback, useEffect, useRef, useState } from 'react';

import { setAlertListener, type AlertRequest } from '@/core/services/alerts';

export type AlertController = {
  /** What to draw, still set while it leaves so there's something to animate. */
  request: AlertRequest | null;
  /** Whether it should be on screen. False while it's on its way out. */
  visible: boolean;
  /** Always fires on close — the host wires this to every button and to the backdrop alike. */
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

  const dismiss = useCallback(() => setVisible(false), []);

  useEffect(() => {
    setAlertListener((next) => {
      setVisible((showing) => {
        if (showing) {
          queue.current.push(next);
          return true;
        }
        setRequest(next);
        return true;
      });
    });
    return () => setAlertListener(null);
  }, []);

  const settle = useCallback(() => {
    const next = queue.current.shift() ?? null;
    setRequest(next);
    setVisible(next !== null);
  }, []);

  return { request, visible, dismiss, settle };
}
