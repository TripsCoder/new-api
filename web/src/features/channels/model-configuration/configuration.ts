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
import type {
  Catalog,
  CatalogModel,
  Configuration,
  Mode,
  Parameter,
  Source,
} from './types'

const unsafe =
  /^(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|credential|cookie|__proto__|prototype|constructor)$/i
export function numericParameter(parameter?: Parameter): boolean {
  return (
    parameter?.type === 'integer' ||
    parameter?.type === 'number' ||
    (Array.isArray(parameter?.definition?.anyOf) &&
      parameter.definition.anyOf.some(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          ['integer', 'number'].includes(String(entry.type))
      ))
  )
}
// The existing execution validator enforces enum for both JSON number and
// numeric-string inputs. Encode a bounded integer interval without changing
// the documented union or its supplier wire representation.
export function integerRangeChoices(
  parameter: Parameter
): unknown[] | undefined {
  if (parameter.type || !numericParameter(parameter)) return undefined
  const minimum = parameter.minimum ?? parameter.definition?.minimum
  const maximum = parameter.maximum ?? parameter.definition?.maximum
  if (
    typeof minimum !== 'number' ||
    typeof maximum !== 'number' ||
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    minimum > maximum ||
    maximum - minimum > 10000
  ) {
    return undefined
  }
  return Array.from(
    { length: maximum - minimum + 1 },
    (_, index) => minimum + index
  ).flatMap((value) => [value, String(value)])
}
export function parseSafe(text: string): unknown {
  if (text.length > 1000000) throw new Error('JSON file exceeds 1 MB')
  let count = 0
  let value: unknown
  try {
    value = JSON.parse(text, (key: string, item: unknown) => {
      if (unsafe.test(key)) {
        throw new Error('Remove keys and login information before importing')
      }
      return item
    })
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        'JSON format is invalid; check quotes, commas and brackets'
      )
    }
    throw error
  }
  function walk(item: unknown, depth: number): void {
    if (depth > 20 || ++count > 50000) {
      throw new Error('JSON is too deeply nested or too large')
    }
    if (
      typeof item === 'string' &&
      (/^Bearer\s+\S+/i.test(item) || /\bsk-[A-Za-z0-9_-]{12,}/.test(item))
    ) {
      throw new Error('Remove keys and login information before importing')
    }
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) walk(child, depth + 1)
    }
  }
  walk(value, 0)
  return value
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
export function clone<T>(value: T): T {
  return structuredClone(value)
}
export function merge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const result = clone(base)
  for (const [key, value] of Object.entries(patch)) {
    result[key] =
      isObject(value) && isObject(result[key])
        ? merge(result[key], value)
        : clone(value)
  }
  return result
}
export function parameterDefinition(
  name: string,
  raw: Record<string, unknown>,
  source: Source
): Parameter {
  const definition = isObject(raw.definition) ? raw.definition : raw
  const description =
    typeof raw.description === 'string'
      ? raw.description
      : definition.description
  const parameter: Parameter = {
    definition: clone(definition),
    source,
    description: typeof description === 'string' ? description : undefined,
  }
  const type = typeof raw.type === 'string' ? raw.type : definition.type
  if (typeof type === 'string') parameter.type = type
  for (const key of ['minimum', 'maximum'] as const) {
    if (typeof raw[key] === 'number') parameter[key] = raw[key]
  }
  if (Array.isArray(raw.enum)) parameter.enum = clone(raw.enum)
  if (typeof raw.required === 'boolean') parameter.required = raw.required
  if (Object.hasOwn(raw, 'default')) parameter.default = clone(raw.default)
  if (name === 'client_request_id' || name === 'model') {
    parameter.required = false
    parameter.definition = { ...parameter.definition, serverGenerated: true }
    parameter.description = 'Generated by the gateway; do not enter it manually'
  }
  return parameter
}
export function relevantParameter(
  key: string,
  capability: string,
  parameter?: { definition?: unknown }
): boolean {
  const membership = isObject(parameter?.definition)
    ? parameter.definition['x-channel-parameter']
    : undefined
  if (isObject(membership) && Array.isArray(membership.capabilities)) {
    const requiredIn = Array.isArray(membership.requiredIn)
      ? membership.requiredIn
      : []
    return (
      membership.capabilities.includes('base') ||
      membership.capabilities.includes(capability) ||
      requiredIn.includes(capability)
    )
  }
  const lower = key.toLowerCase()
  // Match reference inputs, not settings such as image_size. Unknown vendor
  // fields stay available for manual review instead of guessing from a substring.
  const image = [
    'image',
    'images',
    'image_url',
    'image_urls',
    'input_reference',
    'reference_images',
    'extra_images',
    'mask',
    'mask_url',
  ].includes(lower)
  const video = [
    'videos',
    'video_url',
    'video_urls',
    'reference_videos',
    'extra_videos',
  ].includes(lower)
  const audio = [
    'audios',
    'audio_url',
    'audio_urls',
    'reference_audios',
    'extra_audios',
    'audio_durations',
  ].includes(lower)
  const frame = [
    'start_image_url',
    'end_image_url',
    'first_frame',
    'last_frame',
    'first_last_frame',
  ].includes(lower)
  if (!image && !video && !audio && !frame) return true
  if (capability === 'text_image' || capability === 'text_video') return false
  if (capability === 'first_frame') {
    return (image || frame) && !/last|end_image/.test(lower)
  }
  if (capability === 'frames') return image || frame
  if (capability === 'image_video' || capability === 'edit_image') {
    return image && !frame
  }
  if (capability === 'video_ref') return video
  if (capability === 'audio_ref') return audio
  return true
}
export function modeFromDocument(model: CatalogModel, mode: string): Mode {
  const parameters: Record<string, Parameter> = {}
  for (const [name, raw] of Object.entries(model.parameters)) {
    if (
      !relevantParameter(name, mode, raw) &&
      !model.modes[mode]?.required.includes(name) &&
      raw.required !== true
    ) {
      continue
    }
    parameters[name] = parameterDefinition(name, raw, model.source)
    if (
      model.modes[mode]?.required.includes(name) &&
      name !== 'model' &&
      name !== 'client_request_id'
    ) {
      parameters[name].required = true
    }
  }
  const input: Record<string, unknown> = {}
  // Shared endpoint defaults are retained as documentation, not silently
  // applied as exact model defaults when applicability is unconfirmed.
  for (const [name, parameter] of Object.entries(parameters)) {
    if (model.source.url.includes('y5dprsil1i')) {
      if (Object.hasOwn(parameter, 'default')) {
        parameter.definition = {
          ...parameter.definition,
          documentedDefault: parameter.default,
        }
        delete parameter.default
      }
    }
    if (Object.hasOwn(parameter, 'default') && name !== 'model') {
      input[name] = clone(parameter.default)
    }
  }
  // Start with the selected documented fields. A label dictionary is not a
  // parameter schema, and aliases must point to a field in this mode.
  const mapping = Object.fromEntries(
    Object.entries(model.mapping ?? {}).filter(([name, target]) =>
      Object.hasOwn(parameters, target.startsWith('@') ? name : target)
    )
  )
  for (const name of Object.keys(parameters)) mapping[name] ??= name
  return {
    strictMapping: true,
    ...(model.interfaceId
      ? { protocol: { templateModel: model.interfaceId, confirmed: false } }
      : {}),
    enabled: false,
    input,
    parameters,
    mapping,
    cost: { amount: null, confirmed: false, unit: model.billingUnit },
    source: model.source,
  }
}
export function restoreDocumentRules(
  current: Mode,
  model: CatalogModel,
  mode: string
): Mode {
  return {
    ...modeFromDocument(model, mode),
    protocol: clone(current.protocol),
    enabled: current.enabled,
    input: clone(current.input),
    cost: clone(current.cost),
    billing: clone(current.billing),
  }
}

