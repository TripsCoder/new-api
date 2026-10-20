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
import { clone, modeFromDocument } from './configuration'
import type {
  CapabilitySupplement,
  Catalog,
  CatalogModel,
  Configuration,
} from './types'

export function supplementReference(
  reference: CatalogModel,
  supplements?: Record<string, CapabilitySupplement>
): CatalogModel {
  if (!supplements || !Object.keys(supplements).length) return reference
  const next = clone(reference)
  for (const [mode, supplement] of Object.entries(supplements)) {
    next.modes[mode] ??= { required: [] }
    for (const [field, value] of Object.entries(supplement.fields)) {
      if (next.parameters[field]) continue
      const frame = field === 'start_image_url' || field === 'end_image_url'
      const items =
        value.shape === 'objects'
          ? {
              type: 'object',
              properties: { url: { type: 'string' } },
              required: ['url'],
            }
          : { type: 'string' }
      next.parameters[field] = {
        type: frame ? 'string' : 'array',
        required: false,
        description: supplement.note,
        definition: {
          type: frame ? 'string' : 'array',
          ...(!frame
            ? { items, ...(value.maxItems ? { maxItems: value.maxItems } : {}) }
            : {}),
          'x-channel-parameter': {
            vendorFields: [value.vendor],
            capabilities: [mode],
            requiredIn: [],
            status: 'manual-supplement',
          },
        },
      }
      next.mapping = { ...next.mapping, [field]: field }
    }
    if (mode === 'frames') {
      next.capabilities = {
        ...next.capabilities,
        firstFrame: true,
        lastFrame: !!supplement.fields.end_image_url,
        multipleReferences: true,
      }
    }
  }
  return next
}

export function applyCapabilitySupplement(
  document: Configuration,
  catalog: Catalog,
  models: string[],
  groupId: string,
  modeKey: string,
  supplement: CapabilitySupplement
): Configuration {
  const next = clone(document)
  for (const name of models) {
    const bindings = (next.bindings[name] ??= {})
    const protocol = Object.entries(bindings).find(
      ([key, binding]) =>
        key.endsWith('image') === modeKey.endsWith('image') && binding.protocol
    )?.[1].protocol
    const templateModel =
      protocol?.templateModel ?? catalog.models[name]?.interfaceId
    if (!templateModel) continue
    const reference = catalog.interfaces?.[templateModel]
    if (!reference) continue
    const supplements = { ...protocol?.supplement, [modeKey]: supplement }
    const projected = supplementReference(
      {
        ...reference,
        ...reference.modelRules?.[name],
        id: name,
        interfaceId: templateModel,
      },
      supplements
    )
    const mode = modeFromDocument(projected, modeKey)
    next.groups[groupId].modes[modeKey] ??= {
      enabled: true,
      input: {},
      parameters: {},
      mapping: {},
      cost: { amount: null, confirmed: false },
    }
    next.groups[groupId].modes[modeKey].enabled = true
    bindings[modeKey] = {
      ...bindings[modeKey],
      groupId,
      enabled: true,
      input: mode.input,
      parameters: mode.parameters,
      mapping: mode.mapping,
    }
    for (const [key, binding] of Object.entries(bindings)) {
      if (key.endsWith('image') !== modeKey.endsWith('image')) continue
      binding.protocol = {
        templateModel,
        confirmed: protocol?.confirmed ?? false,
        supplement: supplements,
      }
      binding.capabilities = {
        images: false,
        videos: false,
        audios: false,
        ...binding.capabilities,
        ...{
          image_video: { images: true },
          edit_image: { images: true },
          video_ref: { videos: true },
          audio_ref: { audios: true },
          frames: {
            images: true,
            firstFrame: true,
            lastFrame: !!supplement.fields.end_image_url,
          },
        }[modeKey],
      }
    }
  }
  return next
}
