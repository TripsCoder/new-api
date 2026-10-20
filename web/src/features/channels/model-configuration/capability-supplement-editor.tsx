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
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import { MODE_LABELS, type CapabilitySupplement } from './types'

// A missing capability gets one small editor; existing parameter controls handle
// its policy and limits after it has been added to the draft.
export function CapabilitySupplementEditor(props: {
  capability: string
  models: string[]
  onApply: (value: CapabilitySupplement) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [vendors, setVendors] = useState<Record<string, string>>({})
  const [shape, setShape] = useState<'url' | 'urls' | 'objects'>('urls')
  const [maximum, setMaximum] = useState('')
  const fields = {
    video_ref: ['videos'],
    audio_ref: ['audios'],
    image_video: ['images'],
    edit_image: ['images'],
    first_frame: ['start_image_url'],
    frames: ['start_image_url', 'end_image_url'],
  }[props.capability]
  if (!fields || !props.models.length) return null
  const frame =
    props.capability === 'frames' || props.capability === 'first_frame'
  const valid =
    note.trim() &&
    fields.every((field) =>
      /^[A-Za-z0-9_-]{1,128}$/.test(vendors[field] ?? '')
    ) &&
    (!maximum ||
      (/^\d+$/.test(maximum) && Number(maximum) >= 1 && Number(maximum) <= 100))
  return (
    <div className='space-y-3'>
      <Button
        size='sm'
        variant='outline'
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {t('Supplement missing capability')}: {t(MODE_LABELS[props.capability])}
      </Button>
      {open && (
        <div id={id} className='space-y-3 rounded-md border p-3'>
          <p className='text-muted-foreground text-sm'>
            {t(
              'Add fields only if you have confirmed provider support. Leave this closed to continue without supplementing.'
            )}
          </p>
          <p className='text-sm break-all'>{props.models.join(', ')}</p>
          <FieldGroup>
            {fields.map((field) => (
              <Field key={field}>
                <FieldLabel htmlFor={`${id}-${field}`}>
                  {t('Provider field name')} · {field}
                </FieldLabel>
                <Input
                  id={`${id}-${field}`}
                  value={vendors[field] ?? ''}
                  placeholder={field}
                  onChange={(event) =>
                    setVendors({ ...vendors, [field]: event.target.value })
                  }
                />
              </Field>
            ))}
            {!frame && (
              <Field>
                <FieldLabel htmlFor={`${id}-shape`}>
                  {t('Reference format')}
                </FieldLabel>
                <Select
                  value={shape}
                  onValueChange={(value) => setShape(value as typeof shape)}
                >
                  <SelectTrigger id={`${id}-shape`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value='urls'>{t('URL array')}</SelectItem>
                      <SelectItem value='objects'>
                        {t('Array of objects with url')}
                      </SelectItem>
                      <SelectItem value='url'>{t('Single URL')}</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            )}
            {!frame && (
              <Field>
                <FieldLabel htmlFor={`${id}-maximum`}>
                  {t('Maximum references (optional)')}
                </FieldLabel>
                <Input
                  id={`${id}-maximum`}
                  type='number'
                  min={1}
                  max={100}
                  value={maximum}
                  onChange={(event) => setMaximum(event.target.value)}
                />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor={`${id}-note`}>
                {t('Manual support evidence')}
              </FieldLabel>
              <Input
                id={`${id}-note`}
                maxLength={1000}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
          </FieldGroup>
          <Button
            size='sm'
            disabled={!valid}
            onClick={() => {
              props.onApply({
                note: note.trim(),
                fields: Object.fromEntries(
                  fields.map((field) => [
                    field,
                    {
                      vendor: vendors[field],
                      shape: frame ? 'url' : shape,
                      maxItems: shape === 'url' || frame ? 1 : Number(maximum),
                    },
                  ])
                ),
              })
              setOpen(false)
            }}
          >
            {t('Apply supplement to draft')}
          </Button>
        </div>
      )}
    </div>
  )
}
