import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Avatar } from '@/ui/components/avatar/avatar';
import { Icon } from '@/ui/components/icon';
import { Icons, Radius, Space, Type } from '@/ui/theme/tokens';
import { useOwnColorSeed } from '@/ui/theme/hooks/use-own-color-seed';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';

export type CommentComposerBarProps = {
  onSubmit: (body: string) => void;
  /** The reader's own picture, shown beside the field — it's their comment. */
  selfPhotoUri?: string;
  /** Pairs with `selfPhotoUri` — initials before a picture is set. */
  selfName?: string;
};

/** Matches the one line of 14pt comment text this sits beside, not a form field's usual height. */
const COMPOSER_HEIGHT = 42;

/**
 * The feed's comment composer: a self-avatar, the field, and send. Lives
 * inline in the card that opened it — `circle/feed.tsx`'s `FlatList` is
 * wrapped in `KeyboardAwareScrollView` precisely so an ordinary row like
 * this one gets scrolled above the keyboard rather than needing to float
 * itself there.
 */
export function CommentComposerBar({ onSubmit, selfPhotoUri, selfName }: CommentComposerBarProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const tints = useTints();
  const ownColorSeed = useOwnColorSeed();
  const [text, setText] = useState('');

  function handleSubmit() {
    if (!text.trim()) return;
    onSubmit(text);
    setText('');
  }

  return (
    <View style={styles.row}>
      {/* Full composer height, unlike the comment rows' smaller avatar —
          here it's one of three controls on a line, and a short circle
          beside a tall box reads as misaligned however it's centred. */}
      <Avatar size={COMPOSER_HEIGHT} uri={selfPhotoUri} name={selfName} colorSeed={ownColorSeed} />
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={t('post.addComment')}
        placeholderTextColor={theme.muted}
        autoFocus
        multiline
        // Return inserts a newline, same as any multiline field — the
        // Send button beside it is the only way to submit, same reasoning
        // most comment boxes use: an accidental return mid-thought
        // shouldn't post the comment half-written.
        style={[styles.input, { color: theme.text, borderColor: tints.chipIdleBorder, backgroundColor: tints.chipIdleBg }]}
      />
      <Pressable
        onPress={handleSubmit}
        disabled={!text.trim()}
        style={[styles.send, { backgroundColor: theme.accent }, !text.trim() && styles.sendDisabled]}>
        <Icon icon={Icons.send} size={24} color={theme.accentLabel} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s300,
  },
  input: {
    flex: 1,
    minHeight: COMPOSER_HEIGHT,
    maxHeight: COMPOSER_HEIGHT * 3,
    paddingHorizontal: Space.s400,
    paddingTop: Space.s300,
    paddingBottom: Space.s300,
    borderRadius: Radius.pill,
    borderWidth: 1,
    // lineHeight is left off deliberately: on a multiline TextInput it
    // throws the vertical centring out on Android.
    fontFamily: Type.bodySmall.fontFamily,
    fontSize: Type.bodySmall.fontSize,
  },
  send: {
    width: COMPOSER_HEIGHT,
    height: COMPOSER_HEIGHT,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Stays mounted rather than unmounting with no text, so the row's width
  // is stable while typing — swapping it in and out shifted the input's
  // flex basis and threw off the row's vertical centring with it.
  sendDisabled: {
    opacity: 0.4,
  },
});
