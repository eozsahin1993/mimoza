import { getAppSettings, updateAppSettings } from '@/core/services/settings';

test('follows the device when a stored language is no longer offered', async () => {
  await updateAppSettings({ language: 'pt' as never });

  expect((await getAppSettings()).language).toBe('system');
});
