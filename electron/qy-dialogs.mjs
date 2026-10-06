/**
 * Associate native file pickers with their requesting desktop window and
 * classify native-dialog failures the same way as file read/write failures.
 */
export async function showOwnedQyFileDialog({
  dialog,
  ownerWindow,
  mode,
  options,
  logger = () => {},
}) {
  const owner = ownerWindow && !ownerWindow.isDestroyed() ? ownerWindow : undefined
  try {
    // Keep each Electron method's receiver; destructuring a native method can
    // produce an "Illegal invocation" rather than a file picker.
    if (mode === 'open') {
      return owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
    }
    return owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options)
  } catch (error) {
    logger(`Unable to show .qy ${mode} dialog`, error)
    return {
      canceled: false,
      error: error instanceof Error && error.message
        ? error.message
        : mode === 'open' ? '无法打开作品集文件选择窗口' : '无法打开作品集保存窗口',
    }
  }
}
