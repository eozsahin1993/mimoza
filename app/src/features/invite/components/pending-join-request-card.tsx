import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { Avatar } from '@/ui/components/avatar/avatar';
import { PrimaryButton } from '@/ui/components/buttons/primary-button';
import { SecondaryButton } from '@/ui/components/buttons/secondary-button';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Radius, Space } from '@/ui/theme/tokens';
import { useTints } from '@/ui/theme/hooks/use-theme';
import type { PendingRequest } from '@/features/invite/usecases/invite-to-circle';
import { formatAgo } from '@/core/utils/time';
import { useLanguage } from '@/core/i18n/use-language';

export type PendingJoinRequestCardProps = {
  request: PendingRequest;
  /** Disables both buttons while this specific request (or another one in the same list) is being acted on. */
  busy: boolean;
  onApprove: () => void;
  onDeny: () => void;
};

/**
 * One pending join request, with its own approve/deny actions, rendered
 * as a feed row (see `feed/pending-request-row.tsx`). Only ever rendered
 * for the invite's actual creator (see that function's creator-only
 * gate) — "Tapped your link" is never anyone else's: approval is always
 * the invite's specific creator, never any admin, since an admin who
 * didn't create this invite has no real context to judge the request
 * against — just an unverified, self-reported name, no stronger a signal
 * than the creator already has.
 */
export function PendingJoinRequestCard({ request, busy, onApprove, onDeny }: PendingJoinRequestCardProps) {
  const { t } = useTranslation();
  const tints = useTints();
  const language = useLanguage();
  return (
    <ThemedView type="surface" style={[styles.card, { borderColor: tints.chipIdleBorder }]}>
      <View style={styles.header}>
        <Avatar size={44} uri={request.pictureUri} name={request.selfReportedName} colorSeed={request.identityPublicKey} />
        <View style={styles.text}>
          <ThemedText type="titleMedium">{request.selfReportedName || t('invite.request.someone')}</ThemedText>
          <ThemedText type="labelSmall" themeColor="muted">
            {t('invite.request.tappedLink', { ago: formatAgo(request.createdAt, language) })}
          </ThemedText>
        </View>
      </View>
      <View style={styles.actions}>
        <SecondaryButton label={t('invite.request.notNow')} disabled={busy} onPress={onDeny} style={styles.actionButton} />
        <PrimaryButton label={t('invite.request.letIn')} disabled={busy} onPress={onApprove} style={styles.actionButton} />
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.panel,
    borderWidth: 1,
    padding: Space.s400,
    gap: Space.s400,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s300,
  },
  text: {
    flex: 1,
    gap: Space.s100,
  },
  actions: {
    flexDirection: 'row',
    gap: Space.s300,
  },
  actionButton: {
    flex: 1,
  },
});
