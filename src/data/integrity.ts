import type {
  CustomModuleFieldType,
  Resource,
  Store,
  WorldEngineChangeProposal,
  WorldEngineState,
} from '../types'

/**
 * A resource can be referenced by a card, a custom module index or a
 * World Engine observation. Removing the source card must not leave a
 * reference that looks valid to retrieval or to the Agent.
 */
export type IntegrityResourceCollection = 'world' | 'characters' | 'items' | 'skills'

export type DeletedResourceReference = Pick<Resource, 'id' | 'title'>

export type ReferenceCleanupReport = {
  collection: IntegrityResourceCollection
  removedId: string
  holdingReferences: number
  customModuleReferences: number
  worldEngineReferences: number
}

const customReferenceFieldTypes: Record<'characters' | 'items' | 'skills', CustomModuleFieldType> = {
  characters: 'characterIndex',
  items: 'itemIndex',
  skills: 'skillIndex',
}

function normalizedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function referenceValues(resource: DeletedResourceReference, remaining: readonly Resource[]): Set<string> {
  const values = new Set<string>()
  const id = normalizedText(resource.id)
  const title = normalizedText(resource.title)
  if (id) values.add(id)
  // Old stores sometimes kept a title in a holding/index array. Only treat
  // the title as a reference when no surviving card has the same title. This
  // avoids deleting a legacy reference that could still point to a duplicate.
  if (title && !remaining.some((item) => normalizedText(item.title) === title)) values.add(title)
  return values
}

function referencesAny(value: unknown, references: ReadonlySet<string>): boolean {
  return typeof value === 'string' && references.has(value.trim())
}

function filterStringReferences(values: unknown, references: ReadonlySet<string>): { values: string[]; removed: number } {
  if (!Array.isArray(values)) return { values: [], removed: 0 }
  const next: string[] = []
  let removed = 0
  for (const value of values) {
    if (typeof value !== 'string') continue
    if (references.has(value.trim())) {
      removed += 1
      continue
    }
    if (!next.includes(value)) next.push(value)
  }
  return { values: next, removed }
}

function removeCustomModuleReferences(
  store: Store,
  collection: 'characters' | 'items' | 'skills',
  references: ReadonlySet<string>,
): number {
  const customStore = store.customModules
  if (!customStore) return 0
  const expectedType = customReferenceFieldTypes[collection]
  let removed = 0
  for (const schema of customStore.schemas) {
    const indexedFields = schema.fields.filter((field) => field.type === expectedType)
    if (!indexedFields.length) continue
    for (const entry of customStore.entries) {
      if (entry.schemaId !== schema.id) continue
      for (const field of indexedFields) {
        const current = entry.data[field.key]
        const result = filterStringReferences(current, references)
        if (!Array.isArray(current) || result.removed === 0) continue
        entry.data[field.key] = result.values
        entry.updatedAt = Date.now()
        removed += result.removed
      }
    }
  }
  return removed
}

function changeReferencesDeletedCharacter(
  change: WorldEngineChangeProposal,
  references: ReadonlySet<string>,
): boolean {
  if (change.kind === 'relationship') {
    return referencesAny(change.patch.fromCharacterId, references)
      || referencesAny(change.patch.toCharacterId, references)
  }
  if (change.kind === 'character') {
    return referencesAny(change.targetId, references)
      || referencesAny(change.patch.characterId, references)
      || referencesAny(change.patch.id, references)
      || referencesAny(change.patch.name, references)
  }
  if (change.kind === 'event') {
    return Array.isArray(change.patch.actorIds)
      && change.patch.actorIds.some((value) => referencesAny(value, references))
  }
  return false
}

function cleanPendingCharacterChanges(
  worldEngine: WorldEngineState,
  references: ReadonlySet<string>,
  deletedRelationshipIds: ReadonlySet<string> = new Set(),
): number {
  let removed = 0
  for (const proposal of worldEngine.pendingProposals) {
    const originalLength = proposal.changes.length
    proposal.changes = proposal.changes.filter((change) => (
      !changeReferencesDeletedCharacter(change, references)
      && !(change.kind === 'relationship' && deletedRelationshipIds.has(change.targetId))
    ))
    removed += originalLength - proposal.changes.length
  }
  // A proposal with no remaining changes can no longer be applied. Dropping it
  // prevents the review queue from presenting an operation for a deleted card.
  const before = worldEngine.pendingProposals.length
  worldEngine.pendingProposals = worldEngine.pendingProposals.filter((proposal) => proposal.changes.length > 0)
  return removed + before - worldEngine.pendingProposals.length
}

function cleanWorldEngineCharacterReferences(
  worldEngine: WorldEngineState,
  references: ReadonlySet<string>,
): number {
  let removed = 0
  const previousStates = worldEngine.characterStates.length
  worldEngine.characterStates = worldEngine.characterStates.filter((state) => (
    !referencesAny(state.characterId, references)
      && !referencesAny(state.id, references)
      && !referencesAny(state.name, references)
  ))
  removed += previousStates - worldEngine.characterStates.length

  const deletedRelationshipIds = new Set(
    worldEngine.relationships
      .filter((relationship) => referencesAny(relationship.fromCharacterId, references)
        || referencesAny(relationship.toCharacterId, references))
      .map((relationship) => relationship.id),
  )
  const previousRelationships = worldEngine.relationships.length
  worldEngine.relationships = worldEngine.relationships.filter((relationship) => (
    !referencesAny(relationship.fromCharacterId, references)
      && !referencesAny(relationship.toCharacterId, references)
  ))
  removed += previousRelationships - worldEngine.relationships.length

  worldEngine.events = worldEngine.events.map((event) => {
    const result = filterStringReferences(event.actorIds, references)
    if (result.removed) {
      removed += result.removed
      return { ...event, actorIds: result.values, updatedAt: Date.now() }
    }
    return event
  })

  removed += cleanPendingCharacterChanges(worldEngine, references, deletedRelationshipIds)
  return removed
}

/**
 * Remove references to a deleted card from all structures that can point at
 * it. Call this after removing the card from its collection so duplicate-title
 * checks see the surviving cards.
 */
export function cleanupDeletedResourceReferences(
  store: Store,
  collection: IntegrityResourceCollection,
  removed: DeletedResourceReference,
): ReferenceCleanupReport {
  const remaining = (store[collection] as Resource[] | undefined) ?? []
  const references = referenceValues(removed, remaining)
  const report: ReferenceCleanupReport = {
    collection,
    removedId: removed.id,
    holdingReferences: 0,
    customModuleReferences: 0,
    worldEngineReferences: 0,
  }

  if (collection === 'items' || collection === 'skills') {
    const key = collection === 'items' ? 'holdingItems' : 'holdingSkills'
    for (const character of store.characters) {
      const result = filterStringReferences(character[key], references)
      if (!Array.isArray(character[key]) || result.removed === 0) continue
      character[key] = result.values
      report.holdingReferences += result.removed
    }
  }

  if (collection === 'characters' || collection === 'items' || collection === 'skills') {
    report.customModuleReferences = removeCustomModuleReferences(store, collection, references as ReadonlySet<string>)
  }

  const worldEngine = store.worldEngine
  if (worldEngine) {
    if (collection === 'characters') {
      report.worldEngineReferences = cleanWorldEngineCharacterReferences(worldEngine, references)
    }
    if (report.worldEngineReferences > 0) worldEngine.updatedAt = Date.now()
  }

  return report
}

