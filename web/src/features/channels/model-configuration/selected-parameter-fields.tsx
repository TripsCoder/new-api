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
import { useTranslation } from 'react-i18next'

import { clone, documentParameterNames } from './configuration'
import { ParameterFields } from './parameter-fields'
import { applyParameterScope, selectedParameterMode } from './parameter-scope'
import type { Catalog, Configuration, Mode } from './types'

export function SelectedParameterFields(props: {
  document: Configuration
  catalog: Catalog
  models: string[]
  groupId: string
  kind: string
  onChange: (document: Configuration) => void
}) {
  const { t } = useTranslation()
  const members = props.models.map((name) => ({
    name,
    mode: selectedParameterMode(
      props.document,
      name,
      props.groupId,
      props.kind
    ),
  }))
  const first = members[0]?.mode
  if (!first) return null
  const common = Object.keys(first.parameters ?? {}).filter((field) =>
    members.every(
      ({ mode }) =>
        JSON.stringify(mode.parameters?.[field]) ===
          JSON.stringify(first.parameters?.[field]) &&
        JSON.stringify(mode.input[field]) ===
          JSON.stringify(first.input[field]) &&
        mode.mapping?.[field] === first.mapping?.[field]
    )
  )
  const commonSet = new Set(common)
  const shared: Mode = {
    ...clone(first),
    parameters: Object.fromEntries(
      common.map((field) => [field, first.parameters?.[field] ?? {}])
    ),
    input: Object.fromEntries(
      common
        .filter((field) => Object.hasOwn(first.input, field))
        .map((field) => [field, first.input[field]])
    ),
    mapping: Object.fromEntries(
      common.map((field) => [field, first.mapping?.[field] ?? field])
    ),
  }
  return (
    <section className='space-y-5' data-testid='selected-capability-parameters'>
      <h4 className='border-b pb-2 text-base font-semibold'>
        {t('Common parameters: apply to all selected models')}
      </h4>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Common parameters plus parameters for every selected function; shared fields appear once'
        )}
      </p>
      <ParameterFields
        mode={shared}
        advanced
        allowExclusion
        documentedNames={documentParameterNames(
          props.catalog.models[members[0].name]
        )}
        onChange={(edited) =>
          props.onChange(
            applyParameterScope(
              props.document,
              props.models,
              props.groupId,
              props.kind,
              shared,
              edited
            )
          )
        }
      />
      {members.map(({ name, mode }) => {
        const fields = Object.keys(mode.parameters ?? {}).filter(
          (field) => !commonSet.has(field)
        )
        if (!fields.length) return null
        const shown: Mode = {
          ...mode,
          parameters: Object.fromEntries(
            fields.map((field) => [field, mode.parameters?.[field] ?? {}])
          ),
          input: Object.fromEntries(
            fields
              .filter((field) => Object.hasOwn(mode.input, field))
              .map((field) => [field, mode.input[field]])
          ),
          mapping: Object.fromEntries(
            fields.map((field) => [field, mode.mapping?.[field] ?? field])
          ),
        }
        return (
          <section key={name} className='space-y-3 rounded-md border p-4'>
            <h4 className='text-base font-semibold'>
              {name} · {t('Individual settings')}
            </h4>
            <ParameterFields
              mode={shown}
              advanced
              allowExclusion
              documentedNames={documentParameterNames(
                props.catalog.models[name]
              )}
              onChange={(edited) =>
                props.onChange(
                  applyParameterScope(
                    props.document,
                    [name],
                    props.groupId,
                    props.kind,
                    shown,
                    edited,
                    true
                  )
                )
              }
            />
          </section>
        )
      })}
    </section>
  )
}
