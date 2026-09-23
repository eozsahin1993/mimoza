import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { ActionSheet, type ActionSheetOption } from '@/ui/components/action-sheet';
import { Avatar } from '@/ui/components/avatar/avatar';
import { Icon } from '@/ui/components/icon';
import { InviteSheet } from '@/features/invite/components/invite-sheet';
import { OptionSheet } from '@/ui/components/option-sheet';
import { PromptSheet } from '@/ui/components/prompt-sheet';
import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { SettingsGroups, type SettingsGroup } from '@/ui/components/settings-group';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Fonts, Icons, Radius, Space, Spacing } from '@/ui/theme/tokens';
import { type Member } from '@/data/db';
import { MemberRoles, type MemberRole } from '@/features/circle/usecases/change-member-role';
import { setMemberRole } from '@/features/circle/usecases/change-member-role';
import { resolveCircleCoverUri } from '@/features/circle/usecases/circle-cover';
import { loadCircleDetails, type CircleDetails } from '@/features/circle/usecases/circle-details';
import { getOrCreateInvite, replaceInvite } from '@/features/invite/usecases/invite-to-circle';
import { leaveCircle } from '@/features/circle/usecases/leave-circle';
import { removeMember } from '@/features/circle/usecases/remove-member';
import { renameCircle } from '@/features/circle/usecases/rename-circle';
import { setCoverPhoto } from '@/features/circle/usecases/set-cover-photo';
import {
  NotifyLevels,
  setCircleNotifyLevel,
  type NotifyLevel,
} from '@/features/push-notifications/usecases/push-preferences';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';
import { showDone, showError } from '@/core/services/messages';
import { pickAndCompressImage } from '@/core/photo/image';
import { formatMonth } from '@/core/utils/time';
import { useLanguage } from '@/core/i18n/use-language';

function inviteLink(code: string): string {
  return `mimoza://join/${code}`;
}

function daysUntil(expiresAt: number): number {
  return Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
}

/** Stable identity, so `avatarUris`' memo doesn't bust on every render. */
const NO_MEMBERS: Member[] = [];


