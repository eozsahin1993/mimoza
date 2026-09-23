import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { Avatar } from '@/ui/components/avatar/avatar';
import { BottomSheet } from '@/ui/components/bottom-sheet';
import { PrimaryButton } from '@/ui/components/buttons/primary-button';
import { ThemedText } from '@/ui/theme/themed-text';
import { Space, Spacing } from '@/ui/theme/tokens';
import { findPendingJoinRequestForInvite, previewInvite, requestToJoin } from '@/features/invite/usecases/join-circle';
import { showError } from '@/core/services/messages';

/**
 * The whole join flow, in one sheet over the circle list.
 *
 * One sheet, not two: asking and waiting are states of the same thing, and
 * a second sheet over the first would stack modals — which iOS handles
 * badly and which reads as leaving rather than progressing. For the same
 * reason this is a component the list renders, not a route: a route would
 * need a screen underneath it, and nothing about opening an invite should
 * replace what you were looking at.
 */
type Phase = 'checking' | 'error' | 'asking' | 'submitting' | 'waiting';

export type JoinSheetProps = {
  /** The invite code to preview, or null when nothing is being joined. */
  code: string | null;
  onClose: () => void;
  /** Called once a request has actually been made, so the list can show its pending row. */
  onRequested: () => void;
};

export function JoinSheet({ code, onClose, onRequested }: JoinSheetProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('checking');
  const [circleName, setCircleName] = useState('');
  const [inviterName, setInviterName] = useState('');

  useEffect(() => {
    if (!code) return;
    let stale = false;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase('checking');
    (async () => {
      try {
        const preview = await previewInvite(code);
        const already = await findPendingJoinRequestForInvite(code);
        if (stale) return;

        setCircleName(preview.name);
        // A name and nothing else. Someone outside the circle has no
        // key, so there is no picture to show them — Avatar falls back
        // to initials.
        setInviterName(preview.invitedBy);
        setPhase(already ? 'waiting' : 'asking');
      } catch (err) {
        console.error('Failed to load invite preview', err);
        if (stale) return;
        setPhase('error');
      }
    })();

    return () => {
      stale = true;
    };
  }, [code]);

  async function handleRequestToJoin() {
    if (!code) return;
    setPhase('submitting');
    try {
      await requestToJoin(code, { circleName, invitedByName: inviterName });
      setPhase('waiting');
      onRequested();
    } catch (err) {
      console.error('Failed to request to join', err);
      // Back to 'asking', not 'error': the invite is fine, the send wasn't.
      // The error state takes the button away, which would make a dropped
      // connection look like a dead key.
      setPhase('asking');
      showError(t('invite.join.sendFailed'), { action: { label: t('invite.join.retry'), onPress: handleRequestToJoin } });
    }
  }

  return (
    <BottomSheet visible={code !== null && phase !== 'checking'} onClose={onClose}>
      <View style={styles.content}>
        {phase === 'error' ? (
          <>
            <ThemedText type="titleLarge">{t('invite.join.cantOpen')}</ThemedText>
            <ThemedText type="labelSmall" themeColor="muted">
              {t('invite.join.expired')}
            </ThemedText>
            <PrimaryButton label={t('invite.join.close')} onPress={onClose} style={styles.button} />
          </>
        ) : (
          <>
            {/* Avatar and text on one line, so the sheet stays card-height
                rather than screen-height. The circle's name carries the
                weight; who sent the key is context, not the headline. */}
            <View style={styles.header}>
              <Avatar size={48} name={inviterName} />
              <View style={styles.headerText}>
                <ThemedText type="labelSmall" themeColor="muted" numberOfLines={1}>
                  {inviterName ? t('invite.join.invitedBy', { name: inviterName }) : t('invite.join.invited')}
                </ThemedText>
                <ThemedText type="titleLarge" numberOfLines={2}>
                  {circleName}
                </ThemedText>
              </View>
            </View>

            <ThemedText type="labelSmall" themeColor="muted">
              {phase === 'waiting'
                ? inviterName
                  ? t('invite.join.waitingOn', { name: inviterName })
                  : t('invite.join.waitingOnUnknown')
                : inviterName
                  ? t('invite.join.needsApproval', { name: inviterName })
                  : t('invite.join.needsApprovalUnknown')}
            </ThemedText>

            <PrimaryButton
              label={
                phase === 'waiting'
                  ? t('invite.done')
                  : phase === 'submitting'
                    ? t('invite.join.sending')
                    : t('invite.join.request')
              }
              disabled={phase === 'submitting'}
              onPress={phase === 'waiting' ? onClose : handleRequestToJoin}
              style={styles.button}
            />
          </>
        )}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Space.s100,
    gap: Space.s400,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s400,
  },
  headerText: {
    flex: 1,
    gap: Space.s100,
  },
  button: {
    marginTop: Space.s100,
  },
});
