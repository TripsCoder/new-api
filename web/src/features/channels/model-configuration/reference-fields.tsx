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

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import { acceptsStringArrayItems, isObject } from './configuration'
import type { Parameter } from './types'

const LABELS: Record<string, string> = {
  url: 'Reference address',
  duration_seconds: 'Reference duration in seconds',
  voice_id: 'Preset voice',
  role: 'Reference role',
  name: 'Reference name',
  type: 'Reference type',
}
export function ReferenceFields(props: {
  name: string
  value: unknown
  parameter?: Parameter
  onChange: (value: unknown) => void
}) {
  const { t } = useTranslation()
  const [rowIds, setRowIds] = useState<string[]>(() =>
    Array.from(
      { length: Array.isArray(props.value) ? props.value.length : 0 },
      () => crypto.randomUUID()
    )
  )
  const items = Array.isArray(props.value) ? props.value : []
  const raw = props.parameter?.definition?.items
  let objectSchema: Record<string, unknown> = {}
  if (isObject(raw)) {
    if (raw.type === 'object') objectSchema = raw
    else if (Array.isArray(raw.anyOf)) {
      objectSchema =
        raw.anyOf.find((value) => isObject(value) && value.type === 'object') ??
        {}
    }
  }
  const properties = isObject(objectSchema.properties)
    ? objectSchema.properties
    : {}
  const fields = Object.keys(properties).length
    ? Object.keys(properties)
    : ['url']
  const stringItems = acceptsStringArrayItems(props.parameter)
  const max =
    typeof props.parameter?.definition?.maxItems === 'number'
      ? props.parameter.definition.maxItems
      : 128
  function update(index: number, field: string, text: string) {
    const next = structuredClone(items)
    let row: Record<string, unknown> = {}
    if (typeof next[index] === 'string') row = { url: next[index] }
    else if (isObject(next[index])) row = { ...next[index] }
    const schema = properties[field]
    let value: unknown = text
    if (
      isObject(schema) &&
      (schema.type === 'number' || schema.type === 'integer')
    ) {
      value = text === '' ? undefined : Number(text)
    }
    if (value === undefined || text === '') delete row[field]
    else row[field] = value
    next[index] =
      stringItems && Object.keys(row).every((key) => key === 'url')
        ? String(row.url ?? '')
        : row
    props.onChange(next)
  }
  return (
    <div className='space-y-3'>
      {!items.length && (
        <p className='text-muted-foreground text-sm'>
          {t('Optional: add references only when you need them')}
        </p>
      )}
      {items.map((item, index) => {
        let row: Record<string, unknown> = {}
        if (typeof item === 'string') row = { url: item }
        else if (isObject(item)) row = item
        return (
          <div
            key={rowIds[index] ?? `${props.name}-${JSON.stringify(item)}`}
            className='space-y-2 rounded-md border p-3'
          >
            <div className='flex items-center justify-between'>
              <span className='text-sm'>
                {t('Reference')} {index + 1}
              </span>
              <Button
                size='sm'
                variant='ghost'
                onClick={() => {
                  const next = items.filter((_, i) => i !== index)
                  props.onChange(next.length ? next : undefined)
                }}
              >
                {t('Remove reference')}
              </Button>
            </div>
            <div className='grid gap-3 sm:grid-cols-2'>
              {fields.map((field) => {
                const schema = properties[field]
                const values =
                  isObject(schema) && Array.isArray(schema.enum)
                    ? schema.enum
                    : []
                return (
                  <label key={field} className='space-y-1 text-sm'>
                    <span>{t(LABELS[field] ?? field)}</span>
                    {values.length ? (
                      <Select
                        value={typeof row[field] === 'string' ? row[field] : ''}
                        onValueChange={(value) =>
                          update(index, field, String(value))
                        }
                      >
                        <SelectTrigger
                          aria-label={`${props.name} ${index + 1}: ${t(LABELS[field] ?? field)}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {values.map((value) => (
                              <SelectItem
                                key={String(value)}
                                value={String(value)}
                              >
                                {String(value)}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        aria-label={`${props.name} ${index + 1}: ${t(LABELS[field] ?? field)}`}
                        type={
                          isObject(schema) &&
                          (schema.type === 'number' ||
                            schema.type === 'integer')
                            ? 'number'
                            : 'text'
                        }
                        value={
                          typeof row[field] === 'string' ||
                          typeof row[field] === 'number'
                            ? row[field]
                            : ''
                        }
                        placeholder={field === 'url' ? 'https://' : undefined}
                        onChange={(event) =>
                          update(index, field, event.target.value)
                        }
                      />
                    )}
                  </label>
                )
              })}
            </div>
          </div>
        )
      })}
      <Button
        size='sm'
        variant='outline'
        disabled={items.length >= max}
        onClick={() => {
          setRowIds((previous) => [...previous, crypto.randomUUID()])
          props.onChange([...items, stringItems ? '' : {}])
        }}
      >
        {t('Add reference')}
      </Button>
    </div>
  )
}
