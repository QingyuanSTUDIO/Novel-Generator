import type { Resource } from '../types.ts'

export function normalizeResourceReviewMetadata(resource: Resource): Resource {
  const legacyParts = String(resource.tag ?? '').split(/[·|｜]/).map((part) => part.trim()).filter(Boolean)
  const legacySource = legacyParts.includes('Agent 创建')
    ? 'agent'
    : legacyParts.includes('手动创建') ? 'manual' : undefined
  const legacyReviewStatus = legacyParts.includes('完成')
    ? 'complete'
    : legacyParts.includes('待修改') ? 'pending' : undefined
  const tagParts = legacyParts.filter((part) => !['Agent 创建', '手动创建', '待修改', '完成'].includes(part))
  const normalized: Resource = {
    ...resource,
    tag: tagParts.join(' · '),
    creationSource: resource.creationSource === 'agent' || resource.creationSource === 'manual'
      ? resource.creationSource
      : legacySource ?? 'manual',
    reviewStatus: resource.reviewStatus === 'complete' || resource.reviewStatus === 'pending'
      ? resource.reviewStatus
      : legacyReviewStatus ?? 'pending',
    reviewStatusLocked: resource.reviewStatusLocked === true,
    ...(typeof resource.reviewStatusLockedBeforeAll === 'boolean'
      ? { reviewStatusLockedBeforeAll: resource.reviewStatusLockedBeforeAll }
      : {}),
    lockedAll: resource.lockedAll === true,
    lockedFields: Array.isArray(resource.lockedFields)
      ? [...new Set(resource.lockedFields.filter((field) => typeof field === 'string' && field.trim()).map((field) => field.trim()))]
      : [],
  }
  if (normalized.lockedAll) setResourceLockAll(normalized, true)
  return normalized
}

export function setResourceLockAll(resource: Resource, locked: boolean) {
  if (locked) {
    // Capture the author's previous review lock only when entering the
    // aggregate lock. While `lockedAll` is active the status lock must appear
    // enabled, but releasing the aggregate lock must restore this value.
    if (resource.lockedAll !== true) {
      resource.reviewStatusLockedBeforeAll = resource.reviewStatusLocked === true
    }
    resource.lockedAll = true
    resource.reviewStatusLocked = true
  } else {
    resource.lockedAll = false
    resource.reviewStatusLocked = resource.reviewStatusLockedBeforeAll === true
    delete resource.reviewStatusLockedBeforeAll
  }
  // `lockedAll` is an aggregate switch. Keep the author's individual field
  // locks intact so unlocking the entry restores the exact previous state.
  // UI and Agent checks treat `lockedAll` as locking every editable field.
  resource.lockedFields = [...new Set((resource.lockedFields ?? [])
    .filter((field): field is string => typeof field === 'string' && Boolean(field.trim()))
    .map((field) => field.trim()))]
}
