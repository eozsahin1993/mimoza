import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';

import { missingPhotoFor, PhotoPlaceholder } from '@/ui/components/photo-placeholder';
import { usePostPhotoUri } from '@/core/photo/use-photo-uri';

export type AlbumCellPhoto = {
  id: string;
  /** The cached file as of the album read, or null while the bytes haven't arrived. */
  uri: string | null;
  /** Why there is no file yet — see `PhotoPlaceholder`. */
  photoStatus?: string;
};

export type AlbumCellProps = {
  circleId: string;
  photo: AlbumCellPhoto;
  /** No longer in the circle: a photo that never landed is not coming. */
  archived: boolean;
};

/** One grid cell. Its own component so a photo landing while the album is open fills its cell in. */
export function AlbumCell({ circleId, photo, archived }: AlbumCellProps) {
  const uri = usePostPhotoUri(circleId, photo.id, photo.uri ?? undefined);

  return (
    <Pressable style={styles.cell} onPress={() => router.push({ pathname: '/post/[id]', params: { id: photo.id, circleId } })}>
      {uri ? (
        <Image source={{ uri }} style={styles.photo} contentFit="cover" />
      ) : (
        // Icon only: a cell this size has no room for the label the
        // feed's placeholder carries.
        <PhotoPlaceholder style={styles.photo} missing={missingPhotoFor(photo.photoStatus, archived)} compact />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cell: {
    flex: 1,
    aspectRatio: 1,
  },
  photo: {
    width: '100%',
    height: '100%',
  },
});
