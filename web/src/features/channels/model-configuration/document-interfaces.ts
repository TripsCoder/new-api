import { supplementReference } from './capability-supplement'
import {
  clone,
  createSharedGroup,
  modeFromDocument,
  requiredParameter,
} from './configuration'
import type { Catalog, CatalogModel, Configuration } from './types'
import { effectiveMode } from './workflow'

// The projection uses only real discovery/selected persisted IDs. Document
// examples never become selectable models or templates for another model.
export function projectDocumentInterfaces(
  catalog: Catalog | undefined,
  models: string[],
  kind: 'image' | 'video',
  document?: Configuration | null
): Catalog | undefined {
  if (!catalog?.interfaces) return catalog
  const actual: Record<string, CatalogModel> = {}
  const fallback = Object.values(catalog.interfaces).find(
    (entry) => entry.kind === kind
  )
  for (const name of models) {
    const selected = Object.values(document?.bindings[name] ?? {})
      .map(
        (binding) => catalog.interfaces?.[binding.protocol?.templateModel ?? '']
      )
      .find((entry) => entry?.kind === kind)
    // YuxiBox publishes several video request tables. An exact documented ID
    // can select its table; a saved operator selection still takes precedence.
    const documented =
      catalog.key === 'yuxibox_media'
        ? Object.values(catalog.interfaces).find(
            (entry) => entry.kind === kind && entry.modelRules?.[name]
          )
        : undefined
    const reference = selected ?? documented ?? fallback
    if (reference) {
      actual[name] = supplementReference(
        {
          ...structuredClone(reference),
          ...structuredClone(reference.modelRules?.[name] ?? {}),
          id: name,
          interfaceId: reference.id,
        },
        Object.values(document?.bindings[name] ?? {}).find(
          (binding) =>
            binding.protocol?.templateModel === reference.id &&
            binding.protocol?.supplement
        )?.protocol?.supplement
      )
    }
  }
  return { ...catalog, models: actual }
}

export function interfaceReference(
  catalog: Catalog,
  id: string,
  model?: string
): CatalogModel | undefined {
  const reference = catalog.interfaces?.[id] ?? catalog.models[id]
  if (!reference || !model || !catalog.interfaces?.[id]) return reference
  return {
    ...reference,
    ...reference.modelRules?.[model],
    id: model,
    interfaceId: id,
  }
}

export function applyDocumentInterface(
  document: Configuration,
  catalog: Catalog,
  models: string[],
  groupId: string,
  interfaceId: string
): Configuration {
  const template = catalog.interfaces?.[interfaceId]
  if (!template) return document
  const next = clone(document)
  const members = Object.keys(next.bindings).filter((name) =>
    Object.values(next.bindings[name]).some(
      (binding) => binding.groupId === groupId
    )
  )
  const entireGroup = members.every((name) => models.includes(name))
  const id = entireGroup ? groupId : `interface-${crypto.randomUUID()}`
  next.groups[id] = {
    name: template.title ?? 'Shared configuration',
    modes: {},
  }
  const base = template.kind === 'image' ? 'text_image' : 'text_video'
  for (const name of models) {
    const previousProtocol = Object.values(document.bindings[name] ?? {}).find(
      (binding) => binding.protocol?.templateModel === interfaceId
    )?.protocol
    const reference = supplementReference(
      {
        ...template,
        ...template.modelRules?.[name],
        id: name,
        interfaceId,
      },
      previousProtocol?.supplement
    )
    next.bindings[name] ??= {}
    for (const key of Object.keys(next.bindings[name])) {
      if (key.endsWith('image') === (template.kind === 'image')) {
        delete next.bindings[name][key]
      }
    }
    for (const key of Object.keys(reference.modes)) {
      const old = effectiveMode(document, name, key)
      const mode = modeFromDocument(reference, key)
      mode.enabled =
        old?.enabled ??
        (key === base ||
          (!reference.modes[base] && key === Object.keys(reference.modes)[0]))
      const allowed = (field: string) =>
        Object.hasOwn(mode.parameters ?? {}, field)
      mode.input = Object.fromEntries(
        Object.entries(old?.input ?? {}).filter(([field]) => allowed(field))
      )
      mode.mapping = {
        ...mode.mapping,
        ...Object.fromEntries(
          Object.entries(old?.mapping ?? {}).filter(
            ([field]) => allowed(field) && !requiredParameter(mode, field)
          )
        ),
      }
      next.groups[id].modes[key] ??= {
        ...clone(mode),
        input: {},
        parameters: {},
        mapping: {},
      }
      next.bindings[name][key] = {
        groupId: id,
        enabled: mode.enabled,
        input: mode.input,
        parameters: mode.parameters,
        mapping: mode.mapping,
        protocol: mode.protocol
          ? { ...mode.protocol, supplement: previousProtocol?.supplement }
          : undefined,
        capabilities: clone(old?.capabilities),
        cost: clone(old?.cost ?? mode.cost),
        billing: clone(old?.billing),
        pricing: clone(document.bindings[name]?.[key]?.pricing),
      }
    }
  }
  return createSharedGroup(
    next,
    projectDocumentInterfaces(
      catalog,
      models,
      template.kind === 'image' ? 'image' : 'video',
      next
    ) ?? catalog,
    models,
    id
  )
}
