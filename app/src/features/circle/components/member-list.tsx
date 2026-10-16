import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/ui/components/avatar/avatar';
import { Icon } from '@/ui/components/icon';
import { ThemedText } from '@/ui/theme/themed-text';
import { Fonts, Icons, Radius, Space, Spacing } from '@/ui/theme/tokens';
import { useTheme, useTints } from '@/ui/theme/hooks/use-theme';
import type { Member } from '@/data/db';
import { MemberRoles } from '@/features/circle/usecases/change-member-role';
import { useProfilePictureUri } from '@/core/photo/use-photo-uri';
import { formatMonth } from '@/core/utils/time';
import { useLanguage } from '@/core/i18n/use-language';

export type MemberListProps = {
  members: Member[];
  /** Each member's picture as of the details read; a row follows the photo store from there. */
  avatarByAccount: Map<string, string>;
  /** The reader is an admin: every other row gets a menu. */
  admin: boolean;
  ownAccountId: string | null;
  /** The reader is the only admin — worth saying when there is anyone else to promote. */
  soleAdmin: boolean;
  onMemberMenu: (member: Member) => void;
};

/** The roster section of circle details: a header with the count, one row per member, and the sole-admin notice. */
export function MemberList({ members, avatarByAccount, admin, ownAccountId, soleAdmin, onMemberMenu }: MemberListProps) {
  const { t } = useTranslation();

  return (
    <>
      <View style={styles.sectionHeader}>
        <ThemedText type="labelMedium">{t('circle.details.members')}</ThemedText>
        <ThemedText type="labelSmall" themeColor="muted">
          {t('circle.details.inTheCircle', { count: members.length })}
        </ThemedText>
      </View>

      {members.map((member) => (
        <MemberRow
          key={member.accountId}
          member={member}
          initialUri={avatarByAccount.get(member.accountId)}
          // Offered on everyone but the reader — nobody demotes or removes themselves here.
          showMenu={admin && member.accountId !== ownAccountId}
          onMenu={() => onMemberMenu(member)}
        />
      ))}

      {soleAdmin && members.length > 1 ? (
        <ThemedText type="labelSmall" themeColor="faint" style={styles.adminNotice}>
          {t('circle.details.soleAdminNotice')}
        </ThemedText>
      ) : null}
    </>
  );
}

type MemberRowProps = {
  member: Member;
  /** The picture the details read found, until one lands in the photo store. */
  initialUri: string | undefined;
  showMenu: boolean;
  onMenu: () => void;
};

/** One roster row. Its own component so the avatar can follow the member's picture as it lands. */
function MemberRow({ member, initialUri, showMenu, onMenu }: MemberRowProps) {
  const { t } = useTranslation();
  const language = useLanguage();
  const theme = useTheme();
  const tints = useTints();
  const uri = useProfilePictureUri(member.accountId, initialUri);

  return (
    <View style={[styles.memberRow, { borderBottomColor: tints.chipIdleBorder }]}>
      <Avatar size={44} uri={uri} name={member.name} colorSeed={member.accountId} />

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

      {showMenu ? (
        <Pressable hitSlop={12} style={styles.memberMenuButton} onPress={onMenu}>
          <Icon icon={Icons.more} size={20} color={theme.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
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
});
