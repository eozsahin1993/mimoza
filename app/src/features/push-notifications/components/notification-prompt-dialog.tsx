import { useTranslation } from 'react-i18next';

import { Dialog } from '@/ui/components/dialog';

export type NotificationPromptDialogProps = {
  visible: boolean;
  /** A request this device is waiting on, if any — the reason gets specific. */
  waitingOn?: { circleName: string; invitedByName: string };
  onTurnOn: () => void;
  onNotNow: () => void;
};

/**
 * Our own ask, in front of the system one. iOS shows its prompt once and a
 * refusal sticks until the person finds it in Settings, so the system
 * prompt only appears after a yes here; "Not now" leaves it unspent. A
 * dialog, to match the system alert it leads into.
 */
export function NotificationPromptDialog({ visible, waitingOn, onTurnOn, onNotNow }: NotificationPromptDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog
      visible={visible}
      title={t('notifications.prompt.title')}
      message={
        waitingOn?.invitedByName
          ? t('notifications.prompt.bodyWaiting', { name: waitingOn.invitedByName, circle: waitingOn.circleName })
          : t('notifications.prompt.body')
      }
      confirmLabel={t('notifications.prompt.turnOn')}
      cancelLabel={t('notifications.prompt.notNow')}
      onConfirm={onTurnOn}
      onCancel={onNotNow}
    />
  );
}
