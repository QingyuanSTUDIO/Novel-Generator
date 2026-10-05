export type ThemeMode = 'light' | 'dark'

export type ThemeColorKey = 'primary' | 'secondary' | 'button' | 'font' | 'success' | 'danger' | 'warning' | 'info'

export type ThemePalette = Record<ThemeColorKey, string>

export type ThemeSettings = {
  version: 2
  mode: ThemeMode
  light: ThemePalette
  dark: ThemePalette
}

export const themeColorFields: Array<{ key: ThemeColorKey; label: string; description: string }> = [
  { key: 'primary', label: '主色 / 背景颜色', description: '正文编辑区使用的主要背景色，也是整套界面的主色。' },
  { key: 'secondary', label: '配色（侧栏与辅助区）', description: '侧栏、导航、标签和辅助区域使用的配色。' },
  { key: 'button', label: '按钮颜色', description: '主要操作按钮和重点操作使用的颜色。' },
  { key: 'font', label: '字体颜色', description: '正文和主要文字使用的颜色。' },
  { key: 'success', label: '成功色（可用 / 完成）', description: 'API 可用、校对完成和成功提示使用的颜色。' },
  { key: 'danger', label: '危险色（错误 / 删除）', description: '未配置、错误信息和删除操作使用的颜色。' },
  { key: 'warning', label: '提醒色（待修改）', description: '待修改、待确认和需要注意的状态使用的颜色。' },
  { key: 'info', label: '信息色（Agent 创建）', description: 'Agent 创建、来源说明和信息提示使用的颜色。' },
]

export const defaultThemeSettings: ThemeSettings = {
  version: 2,
  mode: 'light',
  light: {
    primary: '#ffffff',
    secondary: '#f1f4ef',
    button: '#315b49',
    font: '#24312b',
    success: '#3f8255',
    danger: '#b24f4f',
    warning: '#956a25',
    info: '#466c86',
  },
  dark: {
    primary: '#14251c',
    secondary: '#152019',
    button: '#4d8966',
    font: '#e6f0e8',
    success: '#79c28a',
    danger: '#f18b83',
    warning: '#e8b55f',
    info: '#82b7db',
  },
}

const colorPattern = /^#[0-9a-f]{6}$/i

function normalizeColor(value: unknown, fallback: string) {
  return typeof value === 'string' && colorPattern.test(value.trim()) ? value.trim().toLowerCase() : fallback
}

function normalizePalette(value: unknown, fallback: ThemePalette, migrateLegacySurfaceColors = false): ThemePalette {
  const source = value && typeof value === 'object' ? value as Partial<Record<ThemeColorKey, unknown>> : {}
  return {
    // Before version 2, primary/secondary were accent colors. They must not
    // become the new workspace/sidebar backgrounds during normalization.
    primary: migrateLegacySurfaceColors ? fallback.primary : normalizeColor(source.primary, fallback.primary),
    secondary: migrateLegacySurfaceColors ? fallback.secondary : normalizeColor(source.secondary, fallback.secondary),
    button: normalizeColor(source.button, fallback.button),
    font: normalizeColor(source.font, fallback.font),
    success: normalizeColor(source.success, fallback.success),
    danger: normalizeColor(source.danger, fallback.danger),
    warning: normalizeColor(source.warning, fallback.warning),
    info: normalizeColor(source.info, fallback.info),
  }
}

export function normalizeThemeSettings(value: unknown): ThemeSettings {
  const source = value && typeof value === 'object' ? value as Partial<ThemeSettings> : {}
  const migrateLegacySurfaceColors = source.version !== 2
  return {
    version: 2,
    mode: source.mode === 'dark' ? 'dark' : 'light',
    light: normalizePalette(source.light, defaultThemeSettings.light, migrateLegacySurfaceColors),
    dark: normalizePalette(source.dark, defaultThemeSettings.dark, migrateLegacySurfaceColors),
  }
}

export function cloneThemeSettings(value: ThemeSettings): ThemeSettings {
  return {
    version: 2,
    mode: value.mode,
    light: { ...value.light },
    dark: { ...value.dark },
  }
}
