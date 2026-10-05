import type { Chapter, OutlineNodeType, Resource } from '../types'

export const outlineNodeTypes: readonly OutlineNodeType[] = ['book', 'volume', 'chapterRange', 'scene']

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized || undefined
}

/**
 * Repair outline metadata at persistence boundaries.
 *
 * Outline nodes are ordinary resources, so older stores and model responses
 * can contain missing, dangling, or cyclic hierarchy fields. Invalid links
 * are removed instead of being rendered as a misleading tree. The function
 * returns fresh resource objects and leaves the caller's input untouched.
 */
export function normalizeOutlineNodes(
  nodes: readonly Resource[] = [],
  chapters: readonly Chapter[] = [],
): Resource[] {
  const ids = new Set(nodes.map((node) => node.id))
  const chapterIds = new Set(chapters.map((chapter) => chapter.id))
  const normalized = nodes.map((node) => {
    const next: Resource = { ...node }
    if (!outlineNodeTypes.includes(next.outlineType as OutlineNodeType)) {
      delete next.outlineType
    }

    const parentId = nonEmptyString(next.outlineParentId)
    if (!parentId || parentId === next.id || !ids.has(parentId)) delete next.outlineParentId
    else next.outlineParentId = parentId

    for (const key of ['outlineStartChapterId', 'outlineEndChapterId'] as const) {
      const chapterId = nonEmptyString(next[key])
      if (!chapterId || !chapterIds.has(chapterId)) delete next[key]
      else next[key] = chapterId
    }

    if (typeof next.outlineCollapsed !== 'boolean') delete next.outlineCollapsed
    return next
  })

  const byId = new Map(normalized.map((node) => [node.id, node]))
  const createsCycle = (nodeId: string, parentId: string) => {
    const seen = new Set<string>()
    let cursor: string | undefined = parentId
    while (cursor && !seen.has(cursor)) {
      if (cursor === nodeId) return true
      seen.add(cursor)
      cursor = byId.get(cursor)?.outlineParentId
    }
    return false
  }

  // Break cycles at the edge that closes the loop. This preserves the earlier
  // parent links in store order and leaves the remainder of the tree usable.
  for (const start of normalized) {
    const path: string[] = []
    const indexById = new Map<string, number>()
    let cursor: string | undefined = start.id
    while (cursor && !indexById.has(cursor)) {
      indexById.set(cursor, path.length)
      path.push(cursor)
      cursor = byId.get(cursor)?.outlineParentId
    }
    if (!cursor) continue
    const cycleStart = indexById.get(cursor)
    if (cycleStart === undefined) continue
    const cycle = path.slice(cycleStart)
    const closingNodeId = cycle[cycle.length - 1]
    const closingNode = byId.get(closingNodeId)
    if (closingNode) delete closingNode.outlineParentId
  }
  return normalized
}
