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
import {
  clone,
  merge,
  modeFromDocument,
  retainRequiredParameters,
} from './configuration'
import type { Catalog, Configuration, Mode } from './types'

export { relevantParameter } from './configuration'

export const IMAGE_MODES = ['text_image', 'edit_image']
export const VIDEO_MODES = [
  'text_video',
  'image_video',
  'frames',
  'video_ref',
  'audio_ref',
  'mixed_ref',
]
export function missingExisting(
  returned: string[],
  existing: string[],
  loaded: boolean
): string[] {
  return loaded ? existing.filter((name) => !returned.includes(name)) : []
}
export function effectiveMode(
  document: Configuration,
  model: string,
  key: string
): Mode | undefined {
  const binding = document.bindings[model]?.[key]
  const shared = binding && document.groups[binding.groupId]?.modes[key]
  if (!shared || !binding) return undefined
  return {
    ...clone(shared),
    capabilities: clone(binding.capabilities ?? shared.capabilities),
    enabled: shared.enabled && binding.enabled !== false,
    input: merge(shared.input, binding.input ?? {}),
    parameters: { ...shared.parameters, ...binding.parameters },
    mapping: { ...shared.mapping, ...binding.mapping },
    protocol: clone(binding.protocol ?? shared.protocol),
    cost: clone(binding.cost ?? shared.cost),
    billing: clone(binding.billing ?? shared.billing),
  }
}
export function applyModeChoice(
  document: Configuration,
  catalog: Catalog,
  selected: string[],
  groupId: string,
  key: string,
  enabled: boolean
): Configuration {
  const next = clone(document)
  const shared = next.groups[groupId]
  if (!shared) return next
  if (!shared.modes[key]) {
    shared.modes[key] = {
      strictMapping: true,
      enabled,
      input: {},
      parameters: {},
      mapping: {},
      cost: { amount: null, confirmed: false },
    }
  }
  if (!enabled && isCapabilitySubsetLocked(document, catalog, selected, key)) {
    return next
  }
  shared.modes[key].enabled = enabled
  if (enabled && key === 'edit_image') {
    for (const subset of ['text_image']) {
      const supported = selected.filter(
        (name) => catalog.models[name]?.modes[subset]
      )
      if (!supported.length) continue
      if (!shared.modes[subset]) {
        shared.modes[subset] = {
          enabled: true,
          input: {},
          parameters: {},
          mapping: {},
          cost: { amount: null, confirmed: false },
        }
      }
      shared.modes[subset].enabled = true
      for (const name of supported) {
        const previous = next.bindings[name]?.[subset]
        const source = modeFromDocument(catalog.models[name], subset)
        next.bindings[name] ??= {}
        next.bindings[name][subset] = previous
          ? { ...previous, enabled: true }
          : {
              groupId,
              enabled: true,
              input: source.input,
              parameters: source.parameters,
              mapping: source.mapping,
              protocol: source.protocol,
              cost: source.cost,
            }
      }
    }
  }
  for (const model of selected) {
    const existing = next.bindings[model]?.[key]
    next.bindings[model] ??= {}
    if (!existing) {
      const source = catalog.models[model]?.modes[key]
        ? modeFromDocument(catalog.models[model], key)
        : {
            input: {},
            parameters: {},
            mapping: {},
            cost: { amount: null, confirmed: false },
            billing: undefined,
          }
      next.bindings[model][key] = {
        groupId,
        input: source.input,
        parameters: source.parameters,
        mapping: source.mapping,
        protocol: 'protocol' in source ? source.protocol : undefined,
        cost: source.cost,
        billing: source.billing,
        enabled,
      }
    } else next.bindings[model][key] = { ...existing, enabled }
  }
  return next
}
export function configurationImpact(
  baseline: Configuration,
  draft: Configuration
): string[] {
  return [
    ...new Set([
      ...Object.keys(baseline.bindings),
      ...Object.keys(draft.bindings),
    ]),
  ].filter((model) => {
    const keys = new Set([
      ...Object.keys(baseline.bindings[model] ?? {}),
      ...Object.keys(draft.bindings[model] ?? {}),
    ])
    return [...keys].some(
      (key) =>
        JSON.stringify(effectiveMode(baseline, model, key)) !==
        JSON.stringify(effectiveMode(draft, model, key))
    )
  })
}

// An individual form edits only changed fields. Unedited inherited values must
// never become an override just because the full effective form was displayed.
export function applyIndividualFields(
  document: Configuration,
  model: string,
  key: string,
  edited: Mode
): Configuration {
  const next = clone(document)
  const binding = next.bindings[model]?.[key]
  const before = effectiveMode(document, model, key)
  if (!binding || !before) return next
  edited = retainRequiredParameters(before, edited)
  const shared = document.groups[binding.groupId].modes[key]
  for (const section of ['input', 'parameters', 'mapping'] as const) {
    const prior = before[section] ?? {}
    const after = edited[section] ?? {}
    const inherited = shared[section] ?? {}
    const patch: Record<string, unknown> = { ...binding[section] }
    for (const field of new Set([
      ...Object.keys(prior),
      ...Object.keys(after),
    ])) {
      if (JSON.stringify(prior[field]) === JSON.stringify(after[field])) {
        continue
      }
      if (
        !Object.hasOwn(after, field) ||
        JSON.stringify(after[field]) === JSON.stringify(inherited[field])
      ) {
        delete patch[field]
      } else patch[field] = clone(after[field])
    }
    if (section === 'input') binding.input = patch
    else if (section === 'parameters') {
      binding.parameters = patch as Mode['parameters']
    } else binding.mapping = patch as Record<string, string>
  }
  return next
}

