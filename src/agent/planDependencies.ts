import type { AgentOperation } from './schema.ts'

export type OperationDependency = {
  index: number
  reason: string
}

function customSchemaId(operation: AgentOperation): string {
  if (operation.action !== 'create_custom_module_entry'
    && operation.action !== 'update_custom_module_entry'
    && operation.action !== 'delete_custom_module_entry') return ''
  return (operation.schemaId ?? operation.moduleId ?? '').trim()
}

function findLatestBefore(
  operations: AgentOperation[],
  index: number,
  predicate: (operation: AgentOperation) => boolean,
): number {
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    if (predicate(operations[candidate])) return candidate
  }
  return -1
}

/**
 * Resolve dependencies created inside the same Agent plan.
 *
 * The desktop executor still validates the final subset. This helper keeps
 * the Agent and Console approval surfaces from selecting an invalid subset
 * when a later operation needs an earlier create operation.
 */
export function operationDependencies(operations: AgentOperation[], index: number): OperationDependency[] {
  const operation = operations[index]
  if (!operation) return []
  const dependencies: OperationDependency[] = []

  if (operation.action === 'create_custom_module_entry') {
    const schemaId = customSchemaId(operation)
    const schemaIndex = findLatestBefore(
      operations,
      index,
      (candidate) => candidate.action === 'create_custom_module'
        && Boolean(candidate.id?.trim())
        && candidate.id!.trim() === schemaId,
    )
    if (schemaIndex >= 0) dependencies.push({ index: schemaIndex, reason: '创建自定义模块条目需要先创建对应结构' })
  }

  if (operation.action === 'create_chapter' && !operation.volumeId) {
    const volumeIndex = findLatestBefore(operations, index, (candidate) => candidate.action === 'create_volume')
    if (volumeIndex >= 0) dependencies.push({ index: volumeIndex, reason: '章节未指定分卷，会使用计划中刚创建的分卷' })
  }

  if (
    (operation.action === 'create_resource' && operation.groupTarget)
    || (operation.action === 'move_resource_to_group' && operation.groupTarget)
  ) {
    const collection = operation.action === 'create_resource' ? (
      operation.resourceType === 'character' ? 'characters'
        : operation.resourceType === 'item' ? 'items'
          : operation.resourceType === 'skill' ? 'skills'
            : operation.resourceType === 'style' ? 'style'
              : operation.resourceType === 'world' ? 'world'
                : ''
    ) : operation.collection
    const target = operation.groupTarget?.trim()
    const groupIndex = findLatestBefore(
      operations,
      index,
      (candidate) => candidate.action === 'create_resource_group'
        && candidate.collection === collection
        && candidate.title.trim() === target,
    )
    if (groupIndex >= 0) dependencies.push({ index: groupIndex, reason: '条目目标折叠栏需要先创建' })
  }

  return dependencies
}

export function selectOperationIndexesWithDependencies(
  operations: AgentOperation[],
  selectedIndexes: readonly number[],
): number[] {
  const selected = new Set(selectedIndexes.filter((index) => Number.isInteger(index) && index >= 0 && index < operations.length))
  let changed = true
  while (changed) {
    changed = false
    for (const index of [...selected]) {
      for (const dependency of operationDependencies(operations, index)) {
        if (!selected.has(dependency.index)) {
          selected.add(dependency.index)
          changed = true
        }
      }
    }
  }
  return [...selected].sort((left, right) => left - right)
}

export function removeOperationIndexesWithDependents(
  operations: AgentOperation[],
  selectedIndexes: readonly number[],
  removedIndex: number,
): number[] {
  const selected = new Set(selectedIndexes.filter((index) => index !== removedIndex))
  let changed = true
  while (changed) {
    changed = false
    for (const index of [...selected]) {
      if (operationDependencies(operations, index).some((dependency) => !selected.has(dependency.index))) {
        selected.delete(index)
        changed = true
      }
    }
  }
  return [...selected].sort((left, right) => left - right)
}
