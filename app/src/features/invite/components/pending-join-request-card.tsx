import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/ui/components/avatar/avatar';
import { Icon } from '@/ui/components/icon';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Icons, Radius, Space } from '@/ui/theme/tokens';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';
import type { JoinRequest } from '@/features/invite/services/invite-relay';

export type PendingJoinRequestCardProps = {
  request: JoinRequest;
  /** Disables both actions while this specific request (or another one in the same list) is being acted on. */
  busy: boolean;
  onApprove: () => void;
  onDeny: () => void;
};

/**
 * One pending join request, with its own approve/deny actions, rendered
 * as a feed row (see `feed/pending-request-row.tsx`). Shown to every
 * admin, not just whoever shared the invite the requester used — the
 * relay pages every admin about a new request (see requests/service.go's
 * Create), so any of them can act on it.
 */
export function PendingJoinRequestCard({ request, busy, onApprove, onDeny }: PendingJoinRequestCardProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const tints = useTints();
  return (
    <ThemedView type="surface" style={[styles.card, { borderColor: tints.chipIdleBorder }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('invite.request.notNow')}
        disabled={busy}
        hitSlop={12}
        style={busy && styles.dimmed}
        onPress={onDeny}>
        <Icon icon={Icons.close} size={20} color={theme.secondary} />
      </Pressable>
      <Avatar size={44} name={request.name ?? ''} colorSeed={request.accountId} />
      <View style={styles.text}>
        <ThemedText type="titleSmall" numberOfLines={1}>
          {request.name || t('invite.request.someone')}
        </ThemedText>
        <ThemedText type="labelSmall" themeColor="muted" numberOfLines={1}>
          {t('invite.request.wantsToJoin')}
        </ThemedText>
      </View>
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        hitSlop={10}
        style={[styles.approve, busy && styles.dimmed]}
        onPress={onApprove}>
        <ThemedText type="labelMedium" themeColor="accentBright" numberOfLines={1}>
          {t('invite.request.letIn')}
        </ThemedText>
      </Pressable>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.panel,
    borderWidth: 1,
    padding: Space.s300,
    gap: Space.s300,
  },
  text: {
    flex: 1,
    gap: Space.s100,
  },
  // No button chrome, but still comfortably over the 44pt tap target
  // once padding and hitSlop are added on top of the label's own bounds.
  approve: {
    justifyContent: 'center',
    paddingVertical: Space.s200,
    paddingHorizontal: Space.s200,
  },
  dimmed: {
    opacity: 0.4,
  },
});
