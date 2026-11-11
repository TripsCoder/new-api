/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { supplementReference } from './capability-supplement'
import { clone, modeFromDocument } from './configuration'
import { interfaceReference } from './document-interfaces'
import type { Catalog, Configuration, Mode } from './types'
import { effectiveMode } from './workflow'

type Section = 'parameters' | 'input' | 'mapping'
export type DocumentRefreshChange = {
  model: string
  mode: string
  section: Section
  field: string
  before: unknown
  after: unknown
}

export function documentedModel(catalog: Catalog, model: string, id: string) {
  const source = catalog.interfaces?.[id] ?? catalog.models[id]
  // A generic interface is not evidence for a new variant's model limits.
  if (
    source?.modelRules &&
    Object.keys(source.modelRules).length &&
    !source.modelRules[model]
  ) {
    return undefined
  }
  return interfaceReference(catalog, id, model)
}

// Construct a preview only. The caller must explicitly apply the candidate to
// the editor draft; the normal revision-checked save remains the only writer.
export function previewDocumentRefresh(
  document: Configuration,
  catalog: Catalog,
  models: string[],
  newGroupId: () => string = () => `refresh-${crypto.randomUUID()}`
) {
  const next = clone(document)
  const changes: DocumentRefreshChange[] = []
  const skipped: { model: string; mode: string }[] = []
  for (const model of new Set(models)) {
    const modes: Record<string, Mode> = {}
    let changed = false
    for (const key of Object.keys(document.bindings[model] ?? {})) {
      const before = effectiveMode(document, model, key)
      if (!before) continue
      const protocol = before.protocol
      let reference = protocol
        ? documentedModel(catalog, model, protocol.templateModel)
        : undefined
      if (!protocol && !catalog.interfaces) {
        reference = catalog.models[model]
      }
      if (!reference?.modes[key]) {
        skipped.push({ model, mode: key })
        modes[key] = clone(before)
        continue
      }
      const fresh = modeFromDocument(
        supplementReference(reference, protocol?.supplement),
        key
      )
      // Refresh parameter rules, mapping and defaults together, including
      // disabled modes. Preserve execution selection, permissions and pricing.
      const after: Mode = {
        ...clone(before),
        parameters: fresh.parameters,
        input: fresh.input,
        mapping: fresh.mapping,
        source: fresh.source,
      }
      modes[key] = after
      for (const section of ['parameters', 'input', 'mapping'] as const) {
        const oldFields = before[section] ?? {}
        const newFields = after[section] ?? {}
        for (const field of new Set([
          ...Object.keys(oldFields),
          ...Object.keys(newFields),
        ])) {
          if (
            JSON.stringify(oldFields[field]) ===
            JSON.stringify(newFields[field])
          ) {
            continue
          }
          changed = true
          changes.push({
            model,
            mode: key,
            section,
            field,
            before: oldFields[field],
            after: newFields[field],
          })
        }
      }
    }
    if (!changed) continue
    const id = newGroupId()
    if (next.groups[id]) throw new Error('Refresh group already exists')
    next.groups[id] = { name: model, modes }
    // Isolate the selected member instead of changing a shared group used by
    // models outside this preview. Old groups are retained for other members.
    for (const key of Object.keys(modes)) {
      next.bindings[model][key] = {
        ...clone(document.bindings[model][key]),
        groupId: id,
        parameters: {},
        input: {},
        mapping: {},
      }
    }
  }
  return { document: next, changes, skipped }
}