export default function CircleDetailsScreen() {
  const { t } = useTranslation();
  const language = useLanguage();
  const theme = useTheme();
  const tints = useTints();
  const { circleId } = useLocalSearchParams<{ circleId: string }>();
  const [details, setDetails] = useState<CircleDetails | null>(null);
  const [sharing, setSharing] = useState(false);
  const [memberMenu, setMemberMenu] = useState<Member | null>(null);
  const [inviteSheet, setInviteSheet] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [coverUri, setCoverUri] = useState<string | undefined>();
  const [levelPicker, setLevelPicker] = useState(false);

  const circle = details?.circle ?? null;
  const members = details?.members ?? NO_MEMBERS;
  const admin = details?.ownIsAdmin ?? false;
  const ownPublicKey = details?.ownPublicKey ?? null;
  const invite = details?.invite ?? null;
  const notifyLevel = (details?.notifyLevel ?? 'all') as NotifyLevel;
  const silenced = notifyLevel === 'none';

  /**
   * Only an admin may write `member_added` or change a role, so a circle
   * whose one admin loses their device can never add or remove anyone
   * again, including re-adding that person. No entry repairs it after the
   * fact, so promoting a second admin first is the only fix there is.
   */
  const soleAdmin = admin && members.filter((member) => member.role === MemberRoles.ADMIN).length === 1;
  // A sole member's "leave" actually runs `deleteCircleForEveryone`, so
  // the row and the alert say Delete to match. `leaveCircle` re-checks
  // against a fresh roster before deleting; this only picks the words.
  const lastMember = members.length === 1;

  const reload = useCallback(async () => {
    if (!circleId) return;
    setDetails(await loadCircleDetails(circleId));
    setCoverUri(await resolveCircleCoverUri(circleId));
  }, [circleId]);

  function formatExpiry(expiresAt: number): string {
    const days = daysUntil(expiresAt);
    return days <= 0 ? t('circle.details.expired') : t('circle.details.expiresIn', { count: days });
  }

  function expiryFootnote(expiresAt: number): string {
    const days = daysUntil(expiresAt);
    return days <= 0 ? t('circle.details.keyExpired') : t('circle.details.keyExpiresIn', { count: days });
  }

  useFocusEffect(
    useCallback(() => {
      reload().catch((err) => console.error('Failed to load circle details', err));
    }, [reload]),
  );

  function handleRemoveMember(member: Member) {
    if (!circleId) return;
    Alert.alert(
      member.name ? t('circle.details.removeTitle', { name: member.name }) : t('circle.details.removeTitleUnnamed'),
      t('circle.details.removeMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('circle.details.remove'),
          style: 'destructive',
          onPress: async () => {
            try {
              await removeMember(circleId, member.accountId);
              await reload();
            } catch (err) {
              console.error('Failed to remove member', err);
              showError(t('circle.details.removeFailed'));
            }
          },
        },
      ],
    );
  }

  async function handleSetRole(member: Member, role: MemberRole) {
    if (!circleId) return;
    try {
      await setMemberRole(circleId, member.accountId, role);
      await reload();
      // Nothing on the roster moves until the relay accepts the change
      // and the entry syncs back, so say so rather than leave the tap
      // looking like it did nothing.
      showDone(role === MemberRoles.ADMIN ? t('circle.details.becomesAdmin') : t('circle.details.stopsBeingAdmin'));
    } catch (err) {
      console.error('Failed to change member role', err);
      showError(t('circle.details.roleChangeFailed'));
    }
  }

  const memberMenuOptions: ActionSheetOption[] = memberMenu
    ? [
        memberMenu.role === MemberRoles.ADMIN
          ? {
              label: t('circle.details.removeAdmin'),
              icon: Icons.demote,
              onPress: () => handleSetRole(memberMenu, MemberRoles.MEMBER),
            }
          : {
              label: t('circle.details.makeAdmin'),
              icon: Icons.promote,
              onPress: () => handleSetRole(memberMenu, MemberRoles.ADMIN),
            },
        {
          label: t('circle.details.removeFromCircle'),
          icon: Icons.removeMember,
          destructive: true,
          onPress: () => handleRemoveMember(memberMenu),
        },
      ]
    : [];

  async function handleSilenceChange(silenced: boolean) {
    if (!circleId) return;
    // Reloaded rather than held in local state: the local flag is written
    // first and is what this row reads, so a failed relay call still leaves
    // the toggle showing what was actually stored.
    try {
      await setCircleNotifyLevel(circleId, ownPublicKey ?? '', silenced ? 'none' : 'all');
    } catch (err) {
      console.error('Failed to change notification settings', err);
      showError(t('circle.details.relayUnreachable'));
    }
    await reload();
  }

  async function handleLevelChange(level: NotifyLevel) {
    if (!circleId) return;
    setLevelPicker(false);
    try {
      await setCircleNotifyLevel(circleId, ownPublicKey ?? '', level);
    } catch (err) {
      console.error('Failed to change notification settings', err);
      showError(t('circle.details.relayUnreachable'));
    }
    await reload();
  }

  async function handleShareLink() {
    if (!circleId) return;
    setSharing(true);
    try {
      const invite = await getOrCreateInvite(circleId);
      await Share.share({
        message: circle
          ? t('circle.details.shareMessage', { name: circle.name, link: inviteLink(invite.code) })
          : t('circle.details.shareMessageUnnamed', { link: inviteLink(invite.code) }),
      });
    } catch (err) {
      console.error('Failed to share invite', err);
      showError(t('circle.details.inviteFailed'));
    } finally {
      setSharing(false);
    }
  }

  /** Mints the key before opening, so the sheet never renders an empty code. */
  async function handleShowCode() {
    if (!circleId) return;
    try {
      await getOrCreateInvite(circleId);
      await reload();
      setInviteSheet(true);
    } catch (err) {
      console.error('Failed to create an invite', err);
      showError(t('circle.details.inviteFailed'));
    }
  }

  /** Asks first: this retires every invite already handed out. */
  function handleReplaceKey() {
    if (!circleId) return;
    Alert.alert(
      t('circle.details.replaceKeyTitle'),
      t('circle.details.replaceKeyMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('circle.details.replace'),
          style: 'destructive',
          onPress: async () => {
            setSharing(true);
            try {
              await replaceInvite(circleId);
              await reload();
            } catch (err) {
              console.error('Failed to replace the invite key', err);
              showError(t('circle.details.replaceKeyFailed'));
            } finally {
              setSharing(false);
            }
          },
        },
      ],
    );
  }

  async function handleLeave() {
    if (!circleId) return;
    // Named rather than left as a surprise: leaving as the last admin
    // hands the circle to someone, and this is where that can be
    // cancelled and overridden with "Make admin" on someone else.
    const name = circle?.name;
    Alert.alert(
      lastMember
        ? name
          ? t('circle.details.deleteTitle', { name })
          : t('circle.details.deleteTitleUnnamed')
        : name
          ? t('circle.details.leaveTitle', { name })
          : t('circle.details.leaveTitleUnnamed'),
      lastMember
        ? name
          ? t('circle.details.deleteMessage', { name })
          : t('circle.details.deleteMessageUnnamed')
        : t('circle.details.leaveMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: lastMember ? t('circle.details.delete') : t('circle.details.leave'),
          style: 'destructive',
          onPress: async () => {
            // All local: the entry announcing the departure is queued, not
            // pushed, so this works offline and can't fail on a connection.
            try {
              await leaveCircle(circleId);
            } catch (err) {
              console.error('Failed to leave circle', err);
              showError(lastMember ? t('circle.details.deleteFailed') : t('circle.details.leaveFailed'));
              return;
            }
            router.dismissTo('/circle');
          },
        },
      ],
    );
  }

  async function handleSetCoverPhoto() {
    if (!circleId) return;
    try {
      const picked = await pickAndCompressImage();
      if (!picked) return;
      await setCoverPhoto(circleId, picked.bytes);
      await reload();
    } catch (err) {
      console.error('Failed to set the cover photo', err);
      showError(t('circle.details.coverFailed'));
    }
  }

  async function handleRename(name: string) {
    if (!circleId) return;
    try {
      await renameCircle(circleId, name);
      setRenaming(false);
      await reload();
    } catch (err) {
      console.error('Failed to rename the circle', err);
      showError(t('circle.details.renameFailed'));
      setRenaming(false);
    }
  }



  /**
   * The three things you can do with a circle's key. Its own group rather
   * than a member of `settingsGroups` because it belongs above the roster,
   * where you look when the reason you opened this screen is to add
   * someone.
   */
  const inviteGroup: SettingsGroup = {
    title: t('circle.details.inviteMembers'),
    rows: [
      {
        label: t('circle.details.shareLink'),
        description: t('circle.details.shareLinkDescription'),
        icon: Icons.inviteLink,
        // No chevron: this hands off to the OS share sheet rather than
        // opening a view of ours to come back from.
        disabled: sharing,
        onPress: handleShareLink,
      },
      {
        label: t('circle.details.showCode'),
        description: t('circle.details.showCodeDescription'),
        icon: Icons.inviteCode,
        control: { kind: 'navigate' },
        disabled: sharing,
        onPress: handleShowCode,
      },
      {
        label: t('circle.details.replaceKey'),
        description: t('circle.details.replaceKeyDescription'),
        icon: Icons.replaceKey,
        // The code sits on the row that retires it, so what "the old code"
        // means is the thing you're looking at.
        control: invite ? { kind: 'value', text: invite.code } : undefined,
        disabled: sharing,
        onPress: handleReplaceKey,
      },
    ],
    footnote: invite
      ? `${t('circle.details.inviteFootnote')} ${expiryFootnote(invite.expiresAt)}`
      : t('circle.details.inviteFootnote'),
  };

  /**
   * Every setting on this screen, as data. Adding one is an entry here —
   * a row gated on `admin` can say so inline, and a group whose rows all
   * drop out renders nothing.
   */
  const settingsGroups: SettingsGroup[] = [
    {
      title: t('circle.details.notifications'),
      footnote: silenced
        ? t('circle.details.notificationsSilencedFootnote')
        : t('circle.details.notificationsFootnote'),
      rows: [
        {
          label: t('circle.details.silence'),
          description: t('circle.details.silenceDescription'),
          control: { kind: 'switch', value: silenced, onValueChange: handleSilenceChange },
        },
        {
          label: t('settings.notifyMeAbout'),
          control: { kind: 'value', text: t(`settings.notifyLevels.${notifyLevel}`) },
          disabled: notifyLevel === 'none',
          onPress: () => setLevelPicker(true),
        },
      ],
    },
    {
      title: t('circle.details.thisCircle'),
      rows: [
        admin && {
          label: t('circle.details.coverPhoto'),
          description: t('circle.details.coverPhotoDescription'),
          // Resolved the same way the list resolves it, newest-post
          // fallback included, so the row can't show a circle a different
          // face from the one you just tapped.
          control: { kind: 'image', uri: coverUri },
          onPress: handleSetCoverPhoto,
        },
        admin && {
          label: t('circle.details.rename'),
          description: t('circle.details.renameDescription'),
          control: { kind: 'navigate' },
          onPress: () => setRenaming(true),
        },
      ],
    },
    {
      title: t('circle.details.careful'),
      destructive: true,
      rows: [
        lastMember
          ? {
              // What actually happens: a sole member's departure runs
              // `deleteCircleForEveryone`, not a plain leave.
              label: circle ? t('circle.details.deleteRow', { name: circle.name }) : t('circle.details.deleteRowUnnamed'),
              description: t('circle.details.deleteRowDescription'),
              destructive: true,
              onPress: handleLeave,
            }
          : {
              label: circle ? t('circle.details.leaveRow', { name: circle.name }) : t('circle.details.leaveRowUnnamed'),
              // Not "you keep the photos": `markCircleLeft` is a soft delete and
              // the bytes do survive, but every list filters left circles out,
              // so there is no screen that can still show them.
              description: t('circle.details.leaveRowDescription'),
              destructive: true,
              onPress: handleLeave,
            },
      ],
    },
  ];

  function renderMemberList() {
    return (
      <>
        <View style={styles.sectionHeader}>
          <ThemedText type="labelMedium">
            {t('circle.details.members')}
          </ThemedText>
          <ThemedText type="labelSmall" themeColor="muted">
            {t('circle.details.inTheCircle', { count: members.length })}
          </ThemedText>
        </View>

        {members.map(renderMember)}

        {soleAdmin && members.length > 1 ? (
          <ThemedText type="labelSmall" themeColor="faint" style={styles.adminNotice}>
            {t('circle.details.soleAdminNotice')}
          </ThemedText>
        ) : null}
      </>
    );
  }

  /** One roster row. The menu is offered on everyone but the reader — nobody demotes or removes themselves here. */
  function renderMember(member: Member) {
    return (
      <View key={member.accountId} style={[styles.memberRow, { borderBottomColor: tints.chipIdleBorder }]}>
        <Avatar
          size={44}
                    name={member.name}
          colorSeed={member.accountId}
        />

        <View style={styles.memberInfo}>
          <View style={styles.memberNameRow}>
            <ThemedText type="titleSmall">{member.name || t('circle.details.unnamedMember')}</ThemedText>
            {member.role === MemberRoles.ADMIN ? (
              <View style={[styles.adminBadge, { backgroundColor: theme.accent }]}>
                <ThemedText type="labelSmall" themeColor="accentLabel" style={styles.adminBadgeText}>
                  {t('circle.details.admin')}
                </ThemedText>
              </View>
            ) : null}
          </View>
          <ThemedText type="labelSmall" themeColor="muted">
            {t('circle.details.joined', { month: formatMonth(member.joinedAt, language) })}
          </ThemedText>
        </View>

        {admin && member.accountId !== ownPublicKey ? (
          <Pressable hitSlop={12} style={styles.memberMenuButton} onPress={() => setMemberMenu(member)}>
            <Icon icon={Icons.more} size={20} color={theme.muted} />
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <ScreenHeader title={t('circle.details.title')} />

        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          <ThemedText type="headlineSmall">{circle?.name ?? ''}</ThemedText>
          <ThemedText type="labelSmall" themeColor="muted" style={styles.memberCount}>
            {t('circle.peopleCount', { count: members.length })}
          </ThemedText>

          {admin ? <SettingsGroups groups={[inviteGroup]} /> : null}

          {renderMemberList()}

          <SettingsGroups groups={settingsGroups} />

        </ScrollView>
      </ThemedSafeAreaView>

      <PromptSheet
        visible={renaming}
        title={t('circle.details.rename')}
        description={t('circle.details.renamePromptDescription')}
        initialValue={circle?.name ?? ''}
        placeholder={t('circle.details.namePlaceholder')}
        confirmLabel={t('circle.details.renameConfirm')}
        onCancel={() => setRenaming(false)}
        onConfirm={handleRename}
      />

      <InviteSheet
        visible={inviteSheet}
        onClose={() => setInviteSheet(false)}
        link={invite ? inviteLink(invite.code) : ''}
        code={invite?.code ?? ''}
        expiry={invite ? formatExpiry(invite.expiresAt) : undefined}
      />

      <OptionSheet
        visible={levelPicker}
        onClose={() => setLevelPicker(false)}
        title={t('settings.notifyMeAbout')}
        options={NotifyLevels.map((level) => ({ id: level, label: t(`settings.notifyLevels.${level}`) }))}
        selected={notifyLevel}
        onSelect={handleLevelChange}
      />

      <ActionSheet
        visible={memberMenu !== null}
        onClose={() => setMemberMenu(null)}
        title={memberMenu?.name || t('circle.details.thisMember')}
        avatarName={memberMenu?.name}
        avatarColorSeed={memberMenu?.accountId}
        options={memberMenuOptions}
      />
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
  memberCount: {
    marginTop: Space.s100,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingBottom: Spacing.cardListGap,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.cardListGap,
    marginBottom: Space.s100,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s300,
    paddingVertical: Space.s300,
    borderBottomWidth: 1,
  },
  memberInfo: {
    flex: 1,
    gap: Space.s100,
  },
  memberMenuButton: {
    padding: Space.s100,
  },
  memberNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.s200,
  },
  adminBadge: {
    borderRadius: Radius.pill,
    paddingHorizontal: Space.s200,
    paddingVertical: Space.s100,
  },
  adminBadgeText: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 10.5,
  },
  adminNotice: {
    marginTop: Space.s300,
  },
  debugZone: {
    marginTop: Spacing.cardListGap,
    gap: Space.s200,
  },
});
