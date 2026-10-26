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
import { t } from 'i18next'

import {
  isObject,
  modeFromDocument,
  requiredParameter,
  numericParameter,
  integerRangeChoices,
} from './configuration'
import type { Catalog, Configuration } from './types'
import { effectiveMode } from './workflow'

export function parameterConfigurationIssues(
  document: Configuration,
  catalog: Catalog,
  models: string[]
): string[] {
  const issues: string[] = []
  for (const model of models) {
    const source = catalog.models[model]
    if (!source) continue
    for (const key of Object.keys(document.bindings[model] ?? {})) {
      const mode = effectiveMode(document, model, key)
      if (!mode?.enabled || !source.modes[key]) continue
      const reference = modeFromDocument(source, key)
      for (const [field, expected] of Object.entries(
        reference.parameters ?? {}
      )) {
        const actual = mode.parameters?.[field]
        const unlimited =
          actual?.definition?.['x-business-allowed-values'] === 'unlimited' &&
          !requiredParameter(reference, field)
        const prefix = `${model} / ${key} / ${field}`
        if (
          actual?.inputPolicy === 'upstream_default' &&
          (!Object.hasOwn(mode.input, field) ||
            mode.input[field] === null ||
            mode.input[field] === undefined)
        ) {
          issues.push(
            `${prefix}: ${t('Upstream-only parameters need an explicit default')}`
          )
        }
        if (
          actual?.definition?.['x-business-allowed-values'] === 'fixed' &&
          !actual.enum?.length
        ) {
          issues.push(`${prefix}: ${t('Enter at least one fixed choice')}`)
        }
        if (
          actual?.minimum !== undefined &&
          actual.maximum !== undefined &&
          actual.minimum > actual.maximum
        ) {
          issues.push(`${prefix}: ${t('Minimum cannot exceed maximum')}`)
        }
        if (
          actual?.definition?.['x-business-allowed-values'] === 'range' &&
          !actual.type &&
          numericParameter(expected) &&
          !integerRangeChoices(actual)
        ) {
          issues.push(
            `${prefix}: ${t('Enter finite integer minimum and maximum bounds for this numeric/string parameter (up to 10000 apart)')}`
          )
        }
        if (numericParameter(expected)) {
          const integer =
            expected.type === 'integer' ||
            (expected.type !== 'number' &&
              Array.isArray(expected.definition?.anyOf) &&
              expected.definition.anyOf.some(
                (entry) => entry?.type === 'integer'
              ))
          const valid = (value: unknown) =>
            (typeof value === 'number' ||
              (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value))) &&
            Number.isFinite(Number(value)) &&
            (!integer || Number.isInteger(Number(value)))
          const bounds = (value: unknown) =>
            unlimited ||
            ((expected.minimum === undefined ||
              Number(value) >= expected.minimum) &&
              (expected.maximum === undefined ||
                Number(value) <= expected.maximum) &&
              (actual?.minimum === undefined ||
                Number(value) >= actual.minimum) &&
              (actual?.maximum === undefined ||
                Number(value) <= actual.maximum))
          if (actual?.enum?.some((value) => !valid(value) || !bounds(value))) {
            issues.push(
              `${prefix}: ${t('Fixed choices must be numbers within the documented and configured range; do not include units')}`
            )
          }
          const value = mode.input[field] ?? actual?.default
          if (value !== undefined && (!valid(value) || !bounds(value))) {
            issues.push(
              `${prefix}: ${t('Default must be one number within the allowed range, not a list or range expression')}`
            )
          }
        }
        if (
          requiredParameter(reference, field) &&
          (!actual?.required || mode.mapping?.[field]?.startsWith('@'))
        ) {
          issues.push(
            `${prefix}: ${t('Required document rules must be retained')}`
          )
        }
        const membership = expected.definition?.['x-channel-parameter']
        if (
          isObject(membership) &&
          Array.isArray(membership.requiredAlternatives)
        ) {
          const possible = membership.requiredAlternatives.some(
            (alternative) =>
              Array.isArray(alternative) &&
              alternative.every(
                (name: unknown) =>
                  typeof name === 'string' &&
                  mode.parameters?.[name] &&
                  mode.mapping?.[name] !== '@ignore' &&
                  mode.mapping?.[name] !== '@reject'
              )
          )
          if (!possible) {
            issues.push(
              `${prefix}: ${t('Keep an input alternative for the required material condition')}`
            )
          }
        }
        if (!isObject(membership) || membership.status !== 'documented') {
          continue
        }
        const documentedEnum =
          expected.enum ??
          (field === 'seconds' && Array.isArray(membership.documentedEnum)
            ? membership.documentedEnum.flatMap((value: unknown) => [
                Number(value),
                String(value),
              ])
            : undefined)
        if (
          !unlimited &&
          documentedEnum &&
          actual?.enum?.some(
            (value) =>
              !documentedEnum.some(
                (allowed) => JSON.stringify(value) === JSON.stringify(allowed)
              )
          )
        ) {
          issues.push(
            `${prefix}: ${t('Allowed values exceed the documented contract')}`
          )
        }
        const value = mode.input[field] ?? actual?.default
        if (
          !unlimited &&
          value !== undefined &&
          actual?.enum?.length &&
          !actual.enum.some(
            (allowed) => JSON.stringify(value) === JSON.stringify(allowed)
          )
        ) {
          issues.push(
            `${prefix}: ${t('Default value is outside the configured allowed values')}`
          )
        }
        if (
          !unlimited &&
          expected.minimum !== undefined &&
          actual?.minimum !== undefined &&
          actual.minimum < expected.minimum
        ) {
          issues.push(
            `${prefix}: ${t('Minimum exceeds the documented contract')}`
          )
        }
        if (
          !unlimited &&
          expected.maximum !== undefined &&
          actual?.maximum !== undefined &&
          actual.maximum > expected.maximum
        ) {
          issues.push(
            `${prefix}: ${t('Maximum exceeds the documented contract')}`
          )
        }
      }
    }
  }
  return issues
}
