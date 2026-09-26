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
 * Opens the app's own dialog in place of `Alert.alert`. Queues behind
 * whatever is already showing rather than replacing it — unlike a
 * message, a dialog is often standing in for a decision the person is
 * mid-tap on, so swapping it under them risks the wrong button meaning
 * something else by the time they land on it.
 */
export function showAlert(title: string, message: string | undefined, buttons: AlertButton[]): void {
  listener?.({ title, message, buttons });
}

/** Called by the host as it mounts, and with null as it unmounts. */
export function setAlertListener(next: Listener | null): void {
  listener = next;
}
