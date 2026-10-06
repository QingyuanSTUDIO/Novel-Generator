import type { Chapter, OutlineNodeType, Resource } from '../types'

export const outlineNodeTypes: readonly OutlineNodeType[] = ['book', 'volume', 'chapterRange', 'scene']

export type OutlineDeleteStrategy = 'promote' | 'cascade'

export type OutlineDeleteResult = {
  nodes: Resource[]
  removedIds: string[]
  promotedIds: string[]
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized || undefined
}

function outlineParentAccepts(childType: OutlineNodeType, parentType: OutlineNodeType) {
  if (childType === 'book') return false
  if (childType === 'volume') return parentType === 'book'
  if (childType === 'chapterRange') return parentType === 'volume' || parentType === 'book'
  return parentType === 'chapterRange' || parentType === 'volume'
}

/**
 * Return all descendants in stable store order. The visited set also makes
 * deletion safe when a malformed store contains a parent cycle.
 */
export function outlineDescendantIds(nodes: readonly Resource[], rootId: string): string[] {
  const childrenByParent = new Map<string, Resource[]>()
  for (const node of nodes) {
    const parentId = nonEmptyString(node.outlineParentId)
    if (!parentId) continue
    const children = childrenByParent.get(parentId) ?? []
    children.push(node)
    childrenByParent.set(parentId, children)
  }
  const descendants: string[] = []
  const visited = new Set<string>([rootId])
  const visit = (parentId: string) => {
    for (const child of childrenByParent.get(parentId) ?? []) {
      if (visited.has(child.id)) continue
      visited.add(child.id)
      descendants.push(child.id)
      visit(child.id)
    }
  }
  visit(rootId)
  return descendants
}

/**
 * Delete one outline node while making the author's hierarchy choice
 * explicit. Promoting only reparents direct children; their descendants stay
 * attached to them. If the removed node's parent cannot accept a child type,
 * the promoted child becomes a root instead of receiving an invalid parent.
 */
export function removeOutlineNode(
  nodes: readonly Resource[],
  rootId: string,
  strategy: OutlineDeleteStrategy,
): OutlineDeleteResult {
  const target = nodes.find((node) => node.id === rootId)
  if (!target) return { nodes: [...nodes], removedIds: [], promotedIds: [] }

  const descendants = outlineDescendantIds(nodes, rootId)
  const directChildren = nodes.filter((node) => node.outlineParentId === rootId)
  const parentId = nonEmptyString(target.outlineParentId)
  const parent = parentId ? nodes.find((node) => node.id === parentId) : undefined
  const removedIds = strategy === 'cascade' ? [rootId, ...descendants] : [rootId]
  const removedSet = new Set(removedIds)
  const promotedIds: string[] = []

  const nextNodes = nodes
    .filter((node) => !removedSet.has(node.id))
    .map((node) => {
      if (strategy !== 'promote' || !directChildren.some((child) => child.id === node.id)) {
        return { ...node }
      }
      const next = { ...node }
      const childType = next.outlineType ?? 'chapterRange'
      const parentType = parent?.outlineType
      if (parentId && parent && parentType && outlineParentAccepts(childType, parentType)) {
        next.outlineParentId = parentId
      } else {
        delete next.outlineParentId
      }
      promotedIds.push(next.id)
      return next
    })

  // Keep the result deterministic even if malformed input contains a child
  // whose ID appears more than once.
  return {
    nodes: nextNodes,
    removedIds: [...new Set(removedIds)],
    promotedIds: [...new Set(promotedIds)],
  }
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
