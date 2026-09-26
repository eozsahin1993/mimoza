import { useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { showAlert } from '@/core/services/alerts';
import { BottomSheet } from '@/ui/components/bottom-sheet';
import { LoadingModal } from '@/ui/components/loading-modal';
import { PrimaryButton } from '@/ui/components/buttons/primary-button';
import { SecondaryButton } from '@/ui/components/buttons/secondary-button';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Colors, Radius, Space, Spacing } from '@/ui/theme/tokens';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';
import { mintAndSaveAccountKeypair, publishAccountKeypairOrDegrade } from '@/features/account/usecases/account-keypair-flow';
import { collectDeviceLink, startDeviceLink } from '@/features/account/usecases/device-link';
import { finishSignIn } from '@/features/account/usecases/finish-sign-in';

const QR_SIZE = 200;
const RADIO_SIZE = 24;

type Method = 'otherDevice' | 'noDevice';

/**
 * What the sheet is doing. The code is only minted once the sheet opens:
 * a session costs a relay row and a five-minute window, and the reader
 * who picks the other method should never open one.
 */
type LinkState = { kind: 'idle' } | { kind: 'opening' } | { kind: 'showing'; payload: string };

function Radio({ selected }: { selected: boolean }) {
  const theme = useTheme();
  const tints = useTints();
  return (
    <View style={[styles.radio, { borderColor: selected ? theme.accent : tints.secondaryButtonBorder }]}>
      {selected ? <View style={[styles.radioDot, { backgroundColor: theme.accent }]} /> : null}
    </View>
  );
}

function MethodCard({
  selected,
  label,
  note,
  onPress,
}: {
  selected: boolean;
  label: string;
  note: string;
  onPress: () => void;
}) {
  const tints = useTints();
  return (
    <Pressable onPress={onPress}>
      <ThemedView
        type="surface"
        style={[styles.card, { borderColor: selected ? tints.raisedAccentBorder : tints.raisedBorder }]}>
        <Radio selected={selected} />
        <View style={styles.cardText}>
          <ThemedText type="titleMedium">{label}</ThemedText>
          <ThemedText type="bodySmall" style={styles.cardNote}>
            {note}
          </ThemedText>
        </View>
      </ThemedView>
    </Pressable>
  );
}

/**
 * Where sign-in lands when this device has no usable account keypair. It
 * is a gate, not a detour: no back button, and the only ways on are the
 * two methods below, either of which finishes the sign-in itself.
 */
