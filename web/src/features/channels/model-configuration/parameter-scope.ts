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
import { clone, parameterKeys, retainRequiredParameters } from './configuration'
import type { Configuration, Mode, Parameter } from './types'
import { applyIndividualFields, effectiveMode } from './workflow'

export function selectedParameterModes(
  document: Configuration,
  model: string,
  groupId: string,
  kind: string
): string[] {
  return Object.entries(document.bindings[model] ?? {}).flatMap(
    ([key, binding]) => {
      const mode = effectiveMode(document, model, key)
      const matching =
        kind === 'image' ? key.endsWith('image') : !key.endsWith('image')
      return binding.groupId === groupId && mode?.enabled && matching
        ? [key]
        : []
    }
  )
}

export function selectedParameterMode(
  document: Configuration,
  model: string,
  groupId: string,
  kind: string
): Mode {
  const union: Mode = {
    enabled: true,
    parameters: {},
    input: {},
    mapping: {},
    cost: { amount: null, confirmed: false },
  }
  const seen = new Set<string>()
  for (const key of selectedParameterModes(document, model, groupId, kind)) {
    const mode = effectiveMode(document, model, key)
    if (!mode) continue
    for (const field of parameterKeys({ ...mode, mapping: {} })) {
      const rule = mode.parameters?.[field]
      const previous = union.parameters?.[field]
      if (rule) {
        const required = previous?.required || rule.required
        const comparison = { ...clone(rule), required: undefined }
        const prior = previous && { ...clone(previous), required: undefined }
        if (prior?.definition) delete prior.definition['x-scope-conflict']
        const conflict =
          previous &&
          (JSON.stringify(prior) !== JSON.stringify(comparison) ||
            (seen.has(field) &&
              (JSON.stringify(union.input[field]) !==
                JSON.stringify(mode.input[field]) ||
                union.mapping?.[field] !== mode.mapping?.[field])))
        union.parameters ??= {}
        union.parameters[field] = { ...clone(rule), required }
        if (conflict || previous?.definition?.['x-scope-conflict']) {
          union.parameters[field].definition = {
            ...rule.definition,
            'x-scope-conflict': true,
          }
        }
      }
      if (Object.hasOwn(mode.input, field)) {
        union.input[field] = clone(mode.input[field])
      }
      if (mode.mapping?.[field]) {
        union.mapping = { ...union.mapping, [field]: mode.mapping[field] }
      }
      seen.add(field)
    }
  }
  return union
}

export function applyParameterScope(
  document: Configuration,
  models: string[],
  groupId: string,
  kind: string,
  before: Mode,
  edited: Mode,
  individual = false
): Configuration {
  let next = clone(document)
  const protectedEdit = retainRequiredParameters(before, edited)
  for (const section of ['parameters', 'input', 'mapping'] as const) {
    const prior = before[section] ?? {}
    const after = protectedEdit[section] ?? {}
    const changed = [
      ...new Set([...Object.keys(prior), ...Object.keys(after)]),
    ].filter(
      (field) => JSON.stringify(prior[field]) !== JSON.stringify(after[field])
    )
    for (const field of changed) {
      const sharedModes = new Set<string>()
      for (const model of models) {
        for (const key of selectedParameterModes(next, model, groupId, kind)) {
          const current = effectiveMode(next, model, key)
          if (!current) continue
          if (
            !current.parameters?.[field] &&
            !Object.hasOwn(current?.input ?? {}, field)
          ) {
            continue
          }
          const shared = next.groups[groupId].modes[key]
          if (!individual && shared.parameters?.[field]) {
            if (!sharedModes.has(key)) {
              const target = shared[section] ?? {}
              if (Object.hasOwn(after, field)) {
                Object.assign(target, { [field]: clone(after[field]) })
              } else delete target[field]
              if (section === 'parameters') {
                shared.parameters = target as Record<string, Parameter>
              } else if (section === 'mapping') {
                shared.mapping = target as Record<string, string>
              } else shared.input = target
              sharedModes.add(key)
            }
            continue
          }
          const value = clone(current)
          if (section === 'parameters') {
            value.parameters = { ...value.parameters }
            if (Object.hasOwn(after, field)) {
              value.parameters[field] = clone(after[field] as Parameter)
            } else delete value.parameters[field]
          } else if (section === 'input') {
            if (Object.hasOwn(after, field)) {
              value.input[field] = clone(after[field])
            } else delete value.input[field]
          } else {
            value.mapping = { ...value.mapping }
            if (Object.hasOwn(after, field)) {
              value.mapping[field] = after[field] as string
            } else delete value.mapping[field]
          }
          next = applyIndividualFields(next, model, key, value)
        }
      }
    }
  }
  return next
}
