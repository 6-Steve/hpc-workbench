export const isMac = typeof window !== 'undefined' && window.hpc?.platform === 'darwin'
export const shortcutModifier = isMac ? '⌘' : 'Ctrl+'
export const traceShortcut = isMac ? '⌘⇧L' : 'Ctrl+`'
