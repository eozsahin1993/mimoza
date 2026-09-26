import type { DialogButton } from '@/ui/components/dialog';

/**
 * A themed stand-in for `Alert.alert`, which can't be — see `Dialog`. Same
 * shape as RN's own, so a call site reads like a straight swap.
 *
 * Plain functions rather than a hook, for the same reason as
 * `core/services/messages.ts`: the code with something to ask is often a
 * service with no component to ask it from (see `push-notifications`'s
 * `tap.ts`), and `DialogButton` is a type-only import, erased before Metro
 * sees it — nothing under `components/` runs in this layer.
 */
export type AlertButton = DialogButton;

export type AlertRequest = {
  title: string;
  message?: string;
  buttons: AlertButton[];
};

type Listener = (request: AlertRequest) => void;

/** Exactly one host is mounted. */
let listener: Listener | null = null;

/**
 * Held until a listener registers, unlike `messages.ts` (which drops one
 * shown to nobody). A push tap can reach `showAlert` — see
 * `push-notifications`'s `tap.ts` — before `AppShell` has mounted:
 * `RootLayout` starts push-tap routing in its first effect, ahead of the
 * font/database/settings gate `AppShell` itself waits on. Losing a toast
 * silently is fine; losing the one explanation for why the screen someone
 * expected didn't show up is not.
 */
const pending: AlertRequest[] = [];

/**
 * Opens the app's own dialog in place of `Alert.alert`. Queues behind
 * whatever is already showing rather than replacing it — unlike a
 * message, a dialog is often standing in for a decision the person is
 * mid-tap on, so swapping it under them risks the wrong button meaning
 * something else by the time they land on it.
 */
export function showAlert(title: string, message: string | undefined, buttons: AlertButton[]): void {
  const request: AlertRequest = { title, message, buttons };
  if (listener) {
    listener(request);
  } else {
    pending.push(request);
  }
}

/** Called by the host as it mounts, and with null as it unmounts. Flushes, in order, whatever queued up before this mount. */
export function setAlertListener(next: Listener | null): void {
  listener = next;
  if (!next) return;
  for (const request of pending.splice(0)) {
    next(request);
  }
}
