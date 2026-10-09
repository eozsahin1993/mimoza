import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { KeyboardAvoider } from '@/ui/components/keyboard-avoider';
import { PrimaryButton } from '@/ui/components/buttons/primary-button';
import { ReactionChip } from '@/features/post/components/reaction-chip';
import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Fonts, Radius, Space, Spacing } from '@/ui/theme/tokens';
import { showAlert } from '@/core/services/alerts';
import { showDone } from '@/core/services/messages';
import { NetworkUnreachableError, RateLimitedError } from '@/core/services/relay-errors';
import { feedbackContext, sendFeedback, type FeedbackKind } from '@/features/account/services/feedback-relay';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';

/** Apple's Guideline 1.2 (user-generated content) wants a way to report content and reach us — this screen is that route, and the address is the fallback when it can't send. */
const SUPPORT_EMAIL = 'hello@joinmimoza.com';

/** Scroll clearance above the footer button, same idea as the new-circle screen. */
const FOOTER_CLEARANCE = 110;

const KINDS: FeedbackKind[] = ['bug', 'content', 'feedback'];

export default function FeedbackScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const tints = useTints();
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Built once per open: what it says is what gets sent, and both read
  // the same values.
  const [context] = useState(feedbackContext);
  const included = [
    `Mimoza ${context.appVersion}${context.build ? ` (${context.build})` : ''}`,
    [context.platform, context.osVersion].filter(Boolean).join(' '),
    context.device,
    context.language,
    context.environment,
  ]
    .filter(Boolean)
    .join(' · ');

  async function handleSend() {
    setSending(true);
    setError(null);
    try {
      await sendFeedback({ kind, message: message.trim(), email: email.trim(), context });
      router.back();
      showDone(t('feedback.sent'));
    } catch (err) {
      console.error('Failed to send feedback', err);
      setSending(false);
      if (err instanceof NetworkUnreachableError) {
        setError(t('feedback.failedOffline'));
      } else if (err instanceof RateLimitedError) {
        setError(t('feedback.failedTooMany'));
      } else {
        setError(t('feedback.failed'));
        showAlert(t('feedback.failedTitle'), t('feedback.failedMessage', { email: SUPPORT_EMAIL }), [
          { text: t('common.ok'), style: 'cancel' },
          { text: t('feedback.copyEmail'), onPress: () => Clipboard.setStringAsync(SUPPORT_EMAIL) },
        ]);
      }
    }
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <ScreenHeader title={t('feedback.title')} />

        <KeyboardAvoider style={styles.form}>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            <ThemedText type="bodyMedium">{t('feedback.intro')}</ThemedText>

            <View style={styles.kinds}>
              {KINDS.map((option) => (
                <ReactionChip
                  key={option}
                  label={t(`feedback.kind.${option}`)}
                  reacted={kind === option}
                  onPress={() => setKind(option)}
                />
              ))}
            </View>

            <View>
              <ThemedText type="labelMedium" style={styles.fieldLabel}>
                {t(`feedback.prompt.${kind}`)}
              </ThemedText>
              <TextInput
                value={message}
                onChangeText={setMessage}
                placeholder={t('feedback.messagePlaceholder')}
                placeholderTextColor={theme.faint}
                multiline
                textAlignVertical="top"
                style={[styles.message, { color: theme.text, borderColor: tints.secondaryButtonBorder }]}
              />
            </View>

            <View>
              <ThemedText type="labelMedium" style={styles.fieldLabel}>
                {t('feedback.emailLabel')}
              </ThemedText>
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder={t('feedback.emailPlaceholder')}
                placeholderTextColor={theme.faint}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                style={[styles.input, { color: theme.text, borderColor: tints.secondaryButtonBorder }]}
              />
            </View>

            <View style={[styles.included, { backgroundColor: tints.chipIdleBg, borderColor: tints.chipIdleBorder }]}>
              <ThemedText type="labelSmall" themeColor="muted">
                {t('feedback.includes', { details: included })}
              </ThemedText>
              <ThemedText type="labelSmall" themeColor="faint">
                {t('feedback.includesNote')}
              </ThemedText>
            </View>
          </ScrollView>
        </KeyboardAvoider>
      </ThemedSafeAreaView>

      {/* Pinned to the screen rather than riding up with the keyboard —
          see circle/new.tsx for why. */}
      <ThemedSafeAreaView edges={['bottom']} style={styles.footer}>
        {error ? (
          <ThemedText type="bodyMedium" themeColor="accent" style={styles.error}>
            {error}
          </ThemedText>
        ) : null}
        <PrimaryButton
          label={sending ? t('feedback.sending') : t('feedback.send')}
          disabled={!message.trim() || sending}
          onPress={handleSend}
        />
      </ThemedSafeAreaView>
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
  form: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    gap: Spacing.cardListGap,
    paddingBottom: FOOTER_CLEARANCE,
  },
  kinds: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Space.s200,
  },
  fieldLabel: {
    marginBottom: Space.s300,
  },
  message: {
    minHeight: 140,
    paddingHorizontal: Space.s400,
    paddingTop: Space.s300,
    paddingBottom: Space.s300,
    borderRadius: Radius.input,
    borderWidth: 1,
    // lineHeight is left off deliberately: on a multiline TextInput it
    // throws the vertical alignment out on Android.
    fontFamily: Fonts.sans,
    fontSize: 16,
  },
  input: {
    height: 52,
    paddingHorizontal: Space.s400,
    borderRadius: Radius.input,
    borderWidth: 1,
    fontFamily: Fonts.sans,
    fontSize: 16,
  },
  included: {
    gap: Space.s100,
    padding: Space.s300,
    borderRadius: Radius.notice,
    borderWidth: 1,
  },
  error: {
    textAlign: 'center',
    marginBottom: Space.s300,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Space.s300,
  },
});