export function selectionMatchesGroup(
  document: Configuration,
  catalog: Catalog,
  models: string[],
  id: string
): boolean {
  const group = document.groups[id]
  if (!group) return false
  const members = Object.keys(document.bindings).filter((model) =>
    Object.values(document.bindings[model]).some(
      (binding) => binding.groupId === id
    )
  )
  if (
    members.length !== models.length ||
    members.some((model) => !models.includes(model))
  ) {
    return false
  }
  const modes = new Set(
    models.flatMap((model) => [
      ...Object.keys(document.bindings[model] ?? {}),
      ...Object.keys(catalog.models[model]?.modes ?? {}),
    ])
  )
  return Object.keys(group.modes).every((mode) => modes.has(mode))
}

function exceptions<T>(
  value: Record<string, T>,
  common: Record<string, T>
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([name, item]) => JSON.stringify(common[name]) !== JSON.stringify(item)
    )
  )
}
export function createSharedGroup(
  document: Configuration,
  catalog: Catalog,
  models: string[],
  id: string
): Configuration {
  const next = clone(document)
  for (const model of models) next.bindings[model] ??= {}
  const modeKeys = [
    ...new Set(
      models.flatMap((model) => [
        ...Object.keys(catalog.models[model]?.modes ?? {}),
        ...Object.keys(document.bindings[model] ?? {}),
      ])
    ),
  ]
  const modes: Record<string, Mode> = {}
  for (const key of modeKeys) {
    const members = models.flatMap((model) => {
      const binding = document.bindings[model]?.[key]
      const old = binding && document.groups[binding.groupId]?.modes[key]
      const reference = catalog.models[model]
      if (!old && !reference?.modes[key]) return []
      const value = old ? clone(old) : modeFromDocument(reference, key)
      if (binding) {
        value.capabilities = clone(binding.capabilities ?? value.capabilities)
        value.protocol = clone(binding.protocol ?? value.protocol)
        value.input = merge(value.input, binding.input ?? {})
        value.mapping = { ...value.mapping, ...binding.mapping }
        value.parameters = { ...value.parameters, ...binding.parameters }
        value.capabilities = clone(binding.capabilities ?? value.capabilities)
        value.cost = clone(binding.cost ?? value.cost)
        value.billing = clone(binding.billing ?? value.billing)
        value.enabled = value.enabled && binding.enabled !== false
      } else value.enabled = key === modeKeys[0]
      return [
        {
          model,
          value: reference?.modes[key]
            ? retainRequiredParameters(modeFromDocument(reference, key), value)
            : value,
        },
      ]
    })
    const common = (select: (mode: Mode) => Record<string, unknown>) => {
      const first = select(members[0].value)
      return Object.fromEntries(
        Object.entries(first).filter(([name, value]) =>
          members.every(
            (member) =>
              JSON.stringify(select(member.value)[name]) ===
              JSON.stringify(value)
          )
        )
      )
    }
    // Only rules shared by every member become group defaults. Model-specific
    // rules, mapping, enable flags and prices stay explicit member exceptions.
    modes[key] = {
      ...clone(members[0].value),
      enabled: members.some((member) => member.value.enabled),
      input: common((mode) => mode.input),
      parameters: common((mode) => mode.parameters ?? {}) as Record<
        string,
        Parameter
      >,
      mapping: common((mode) => mode.mapping ?? {}) as Record<string, string>,
      capabilities: undefined,
      protocol: catalog.interfaces
        ? undefined
        : clone(members[0].value.protocol),
      billing: undefined,
      cost: { amount: null, confirmed: false },
    }
    for (const { model, value } of members) {
      next.bindings[model] ??= {}
      next.bindings[model][key] = {
        groupId: id,
        capabilities: clone(value.capabilities),
        pricing: clone(document.bindings[model]?.[key]?.pricing),
        protocol: clone(value.protocol),
        billing: clone(value.billing),
        enabled: value.enabled ? undefined : false,
        input: exceptions(value.input, modes[key].input),
        parameters: exceptions(
          value.parameters ?? {},
          modes[key].parameters ?? {}
        ),
        mapping: exceptions(value.mapping ?? {}, modes[key].mapping ?? {}),
        cost: clone(value.cost),
      }
    }
  }
  next.groups[id] = { name: 'Shared configuration', modes }
  return next
}

