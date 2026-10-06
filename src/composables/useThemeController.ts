import { ref, watch, type Ref } from 'vue'
import { cloneThemeSettings, defaultThemeSettings } from '../data/theme'
import type { ThemeColorKey, ThemeMode, ThemeSettings } from '../data/theme'

export type ThemePersistOptions = {
  profileOnly?: boolean
}

export type ThemeControllerOptions = {
  persist?: (options?: ThemePersistOptions) => void
}

function readableTextColor(hexColor: string) {
  const values = hexColor.slice(1).match(/.{2}/g)?.map((value) => Number.parseInt(value, 16) / 255) ?? [0, 0, 0]
  const linear = values.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
  return luminance > 0.42 ? '#18231c' : '#ffffff'
}

/**
 * Owns the document theme bridge and the author's two-palette controls.
 *
 * Persistence stays injected so the composable can be reused by the browser
 * and desktop shells without knowing where profile settings are stored.
 */
export function useThemeController(options: ThemeControllerOptions = {}) {
  const themeSettings = ref<ThemeSettings>(cloneThemeSettings(defaultThemeSettings))

  function applyThemeToDocument() {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    const mode = themeSettings.value.mode
    const palette = themeSettings.value[mode]
    const buttonHover = `color-mix(in srgb, ${palette.button} 82%, ${palette.font} 18%)`
    root.dataset.themeMode = mode
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.secondary)
    // The writing surface is the author's primary color. Buttons and focus
    // rings use the button color so controls remain readable on dark surfaces.
    root.style.setProperty('--theme-workspace', palette.primary)
    root.style.setProperty('--theme-primary', palette.button)
    root.style.setProperty('--theme-secondary', palette.secondary)
    root.style.setProperty('--theme-body-bg', palette.secondary)
    root.style.setProperty('--theme-page-bg', palette.secondary)
    root.style.setProperty('--theme-surface', palette.secondary)
    root.style.setProperty('--theme-surface-muted', palette.secondary)
    root.style.setProperty('--theme-surface-soft', palette.secondary)
    root.style.setProperty('--theme-input-bg', palette.secondary)
    root.style.setProperty('--theme-border', `color-mix(in srgb, ${palette.secondary} 78%, ${palette.font} 22%)`)
    root.style.setProperty('--theme-border-soft', `color-mix(in srgb, ${palette.secondary} 88%, ${palette.font} 12%)`)
    root.style.setProperty('--theme-hover', `color-mix(in srgb, ${palette.secondary} 82%, ${palette.button} 18%)`)
    root.style.setProperty('--theme-button', palette.button)
    root.style.setProperty('--theme-button-hover', buttonHover)
    root.style.setProperty('--theme-button-text', readableTextColor(palette.button))
    root.style.setProperty('--theme-font', palette.font)
    root.style.setProperty('--theme-success', palette.success)
    root.style.setProperty('--theme-danger', palette.danger)
    root.style.setProperty('--theme-danger-text', readableTextColor(palette.danger))
    root.style.setProperty('--theme-warning', palette.warning)
    root.style.setProperty('--theme-info', palette.info)
    root.style.setProperty('--theme-muted', `color-mix(in srgb, ${palette.font} 68%, ${palette.secondary})`)
    root.style.setProperty('--theme-accent-soft', `color-mix(in srgb, ${palette.secondary} 86%, ${palette.button} 14%)`)
    root.style.setProperty('--theme-accent-strong', `color-mix(in srgb, ${palette.secondary} 72%, ${palette.button} 28%)`)
    root.style.setProperty('--theme-neutral-soft', `color-mix(in srgb, ${palette.secondary} 88%, ${palette.font} 12%)`)
    root.style.setProperty('--theme-focus-ring', `color-mix(in srgb, ${palette.button} 22%, transparent)`)
  }

  function persistTheme() {
    options.persist?.({ profileOnly: true })
  }

  function toggleThemeMode() {
    themeSettings.value.mode = themeSettings.value.mode === 'dark' ? 'light' : 'dark'
    applyThemeToDocument()
    persistTheme()
  }

  function updateThemeColor(mode: ThemeMode, key: ThemeColorKey, value: string) {
    if (!/^#[0-9a-f]{6}$/i.test(value.trim())) return
    themeSettings.value[mode][key] = value.trim().toLowerCase()
    applyThemeToDocument()
    persistTheme()
  }

  function resetThemeSettings() {
    const mode = themeSettings.value.mode
    themeSettings.value = {
      ...cloneThemeSettings(defaultThemeSettings),
      mode,
    }
    applyThemeToDocument()
    persistTheme()
  }

  watch(themeSettings, applyThemeToDocument, { deep: true })
  applyThemeToDocument()

  return {
    themeSettings,
    applyThemeToDocument,
    toggleThemeMode,
    updateThemeColor,
    resetThemeSettings,
  }
}

export type ThemeController = ReturnType<typeof useThemeController>
export type ThemeSettingsRef = Ref<ThemeSettings>
