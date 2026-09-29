import { useEffect } from 'react';
import { useSegments } from 'expo-router';

import { logScreenView } from '@/core/services/analytics';

/**
 * Logs a screen view on every route change, keyed on the route's literal
 * pattern (e.g. "/post/[id]") via useSegments — never the interpolated
 * path, so circle/post/request ids never reach Analytics.
 */
export function useScreenViewTracking(): void {
  const segments = useSegments();
  const screenName = segments.length ? `/${segments.join('/')}` : '/';

  useEffect(() => {
    void logScreenView(screenName);
  }, [screenName]);
}