export function effectiveInput(
  document: Configuration,
  model: string,
  mode: string
): Record<string, unknown> {
  const binding = document.bindings[model]?.[mode]
  if (!binding) return {}
  return merge(
    document.groups[binding.groupId]?.modes[mode]?.input ?? {},
    binding.input ?? {}
  )
}
export type Candidate = {
  input: Record<string, unknown>
  parameters: Record<string, Parameter>
  mapping: Record<string, string>
  definitionOnly: boolean
  model?: string
  warnings: string[]
}
export function openAPIOperations(raw: unknown): string[] {
  if (!isObject(raw) || !isObject(raw.paths)) return []
  return Object.entries(raw.paths).flatMap(([path, methods]) =>
    isObject(methods)
      ? Object.keys(methods)
          .filter((method) => ['post', 'put', 'patch', 'get'].includes(method))
          .map((method) => `${method.toUpperCase()} ${path}`)
      : []
  )
}
function resolveSchema(
  raw: unknown,
  root: Record<string, unknown>,
  depth = 0
): Record<string, unknown> {
  if (!isObject(raw) || depth > 12) {
    throw new Error('Schema is invalid or has a circular reference')
  }
  if (typeof raw.$ref === 'string') {
    if (!raw.$ref.startsWith('#/')) {
      throw new Error('Only references inside this JSON file are supported')
    }
    let target: unknown = root
    for (const key of raw.$ref
      .slice(2)
      .split('/')
      .map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'))) {
      if (unsafe.test(key) || !isObject(target)) {
        throw new Error('Schema reference is invalid')
      }
      target = target[key]
    }
    return resolveSchema(target, root, depth + 1)
  }
  return raw
}
export function importCandidate(
  raw: unknown,
  model: string,
  mode: string,
  operation = ''
): Candidate {
  if (!isObject(raw)) throw new Error('Import a JSON object')
  const source: Source = {
    url: '',
    scope: 'User supplied; source not verified',
    status: 'unverified',
  }
  if (isObject(raw.paths)) {
    const parts = operation.split(' '),
      path = parts[1],
      method = parts[0]?.toLowerCase()
    const methods = raw.paths[path]
    if (!isObject(methods) || !isObject(methods[method])) {
      throw new Error('Choose the API operation to import')
    }
    const body = methods[method].requestBody
    if (
      !isObject(body) ||
      !isObject(body.content) ||
      !isObject(body.content['application/json'])
    ) {
      throw new Error('This operation has no JSON request schema')
    }
    const schema = resolveSchema(body.content['application/json'].schema, raw)
    return schemaCandidate(schema, raw, source)
  }
  if (isObject(raw.properties)) return schemaCandidate(raw, raw, source)
  if (
    raw.format === 'channel-model-configuration/v1' &&
    isObject(raw.bindings) &&
    isObject(raw.groups)
  ) {
    const bindings = raw.bindings[model]
    const binding = isObject(bindings) ? bindings[mode] : undefined
    const group =
      isObject(binding) && typeof binding.groupId === 'string'
        ? raw.groups[binding.groupId]
        : undefined
    const modes = isObject(group) ? group.modes : undefined
    const value = isObject(modes) ? modes[mode] : undefined
    if (!isObject(value) || !isObject(value.input)) {
      throw new Error(
        'This file does not contain the selected model and generation mode'
      )
    }
    if (!isObject(binding)) throw new Error('Parameter rules are invalid')
    const sharedParameters = isObject(value.parameters)
      ? readParameterRules(value.parameters)
      : {}
    const memberParameters =
      binding.parameters === undefined
        ? {}
        : readParameterRules(binding.parameters)
    const sharedMapping =
      value.mapping === undefined ? {} : readMapping(value.mapping)
    const memberMapping =
      binding.mapping === undefined ? {} : readMapping(binding.mapping)
    if (binding.input !== undefined && !isObject(binding.input)) {
      throw new Error('Parameter rules are invalid')
    }
    return {
      input: merge(value.input, isObject(binding.input) ? binding.input : {}),
      parameters: { ...clone(sharedParameters), ...clone(memberParameters) },
      mapping: { ...clone(sharedMapping), ...clone(memberMapping) },
      definitionOnly: false,
      warnings: [],
    }
  }
  if (
    (raw.format === 'channel-mode-parameters/v1' ||
      raw.format === 'paisio-parameters/v1') &&
    isObject(raw.parameters)
  ) {
    return {
      input: clone(raw.parameters),
      parameters: isObject(raw.constraints)
        ? readParameterRules(raw.constraints)
        : {},
      mapping: isObject(raw.mapping) ? readMapping(raw.mapping) : {},
      definitionOnly: false,
      model:
        isObject(raw.scope) && typeof raw.scope.model === 'string'
          ? raw.scope.model
          : undefined,
      warnings: [],
    }
  }
  return {
    input: clone(raw),
    parameters: {},
    mapping: {},
    definitionOnly: false,
    model: typeof raw.model === 'string' ? raw.model : undefined,
    warnings: [
      'A request example does not define required fields, defaults, options or prices',
    ],
  }
}
function schemaCandidate(
  schema: Record<string, unknown>,
  root: Record<string, unknown>,
  source: Source
): Candidate {
  const result: Candidate = {
    input: {},
    parameters: {},
    mapping: {},
    definitionOnly: true,
    warnings: [],
  }
  const properties = isObject(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required : []
  for (const [name, value] of Object.entries(properties)) {
    const definition = resolveSchema(value, root)
    result.parameters[name] = parameterDefinition(
      name,
      { ...definition, required: required.includes(name) },
      source
    )
    if (Object.hasOwn(definition, 'default')) {
      result.input[name] = clone(definition.default)
    }
    if (definition.oneOf || definition.anyOf || definition.pattern) {
      result.warnings.push(
        `${
          name
        }: complex rules are retained for review; not all rules can be checked here`
      )
    }
  }
  return result
}
export function applyCandidate(
  current: Mode,
  candidate: Candidate,
  replace: boolean
): Mode {
  const next = clone(current)
  if (candidate.definitionOnly) {
    for (const [key, value] of Object.entries(candidate.input)) {
      if (!Object.hasOwn(next.input, key)) next.input[key] = clone(value)
    }
  } else {
    next.input = replace
      ? clone(candidate.input)
      : merge(next.input, candidate.input)
  }
  next.parameters = replace
    ? clone(candidate.parameters)
    : { ...next.parameters, ...clone(candidate.parameters) }
  if (!candidate.definitionOnly) {
    next.mapping = replace
      ? clone(candidate.mapping)
      : { ...next.mapping, ...clone(candidate.mapping) }
  }
  return retainRequiredParameters(current, next)
}
export function changes(
  before: unknown,
  after: unknown,
  path = ''
): { path: string; before: unknown; after: unknown }[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  if (isObject(before) && isObject(after)) {
    return [
      ...new Set([...Object.keys(before), ...Object.keys(after)]),
    ].flatMap((key) =>
      changes(before[key], after[key], path ? `${path}.${key}` : key)
    )
  }
  return [{ path, before, after }]
}

export function readParameterRules(value: unknown): Record<string, Parameter> {
  if (!isObject(value)) throw new Error('Parameter rules must be a JSON object')
  for (const parameter of Object.values(value)) {
    if (
      !isObject(parameter) ||
      (parameter.enum !== undefined && !Array.isArray(parameter.enum)) ||
      (parameter.type !== undefined && typeof parameter.type !== 'string') ||
      (parameter.inputPolicy !== undefined &&
        parameter.inputPolicy !== 'upstream_default') ||
      (parameter.required !== undefined &&
        typeof parameter.required !== 'boolean')
    ) {
      throw new Error('Parameter rules are invalid')
    }
  }
  return value as Record<string, Parameter>
}

export function readMapping(value: unknown): Record<string, string> {
  if (
    !isObject(value) ||
    Object.values(value).some((item) => typeof item !== 'string')
  ) {
    throw new Error('Parameter rules are invalid')
  }
  return value as Record<string, string>
}
export function readConfiguration(
  value: unknown,
  provider: string
): Configuration {
  if (
    !isObject(value) ||
    value.format !== 'channel-model-configuration/v1' ||
    value.provider !== provider ||
    !isObject(value.groups) ||
    !isObject(value.bindings) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0
  ) {
    throw new Error('Configuration does not belong to this provider')
  }
  if (
    Object.keys(value.groups).length > 64 ||
    Object.keys(value.bindings).length > 1000
  ) {
    throw new Error('JSON is too deeply nested or too large')
  }
  for (const group of Object.values(value.groups)) {
    if (
      !isObject(group) ||
      typeof group.name !== 'string' ||
      !isObject(group.modes)
    ) {
      throw new Error('Parameter rules are invalid')
    }
    for (const mode of Object.values(group.modes)) {
      if (
        !isObject(mode) ||
        typeof mode.enabled !== 'boolean' ||
        !isObject(mode.input) ||
        !isObject(mode.cost) ||
        typeof mode.cost.confirmed !== 'boolean' ||
        (mode.cost.amount !== null &&
          (typeof mode.cost.amount !== 'number' ||
            !Number.isFinite(mode.cost.amount) ||
            mode.cost.amount < 0))
      ) {
        throw new Error('Parameter rules are invalid')
      }
      if (mode.billing !== undefined) readBilling(mode.billing)
      if (mode.parameters !== undefined) readParameterRules(mode.parameters)
      if (mode.mapping !== undefined) readMapping(mode.mapping)
    }
  }
  for (const modes of Object.values(value.bindings)) {
    if (!isObject(modes)) throw new Error('Parameter rules are invalid')
    for (const [key, binding] of Object.entries(modes)) {
      if (
        !isObject(binding) ||
        typeof binding.groupId !== 'string' ||
        (binding.enabled !== undefined &&
          typeof binding.enabled !== 'boolean') ||
        (binding.input !== undefined && !isObject(binding.input))
      ) {
        throw new Error('Parameter rules are invalid')
      }
      const group = value.groups[binding.groupId]
      if (!isObject(group) || !isObject(group.modes) || !group.modes[key]) {
        throw new Error('Parameter rules are invalid')
      }
      if (
        binding.cost !== undefined &&
        (!isObject(binding.cost) ||
          typeof binding.cost.confirmed !== 'boolean' ||
          (binding.cost.amount !== null &&
            (typeof binding.cost.amount !== 'number' ||
              !Number.isFinite(binding.cost.amount) ||
              binding.cost.amount < 0)))
      ) {
        throw new Error('Parameter rules are invalid')
      }
      if (binding.billing !== undefined) readBilling(binding.billing)
      if (binding.parameters !== undefined) {
        readParameterRules(binding.parameters)
      }
      if (binding.mapping !== undefined) readMapping(binding.mapping)
    }
  }
  return clone(value) as Configuration
}

function readBilling(value: unknown): void {
  if (
    !isObject(value) ||
    typeof value.expression !== 'string' ||
    typeof value.confirmed !== 'boolean' ||
    value.currency !== 'USD'
  ) {
    throw new Error('Parameter rules are invalid')
  }
}

export function acceptsStringArrayItems(parameter?: Parameter): boolean {
  const items = parameter?.definition?.items
  if (!isObject(items)) return true
  if (items.type === 'string') return true
  if (Array.isArray(items.anyOf)) {
    return items.anyOf.some((item) => isObject(item) && item.type === 'string')
  }
  return items.type === undefined && !items.properties
}

// Discovery refreshes visibility only. Hand-entered/saved/selected IDs remain
// available for editing before and after a supplier's daily opening.
export function configurationModelChoices(
  returned: string[],
  existing: string[],
  bound: string[],
  selected: string[]
): string[] {
  return [...new Set([...returned, ...existing, ...bound, ...selected])]
}

// These are input aliases of the same duration, not three independent controls.
export const DURATION_ALIASES = ['seconds', 'duration', 'duration_seconds']
// Display names come from retained vendor schemas, never from the normalized
// plugin input name alone. This does not change stored keys or execution.
export function documentParameterNames(
  model?: CatalogModel
): Record<string, string> {
  const documented = model?.documentedParameters ?? {}
  return Object.fromEntries(
    Object.keys(model?.parameters ?? {}).flatMap((key) => {
      const membership = (model?.parameters[key] as Parameter | undefined)
        ?.definition?.['x-channel-parameter'] as
        | Record<string, unknown>
        | undefined
      const fields = membership?.vendorFields
      if (Array.isArray(fields) && fields.length === 1) {
        return [[key, String(fields[0])]]
      }
      if (Object.hasOwn(documented, key)) return [[key, key]]
      if (!DURATION_ALIASES.includes(key)) return []
      const names = DURATION_ALIASES.filter((alias) =>
        Object.hasOwn(documented, alias)
      )
      return names.length === 1 ? [[key, names[0]]] : []
    })
  )
}
export function parameterKeys(mode: Mode, extra: string[] = []): string[] {
  const keys = [
    ...new Set([
      ...Object.keys(mode.parameters ?? {}),
      ...Object.keys(mode.input),
      ...Object.keys(mode.mapping ?? {}),
      ...extra,
    ]),
  ]
  const duration =
    DURATION_ALIASES.find((key) => mode.parameters?.[key]) ??
    DURATION_ALIASES.find((key) => Object.hasOwn(mode.input, key)) ??
    DURATION_ALIASES.find(
      (key) => mode.mapping?.[key] && !mode.mapping[key].startsWith('@')
    ) ??
    DURATION_ALIASES.find((key) => keys.includes(key))
  return keys.filter(
    (key) => !DURATION_ALIASES.includes(key) || key === duration
  )
}
export function requiredParameter(mode: Mode, key: string): boolean {
  return (DURATION_ALIASES.includes(key) ? DURATION_ALIASES : [key]).some(
    (name) => mode.parameters?.[name]?.required === true
  )
}
// Imports and advanced JSON must not turn inherited required rules into edits.
export function retainRequiredParameters(current: Mode, edited: Mode): Mode {
  const next = clone(edited)
  for (const [key, parameter] of Object.entries(current.parameters ?? {})) {
    if (!parameter.required) continue
    next.parameters = { ...next.parameters, [key]: clone(parameter) }
    next.mapping = {
      ...next.mapping,
      [key]:
        current.mapping?.[key] && !current.mapping[key].startsWith('@')
          ? current.mapping[key]
          : key,
    }
    if (Object.hasOwn(current.input, key)) {
      next.input[key] = clone(current.input[key])
    } else delete next.input[key]
  }
  return next
}
