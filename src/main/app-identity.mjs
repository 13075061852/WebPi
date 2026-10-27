// Only installed builds have a matching Windows Start Menu shortcut. Giving
// electron.exe the installed identity makes the taskbar group it with Pi Halo
// and can replace the app icon with Electron's own executable icon.
export function windowsAppUserModelId({ platform, isPackaged, testBuild }) {
  if (platform !== 'win32' || !isPackaged) return null;
  return testBuild ? 'com.pihalo.test' : 'com.pihalo.app';
}
