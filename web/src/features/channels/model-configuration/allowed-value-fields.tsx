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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import { clone, numericParameter, integerRangeChoices } from './configuration'
import type { Mode, Parameter } from './types'

export function AllowedValueFields(props: {
  field: string
  documentedChoices?: unknown[]
  name: string
  mode: Mode
  onChange: (mode: Mode) => void
}) {
  const { t } = useTranslation()
  const parameter = props.mode.parameters?.[props.field] ?? {}
  const numeric = numericParameter(parameter)
  const kind = String(
    parameter.definition?.['x-business-allowed-values'] ?? 'document'
  )
  let kindLabel = 'Use documented limits'
  if (kind === 'unlimited') kindLabel = 'No value restrictions'
  else if (kind === 'fixed') kindLabel = 'Fixed choices only'
  else if (kind === 'range') kindLabel = 'Numeric range'
  const source = JSON.stringify(parameter.enum ?? [])
  const [buffer, setBuffer] = useState({
    source,
    text: [...new Set((parameter.enum ?? []).map(String))].join(','),
  })
  if (buffer.source !== source) {
    setBuffer({
      source,
      text: [...new Set((parameter.enum ?? []).map(String))].join(','),
    })
  }
  function update(edit: (parameter: Parameter) => void) {
    const next = clone(props.mode)
    next.parameters ??= {}
    next.parameters[props.field] = clone(parameter)
    edit(next.parameters[props.field])
    const edited = next.parameters[props.field]
    if (
      edited.definition?.['x-business-allowed-values'] === 'range' &&
      !edited.type
    ) {
      const choices = integerRangeChoices(edited)
      if (choices) edited.enum = choices
      else delete edited.enum
    }
    props.onChange(next)
  }
  return (
    <div className='space-y-2 rounded-md border p-3'>
      <label className='block space-y-1 text-sm'>
        <span>{t('Allowed value rule')}</span>
        <Select
          value={kind}
          onValueChange={(value) => {
            update((next) => {
              next.definition = { ...next.definition }
              if (value === 'unlimited') {
                next.definition['x-business-allowed-values'] = 'unlimited'
                delete next.enum
                delete next.minimum
                delete next.maximum
              } else if (value === 'document') {
                delete next.definition['x-business-allowed-values']
                if (props.documentedChoices?.length) {
                  next.enum = [...props.documentedChoices]
                } else delete next.enum
                next.minimum =
                  typeof next.definition.minimum === 'number'
                    ? next.definition.minimum
                    : undefined
                next.maximum =
                  typeof next.definition.maximum === 'number'
                    ? next.definition.maximum
                    : undefined
              } else {
                next.definition['x-business-allowed-values'] = value
                if (value === 'fixed') next.enum = []
                else delete next.enum
              }
            })
          }}
        >
          <SelectTrigger
            className='w-full'
            aria-label={`${props.name}: ${t('Allowed value rule')}`}
          >
            <SelectValue>{t(kindLabel)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value='document'>
                {t('Use documented limits')}
              </SelectItem>
              <SelectItem value='unlimited'>
                {t('No value restrictions')}
              </SelectItem>
              {!props.documentedChoices?.length && (
                <SelectItem value='fixed'>{t('Fixed choices only')}</SelectItem>
              )}
              {numeric && !props.documentedChoices?.length && (
                <SelectItem value='range'>{t('Numeric range')}</SelectItem>
              )}
            </SelectGroup>
          </SelectContent>
        </Select>
      </label>
      {kind === 'unlimited' && (
        <p className='text-muted-foreground text-xs'>
          {t(
            'Pass supplied values to the provider without candidate or range restrictions. Required fields and wire types still apply.'
          )}
        </p>
      )}
      {kind === 'fixed' && (
        <label className='block space-y-1 text-sm'>
          <span>{t('Fixed choices (comma separated)')}</span>
          <Input
            aria-label={`${props.name}: ${t('Fixed choices (comma separated)')}`}
            value={buffer.text}
            placeholder={numeric ? '5,10' : '1:1,16:9'}
            onChange={(event) => {
              const text = event.target.value
              const values = text
                .split(/[,，\n]/)
                .map((item) => item.trim())
                .filter(Boolean)
                .map((item) =>
                  numeric && /^-?\d+(?:\.\d+)?$/.test(item)
                    ? Number(item)
                    : item
                )
              // A documented integer/string union accepts the same seconds in either wire type.
              const mixed =
                numeric &&
                Array.isArray(parameter.definition?.anyOf) &&
                parameter.definition.anyOf.some(
                  (entry) =>
                    entry &&
                    typeof entry === 'object' &&
                    entry.type === 'string'
                )
              const allowed = [
                ...new Map(
                  values
                    .flatMap((item) =>
                      mixed && typeof item === 'number'
                        ? [item, String(item)]
                        : [item]
                    )
                    .map((item) => [JSON.stringify(item), item])
                ).values(),
              ]
              setBuffer({ source: JSON.stringify(allowed), text })
              update((next) => {
                next.enum = allowed
              })
            }}
          />
          <span className='text-muted-foreground text-xs'>
            {t(
              numeric
                ? 'For 5 or 10 seconds, enter 5,10. Do not enter units or a range here.'
                : 'Enter separate text choices, for example 1:1,16:9. Choices must satisfy the document.'
            )}
          </span>
        </label>
      )}
      {kind === 'range' && numeric && (
        <div className='grid grid-cols-2 gap-3'>
          {(['minimum', 'maximum'] as const).map((bound) => (
            <label key={bound} className='space-y-1 text-sm'>
              <span>
                {t(
                  bound === 'minimum'
                    ? 'Minimum allowed value'
                    : 'Maximum allowed value'
                )}
              </span>
              <Input
                type='number'
                step={parameter.type === 'number' ? 'any' : 1}
                aria-label={`${props.name}: ${t(bound === 'minimum' ? 'Minimum allowed value' : 'Maximum allowed value')}`}
                value={parameter[bound] ?? ''}
                placeholder={
                  typeof parameter.definition?.[bound] === 'number'
                    ? String(parameter.definition[bound])
                    : ''
                }
                onChange={(event) =>
                  update((next) => {
                    next[bound] =
                      event.target.value === ''
                        ? undefined
                        : Number(event.target.value)
                  })
                }
              />
            </label>
          ))}
          <p className='text-muted-foreground col-span-2 text-xs'>
            {t(
              'For 4 to 10 seconds, set minimum 4 and maximum 10. The documented number type still applies.'
            )}
          </p>
        </div>
      )}
    </div>
  )
}