export default function DeviceLinkScreen() {
  const { t } = useTranslation();
  const tints = useTints();
  const { accountId, name } = useLocalSearchParams<{ accountId?: string; name?: string }>();
  const [method, setMethod] = useState<Method>('otherDevice');
  const [link, setLink] = useState<LinkState>({ kind: 'idle' });
  const [creatingKey, setCreatingKey] = useState(false);
  // Read by the poll between attempts, so closing the sheet stops it
  // rather than leaving it asking behind a screen nobody is looking at.
  const closedRef = useRef(false);

  /**
   * Opens a session, shows its code, and waits for the other device.
   * Both halves live in one call because the session and the throwaway
   * keypair it was opened against are only useful together, and the
   * private half is deliberately never stored.
   */
  async function showCode() {
    if (!accountId) return;
    closedRef.current = false;
    setLink({ kind: 'opening' });
    try {
      const started = await startDeviceLink();
      setLink({ kind: 'showing', payload: started.payload });
      await collectDeviceLink(accountId, started, () => closedRef.current);
      await finishSignIn({ accountId, name: name ?? '' });
    } catch (err) {
      // Closing the sheet cancels the poll by design, so the error it
      // raises on the way out is not a failure to report.
      if (closedRef.current) return;
      console.error('Device link failed', err);
      setLink({ kind: 'idle' });
      showAlert(t('account.keyRecovery.failed'), t('account.transfer.somethingWrong'), [{ text: t('common.ok') }]);
    }
  }

  function closeSheet() {
    closedRef.current = true;
    setLink({ kind: 'idle' });
  }

  /**
   * The opt-out: nothing to hand the keys over, so this device mints its
   * own. Every circle then waits on a member to reseal before its photos
   * are readable again, which is what publishing as a reset asks for.
   */
  async function createNewKeys() {
    if (!accountId) return;
    setCreatingKey(true);
    try {
      await publishAccountKeypairOrDegrade(accountId, await mintAndSaveAccountKeypair(accountId), true);
      await finishSignIn({ accountId, name: name ?? '' });
    } catch (err) {
      console.error('Failed to create new keys for this device', err);
      showAlert(t('account.keyRecovery.failed'), t('account.transfer.somethingWrong'), [{ text: t('common.ok') }]);
    } finally {
      setCreatingKey(false);
    }
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <ThemedText type="code" themeColor="muted" style={styles.eyebrow}>
            {t('account.keyRecovery.header')}
          </ThemedText>
          <ThemedText type="headlineLarge">{t('account.keyRecovery.title')}</ThemedText>
          <ThemedText type="bodyMedium" themeColor="secondary" style={styles.body}>
            {t('account.keyRecovery.body')}
          </ThemedText>

          <View style={styles.methods}>
            <MethodCard
              selected={method === 'otherDevice'}
              label={t('account.keyRecovery.scan')}
              note={t('account.keyRecovery.scanNote')}
              onPress={() => setMethod('otherDevice')}
            />
            <MethodCard
              selected={method === 'noDevice'}
              label={t('account.keyRecovery.noDevice')}
              note={t('account.keyRecovery.noDeviceNote')}
              onPress={() => setMethod('noDevice')}
            />
          </View>
        </ScrollView>

        <PrimaryButton
          label={t('account.keyRecovery.continue')}
          disabled={creatingKey}
          onPress={method === 'otherDevice' ? showCode : createNewKeys}
          style={styles.continue}
        />
      </ThemedSafeAreaView>

      <BottomSheet visible={link.kind !== 'idle'} onClose={closeSheet}>
        <View style={styles.sheet}>
          <ThemedText type="titleLarge" style={styles.sheetTitle}>
            {t('account.transfer.waiting')}
          </ThemedText>

          {/* Dark-on-light whatever the scheme: plenty of scanners still
              refuse an inverted QR, and this has to work on whichever
              phone is held up to it. */}
          <View style={[styles.qrFrame, { borderColor: tints.secondaryButtonBorder }]}>
            <View style={styles.qrPlate}>
              {link.kind === 'showing' ? (
                <QRCode
                  value={link.payload}
                  size={QR_SIZE}
                  color={Colors.dark.background}
                  backgroundColor={Colors.dark.accentBright}
                />
              ) : (
                <View style={styles.qrPending}>
                  <ActivityIndicator color={Colors.dark.background} />
                </View>
              )}
            </View>
          </View>

          <SecondaryButton label={t('common.cancel')} onPress={closeSheet} style={styles.sheetClose} />
        </View>
      </BottomSheet>

      <LoadingModal visible={creatingKey} label={t('account.keyRecovery.creating')} />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    paddingHorizontal: Spacing.screenPadding,
  },
  content: {
    flexGrow: 1,
    paddingTop: Space.s600,
    paddingBottom: Spacing.cardListGap,
  },
  // The `code` type is sized for an invite code standing on its own; as a
  // kicker over a headline it only wants the font and the tracking.
  eyebrow: {
    fontSize: 13,
    lineHeight: 13 * 1.3,
    letterSpacing: 13 * 0.13,
    marginBottom: Space.s300,
  },
  body: {
    marginTop: Space.s300,
  },
  methods: {
    marginTop: Spacing.cardListGap,
    gap: Space.s300,
  },
  card: {
    flexDirection: 'row',
    gap: Space.s300,
    borderWidth: 1,
    borderRadius: Radius.panel,
    padding: Space.s400,
  },
  cardText: {
    flex: 1,
    gap: Space.s100,
  },
  cardNote: {
    marginTop: Space.s100,
  },
  radio: {
    width: RADIO_SIZE,
    height: RADIO_SIZE,
    borderRadius: RADIO_SIZE / 2,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Space.s100,
  },
  radioDot: {
    width: RADIO_SIZE / 2,
    height: RADIO_SIZE / 2,
    borderRadius: RADIO_SIZE / 4,
  },
  continue: {
    marginBottom: Spacing.cardListGap,
  },
  sheet: {
    paddingHorizontal: Spacing.screenPadding,
    paddingBottom: Spacing.cardListGap,
  },
  qrFrame: {
    borderWidth: 1,
    borderRadius: Radius.panel,
    alignSelf: 'center',
    padding: Space.s400,
    marginTop: Spacing.cardListGap,
  },
  qrPlate: {
    padding: Space.s300,
    borderRadius: Radius.notice,
    backgroundColor: Colors.dark.accentBright,
  },
  sheetTitle: {
    textAlign: 'center',
  },
  sheetClose: {
    marginTop: Spacing.cardListGap,
  },
  // Holds the frame at the size the QR will be, so the sheet does not
  // jump when the code arrives.
  qrPending: {
    width: QR_SIZE,
    height: QR_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
