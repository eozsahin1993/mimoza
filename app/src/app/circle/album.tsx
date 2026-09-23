import { Image } from 'expo-image';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { missingPhotoFor, PhotoPlaceholder } from '@/ui/components/photo-placeholder';
import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Space, Spacing } from '@/ui/theme/tokens';
import { getAlbum, getAttachment, getCircle } from '@/data/db';
import { ensurePhotoUri, writePhotoFile } from '@/core/photo/photo-cache';
import { formatMonth } from '@/core/utils/time';
import { useLanguage } from '@/core/i18n/use-language';

/** Photos per row. Four fits a month on a screen without shrinking faces past recognising. */
const COLUMNS = 4;

/** Just enough of a post to lay the grid out — see getAlbum. */
type AlbumPhoto = { id: string; createdAt: number };

type AlbumItem = AlbumPhoto & { uri: string | null; photoStatus?: string };

/**
 * A month header, then that month's photos in rows of `COLUMNS`.
 *
 * A flat list of both kinds rather than `numColumns`, which can only lay
 * out uniform cells and so has nowhere to put a full-width header — same
 * discriminated-union shape the feed's own rows use.
 */
type AlbumRow =
  | {
      kind: 'month';
      key: string;
      /**
       * Headed "September 2027". The year is always spelled out, even for the
       * current one — an album is read years later, where a bare month is
       * ambiguous, and a label that grows a year only once January passes
       * would reorder the headers under the reader mid-scroll.
       */
      start: number;
    }
  | { kind: 'photos'; key: string; photos: AlbumItem[] };

/** Midnight on the 1st of this timestamp's month — the grouping key. */
function monthStart(ms: number): Date {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  date.setDate(1);
  return date;
}

/** Groups newest-first photos into month sections, each chunked into rows. */
function buildRows(photos: AlbumItem[]): AlbumRow[] {
  const rows: AlbumRow[] = [];
  let openMonth: number | null = null;

  for (const photo of photos) {
    const start = monthStart(photo.createdAt);
    if (start.getTime() !== openMonth) {
      openMonth = start.getTime();
      rows.push({ kind: 'month', key: `month-${openMonth}`, start: openMonth });
    }

    const last = rows[rows.length - 1];
    if (last.kind === 'photos' && last.photos.length < COLUMNS) {
      last.photos.push(photo);
    } else {
      rows.push({ kind: 'photos', key: `row-${photo.id}`, photos: [photo] });
    }
  }

  return rows;
}

/**
 * Resolves each photo to a cached `file://` path, keeping the ones whose
 * bytes haven't arrived as a null uri rather than dropping them. Dropping
 * them made a partly-synced album silently shorter than the circle's, with
 * nothing to say a photo was missing at all.
 *
 * Only a photo whose file isn't cached costs a read of its bytes — the
 * cache is derived, so a cleared cache directory costs one rewrite rather
 * than losing the photo (see photo-cache.ts).
 */
async function resolvePhotos(circleId: string, photos: AlbumPhoto[]): Promise<AlbumItem[]> {
  const resolved: AlbumItem[] = [];

  for (const photo of photos) {
    let uri = ensurePhotoUri(circleId, photo.id, () => null);
    let photoStatus: string | undefined;
    if (!uri) {
      const attachment = await getAttachment(circleId, photo.id);
      if (attachment?.bytes) uri = writePhotoFile(circleId, photo.id, attachment.bytes);
      else photoStatus = attachment?.status;
    }
    resolved.push({ ...photo, uri: uri ?? null, photoStatus });
  }

  return resolved;
}

/** Every photo in this circle's album, newest week first — the archive behind the feed. */
export default function AlbumScreen() {
  const { circleId } = useLocalSearchParams<{ circleId: string }>();
  const [circleName, setCircleName] = useState('');
  const [rows, setRows] = useState<AlbumRow[]>([]);
  // Avoids flashing the empty state before the first read resolves.
  const [loaded, setLoaded] = useState(false);
  const { t } = useTranslation();
  const language = useLanguage();

  const load = useCallback(async () => {
    if (!circleId) return;

    const [circle, posts] = await Promise.all([getCircle(circleId), getAlbum(circleId)]);
    setCircleName(circle?.name ?? '');
    const photos: AlbumPhoto[] = posts.map((post) => ({ id: post.id, createdAt: post.createdAt }));
    setRows(buildRows(await resolvePhotos(circleId, photos)));
    setLoaded(true);
  }, [circleId]);

  useFocusEffect(
    useCallback(() => {
      load().catch((err) => console.error('Failed to load the album', err));
    }, [load]),
  );

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        {/* The header keeps the screen's usual inset; the grid below runs
            edge to edge, so nothing competes with the photos. */}
        <View style={styles.headerInset}>
          <ScreenHeader title={t('circle.album.title')} subtitle={circleName} />
        </View>

        <FlatList
          data={loaded ? rows : []}
          keyExtractor={(row) => row.key}
          contentContainerStyle={styles.list}
          renderItem={({ item }) =>
            item.kind === 'month' ? (
              <ThemedText type="labelMedium" style={styles.monthLabel}>
                {formatMonth(item.start, language)}
              </ThemedText>
            ) : (
              <View style={styles.photoRow}>
                {item.photos.map((photo) => (
                  <Pressable
                    key={photo.id}
                    style={styles.cell}
                    onPress={() => router.push({ pathname: '/post/[id]', params: { id: photo.id, circleId } })}>
                    {photo.uri ? (
                      <Image source={{ uri: photo.uri }} style={styles.photo} contentFit="cover" />
                    ) : (
                      // Icon only: a cell this size has no room for the
                      // label the feed's placeholder carries.
                      <PhotoPlaceholder style={styles.photo} missing={missingPhotoFor(photo.photoStatus)} compact />
                    )}
                  </Pressable>
                ))}
                {/* Keeps a short last row left-aligned rather than stretching its photos. */}
                {Array.from({ length: COLUMNS - item.photos.length }, (_, index) => (
                  <View key={`gap-${index}`} style={styles.cell} />
                ))}
              </View>
            )
          }
          ListEmptyComponent={
            loaded ? (
              <View style={styles.empty}>
                <ThemedText type="titleMedium" style={styles.emptyText}>
                  {t('circle.album.emptyTitle')}
                </ThemedText>
                <ThemedText type="bodyMedium" themeColor="muted" style={styles.emptyText}>
                  {t('circle.album.emptyBody')}
                </ThemedText>
              </View>
            ) : null
          }
        />
      </ThemedSafeAreaView>
    </ThemedView>
  );
}

const GAP = 2;

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  headerInset: {
    paddingHorizontal: Spacing.screenPadding,
  },
  list: {
    flexGrow: 1,
    paddingBottom: Spacing.cardListGap,
  },
  monthLabel: {
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Spacing.cardListGap,
    paddingBottom: Space.s200,
  },
  photoRow: {
    flexDirection: 'row',
    gap: GAP,
    marginBottom: GAP,
  },
  cell: {
    flex: 1,
    aspectRatio: 1,
  },
  photo: {
    width: '100%',
    height: '100%',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.screenPadding,
    gap: Spacing.cardListGap,
  },
  emptyText: {
    textAlign: 'center',
  },
});
