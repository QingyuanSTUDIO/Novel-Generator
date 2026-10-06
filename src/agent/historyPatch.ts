import type { AgentHistoryPatchOperation } from '../types'

type JsonObject = Record<string, unknown>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== typeof right || left === null || right === null) return false
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => equal(item, right[index]))
  }
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => hasOwn(right, key) && equal(left[key], right[key]))
  }
  return false
}

function escapePointerSegment(value: string) {
  return value.replace(/~/g, '~0').replace(/\//g, '~1')
}

function unescapePointerSegment(value: string) {
  return value.replace(/~1/g, '/').replace(/~0/g, '~')
}

function joinPath(path: string, segment: string | number) {
  return `${path}/${escapePointerSegment(String(segment))}`
}

function identifiedArray(value: unknown): value is Array<JsonObject & { id: string }> {
  if (!Array.isArray(value) || value.some((item) => !isObject(item) || typeof item.id !== 'string' || !item.id)) return false
  const ids = value.map((item) => item.id as string)
  return new Set(ids).size === ids.length
}

/**
 * Build operations which turn `after` back into `before`.
 *
 * Arrays containing stable `id` values are edited item-by-item when possible,
 * so adding one chapter/resource does not duplicate every other chapter in a
 * persisted history record. Arrays whose order changed are replaced as a
 * whole because JSON Patch has no native move operation in our compact
 * contract.
 */
function diffInverse(before: unknown, after: unknown, path: string, output: AgentHistoryPatchOperation[]) {
  if (equal(before, after)) return

  if (identifiedArray(before) && identifiedArray(after)) {
    const beforeIds = before.map((item) => item.id)
    const afterIds = after.map((item) => item.id)
    const beforeSet = new Set(beforeIds)
    const afterSet = new Set(afterIds)
    const commonBeforeIds = beforeIds.filter((id) => afterSet.has(id))
    const commonAfterIds = afterIds.filter((id) => beforeSet.has(id))

    // Remove entries that exist only in the post-change state. Work from the
    // end so subsequent indices remain valid while applying the inverse.
    const working = [...afterIds]
    for (let index = working.length - 1; index >= 0; index -= 1) {
      if (beforeSet.has(working[index])) continue
      output.push({ op: 'remove', path: joinPath(path, index) })
      working.splice(index, 1)
    }

    // If common entries changed relative order, use one replace operation.
    // This keeps patch application deterministic and avoids a second move
    // operation type in persisted data.
    if (!equal(commonBeforeIds, commonAfterIds)) {
      output.push({ op: 'replace', path, value: clone(before) })
      return
    }

    // Insert entries that only existed before the change at their original
    // positions. At this point `working` contains common IDs in before order.
    for (let index = 0; index < before.length; index += 1) {
      const item = before[index]
      if (working[index] === item.id) continue
      output.push({ op: 'add', path: joinPath(path, index), value: clone(item) })
      working.splice(index, 0, item.id)
    }

    const afterById = new Map(after.map((item) => [item.id, item]))
    for (let index = 0; index < before.length; index += 1) {
      const beforeItem = before[index]
      if (!afterSet.has(beforeItem.id)) continue
      diffInverse(beforeItem, afterById.get(beforeItem.id), joinPath(path, index), output)
    }
    return
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      output.push({ op: 'replace', path, value: clone(before) })
      return
    }
    before.forEach((item, index) => diffInverse(item, after[index], joinPath(path, index), output))
    return
  }

  if (isObject(before) && isObject(after)) {
    for (const key of Object.keys(after)) {
      if (!hasOwn(before, key)) output.push({ op: 'remove', path: joinPath(path, key) })
    }
    for (const key of Object.keys(before)) {
      if (!hasOwn(after, key)) {
        output.push({ op: 'add', path: joinPath(path, key), value: clone(before[key]) })
        continue
      }
      diffInverse(before[key], after[key], joinPath(path, key), output)
    }
    return
  }

  output.push({ op: 'replace', path, value: clone(before) })
}

/**
 * Return a compact inverse patch for two JSON-compatible Agent snapshots.
 * Applying the result to `after` reconstructs `before`.
 */
export function createInverseHistoryPatch(before: unknown, after: unknown): AgentHistoryPatchOperation[] {
  const output: AgentHistoryPatchOperation[] = []
  diffInverse(before, after, '', output)
  return output
}

function pointerSegments(path: string) {
  if (!path) return []
  if (!path.startsWith('/')) throw new Error(`无效的历史 patch 路径：${path}`)
  return path.slice(1).split('/').map(unescapePointerSegment)
}

function asArrayIndex(value: string, length: number, allowEnd = false) {
  if (value === '-' && allowEnd) return length
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`无效的历史 patch 数组索引：${value}`)
  const index = Number(value)
  if (!Number.isSafeInteger(index) || index < 0 || (allowEnd ? index > length : index >= length)) {
    throw new Error(`历史 patch 数组索引越界：${value}`)
  }
  return index
}

/**
 * Apply an inverse history patch to a JSON-compatible snapshot.
 *
 * The input is cloned and never mutated. Invalid paths throw so callers can
 * fall back to a legacy full snapshot instead of silently corrupting work.
 */
export function applyHistoryPatch<T>(target: T, patch: AgentHistoryPatchOperation[]): T {
  const root: unknown = clone(target)
  let result = root
  for (const operation of patch) {
    const segments = pointerSegments(operation.path)
    if (!segments.length) {
      if (operation.op === 'remove') throw new Error('历史 patch 不允许删除根快照')
      if (operation.value === undefined) throw new Error('历史 patch 缺少根值')
      result = clone(operation.value)
      continue
    }
    let parent: unknown = result
    for (const segment of segments.slice(0, -1)) {
      if (Array.isArray(parent)) parent = parent[asArrayIndex(segment, parent.length)]
      else if (isObject(parent) && hasOwn(parent, segment)) parent = parent[segment]
      else throw new Error(`历史 patch 路径不存在：${operation.path}`)
    }
    const key = segments[segments.length - 1]!
    if (Array.isArray(parent)) {
      const index = asArrayIndex(key, parent.length, operation.op === 'add')
      if (operation.op === 'remove') parent.splice(index, 1)
      else if (operation.op === 'add') {
        if (operation.value === undefined) throw new Error(`历史 patch 缺少值：${operation.path}`)
        parent.splice(index, 0, clone(operation.value))
      } else {
        if (operation.value === undefined) throw new Error(`历史 patch 缺少值：${operation.path}`)
        parent[index] = clone(operation.value)
      }
      continue
    }
    if (!isObject(parent)) throw new Error(`历史 patch 父路径不可写：${operation.path}`)
    if (operation.op === 'remove') {
      if (!hasOwn(parent, key)) throw new Error(`历史 patch 路径不存在：${operation.path}`)
      delete parent[key]
    } else {
      if (operation.value === undefined) throw new Error(`历史 patch 缺少值：${operation.path}`)
      parent[key] = clone(operation.value)
    }
  }
  return result as T
}

