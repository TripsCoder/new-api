import { useTranslation } from 'react-i18next'

import { clone, documentParameterNames } from './configuration'
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
import { ParameterFields } from './parameter-fields'
import type { Catalog, Configuration, Mode } from './types'
import {
  effectiveMode,
  applyIndividualFields,
  relevantParameter,
} from './workflow'

export function SharedParameterFields(props: {
  document: Configuration
  catalog: Catalog
  models: string[]
  groupId: string
  modeKey: string
  capability: string
  onSharedChange: (mode: Mode) => void
  onChange: (document: Configuration) => void
}) {
  const { t } = useTranslation()
  const shared = props.document.groups[props.groupId]?.modes[props.modeKey]
  if (!shared) return null
  const common = new Set(Object.keys(shared.parameters ?? {}))
  const maximums = Object.fromEntries(
    [...common].flatMap((field) => {
      const values = props.models
        .map((name) => props.catalog.models[name]?.parameters[field]?.maxItems)
        .filter((value): value is number => typeof value === 'number')
      return values.length ? [[field, Math.min(...values)]] : []
    })
  )
  return (
    <section data-testid='shared-parameter-fields' className='space-y-5'>
      <h4 className='border-b pb-2 text-base font-semibold'>
        {t('Common parameters: apply to all selected models')}
      </h4>
      <ParameterFields
        allowExclusion
        capability={props.capability}
        documentedNames={Object.fromEntries(
          [...common].flatMap((key) => {
            const names = props.models.map(
              (name) => documentParameterNames(props.catalog.models[name])[key]
            )
            return names[0] && names.every((name) => name === names[0])
              ? [[key, names[0]]]
              : []
          })
        )}
        mode={shared}
        contractMaximums={maximums}
        onChange={props.onSharedChange}
      />
      {props.models.map((name) => {
        const mode = effectiveMode(props.document, name, props.modeKey)
        if (!mode) return null
        const fields = Object.keys(mode.parameters ?? {}).filter(
          (field) =>
            !common.has(field) &&
            relevantParameter(
              field,
              props.capability,
              mode.parameters?.[field]
            ) &&
            field !== 'model' &&
            field !== 'client_request_id'
        )
        if (!fields.length) return null
        const shown = {
          ...mode,
          parameters: Object.fromEntries(
            fields.map((field) => [field, mode.parameters?.[field] ?? {}])
          ),
          input: Object.fromEntries(
            fields
              .filter((field) => Object.hasOwn(mode.input, field))
              .map((field) => [field, mode.input[field]])
          ),
        }
        const maximums = Object.fromEntries(
          fields
            .map((field) => [
              field,
              props.catalog.models[name]?.parameters[field]?.maxItems,
            ])
            .filter(
              (entry): entry is [string, number] => typeof entry[1] === 'number'
            )
        )
        return (
          <section key={name} className='space-y-3 rounded-md border p-4'>
            <h4 className='text-base font-semibold'>
              {name} · {t('Individual settings')}
            </h4>
            <p className='text-muted-foreground text-sm'>
              以下参数的文档规则或当前设置因模型而异，分别配置，不会覆盖其他模型。
            </p>
            <ParameterFields
              allowExclusion
              mode={shown}
              documentedNames={documentParameterNames(
                props.catalog.models[name]
              )}
              capability={props.capability}
              contractMaximums={maximums}
              onChange={(edited) => {
                const next = clone(mode)
                for (const field of fields) {
                  if (Object.hasOwn(edited.input, field)) {
                    next.input[field] = edited.input[field]
                  } else delete next.input[field]
                  if (edited.parameters?.[field]) {
                    next.parameters = {
                      ...next.parameters,
                      [field]: edited.parameters[field],
                    }
                  }
                }
                props.onChange(
                  applyIndividualFields(
                    props.document,
                    name,
                    props.modeKey,
                    next
                  )
                )
              }}
            />
          </section>
        )
      })}
    </section>
  )
}