export function isCapabilitySubsetLocked(
  document: Configuration,
  catalog: Catalog,
  models: string[],
  key: string
): boolean {
  if (key !== 'text_image') return false
  return models.some((name) => {
    if (!catalog.models[name]?.modes[key] && !document.bindings[name]?.[key]) {
      return false
    }
    return !!effectiveMode(document, name, 'edit_image')?.enabled
  })
}
export function documentedReferenceSupport(
  catalog: Catalog,
  name: string,
  field: string
): boolean {
  const modes = catalog.models[name]?.modes ?? {}
  if (field === 'images') {
    return !!(modes.image_video || modes.frames || modes.edit_image)
  }
  if (field === 'videos') return !!modes.video_ref
  if (field === 'audios') return !!modes.audio_ref
  return false
}

export const VIDEO_CAPABILITY_VIEWS = [
  'text_video',
  'first_frame',
  'frames',
  'image_video',
  'video_ref',
  'audio_ref',
]
export function capabilityMode(key: string): string {
  return key === 'first_frame' ? 'frames' : key
}
export function applyIndependentCapability(
  document: Configuration,
  catalog: Catalog,
  models: string[],
  groupId: string,
  key: string,
  enabled: boolean
): Configuration {
  const actual = capabilityMode(key)
  const next = applyModeChoice(
    document,
    catalog,
    models,
    groupId,
    actual,
    enabled
  )
  if ((key === 'first_frame' || key === 'frames') && enabled) {
    const firstOnly = key === 'first_frame'
    for (const model of models) {
      const binding = next.bindings[model]?.frames
      if (!binding) continue
      const documented = catalog.models[model]
      const original = documented?.modes.frames
        ? modeFromDocument(documented, 'frames')
        : undefined
      binding.mapping = { ...binding.mapping }
      for (const field of ['end_image_url', 'last_frame']) {
        if (firstOnly) binding.mapping[field] = '@reject'
        else if (original?.mapping?.[field]) {
          binding.mapping[field] = original.mapping[field]
        } else delete binding.mapping[field]
      }
    }
  }
  // Combined video+audio is an internal request classification, not an extra UI choice.
  const combined = models.filter(
    (name) =>
      catalog.models[name]?.modes.mixed_ref &&
      effectiveMode(next, name, 'video_ref')?.enabled &&
      effectiveMode(next, name, 'audio_ref')?.enabled
  )
  const existingMixed = next.groups[groupId].modes.mixed_ref
  if (combined.length) {
    next.groups[groupId].modes.mixed_ref ??= {
      enabled: true,
      input: {},
      parameters: {},
      mapping: {},
      cost: { amount: null, confirmed: false },
    }
    next.groups[groupId].modes.mixed_ref.enabled = true
    for (const name of combined) {
      const reference = modeFromDocument(catalog.models[name], 'mixed_ref')
      next.bindings[name].mixed_ref ??= {
        groupId,
        input: reference.input,
        parameters: reference.parameters,
        mapping: reference.mapping,
        protocol: reference.protocol,
        cost: reference.cost,
      }
      next.bindings[name].mixed_ref.enabled = true
    }
  } else if (existingMixed) {
    next.groups[groupId].modes.mixed_ref.enabled = false
  }
  for (const name of models) {
    const frame = effectiveMode(next, name, 'frames')
    const first = !!frame?.enabled
    const last =
      first && next.bindings[name]?.frames?.mapping?.end_image_url !== '@reject'
    const allowed = {
      images: !!effectiveMode(next, name, 'image_video')?.enabled || first,
      videos: !!effectiveMode(next, name, 'video_ref')?.enabled,
      audios: !!effectiveMode(next, name, 'audio_ref')?.enabled,
      firstFrame: first,
      lastFrame: last,
    }
    for (const [mode, binding] of Object.entries(next.bindings[name] ?? {})) {
      if (!mode.endsWith('image')) binding.capabilities = clone(allowed)
    }
  }
  return next
}

export function capabilityEnabled(
  document: Configuration,
  models: string[],
  groupId: string,
  key: string
): boolean {
  const mode = document.groups[groupId]?.modes[capabilityMode(key)]
  if (!mode?.enabled) return false
  if (key === 'first_frame' || key === 'frames') {
    return models.some((name) => {
      if (!effectiveMode(document, name, 'frames')?.enabled) return false
      const firstOnly =
        document.bindings[name]?.frames?.mapping?.end_image_url === '@reject'
      return key === 'first_frame' ? firstOnly : !firstOnly
    })
  }
  return true
}
