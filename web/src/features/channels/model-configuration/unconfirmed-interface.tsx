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

import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from '@/components/ui/select'

import {
  clone,
  modeFromDocument,
  merge,
  createSharedGroup,
} from './configuration'
import {
  applyDocumentInterface,
  interfaceReference,
  projectDocumentInterfaces,
} from './document-interfaces'
import type { Catalog, Configuration } from './types'

export function UnconfirmedInterfaces(props: {
  draft: Configuration
  catalog: Catalog
  models: string[]
  modeKey: string
  groupId: string
  allParameters?: boolean
  onChange: (next: Configuration) => void
}) {
  const { t } = useTranslation()
  if (!props.models.length) return null
  function applyPreset(models: string[], templateName: string): void {
    if (props.catalog.interfaces) {
      props.onChange(
        applyDocumentInterface(
          props.draft,
          props.catalog,
          models,
          props.groupId,
          templateName
        )
      )
      return
    }
    const template = interfaceReference(props.catalog, templateName)
    if (!template) return
    const next = clone(props.draft)
    const keys = new Set([
      props.modeKey,
      props.modeKey.endsWith('image') ? 'text_image' : 'text_video',
      ...(props.modeKey === 'mixed_ref' ? Object.keys(template.modes) : []),
      ...Object.keys(next.groups[props.groupId]?.modes ?? {}).filter(
        (key) =>
          props.allParameters && next.groups[props.groupId].modes[key].enabled
      ),
    ])
    for (const name of models) {
      for (const key of keys) {
        if (!template.modes[key]) continue
        const reference = modeFromDocument(
          {
            ...template,
            interfaceId: props.catalog.interfaces ? templateName : undefined,
          },
          key
        )
        const old = next.bindings[name]?.[key]
        next.groups[props.groupId].modes[key] ??= {
          ...reference,
          enabled: true,
        }
        next.bindings[name] ??= {}
        next.bindings[name][key] = {
          ...old,
          groupId: props.groupId,
          enabled: true,
          protocol: { templateModel: templateName, confirmed: false },
          input: merge(reference.input, old?.input ?? {}),
          parameters: { ...reference.parameters, ...old?.parameters },
          mapping: { ...reference.mapping, ...old?.mapping },
          cost: clone(old?.cost ?? reference.cost),
          billing: clone(old?.billing ?? reference.billing),
        }
      }
    }
    const members = Object.keys(next.bindings).filter((name) =>
      Object.values(next.bindings[name]).some(
        (binding) => binding.groupId === props.groupId
      )
    )
    props.onChange(
      models.length > 1 &&
        members.length === models.length &&
        members.every((name) => models.includes(name))
        ? createSharedGroup(
            next,
            projectDocumentInterfaces(
              props.catalog,
              models,
              template.kind === 'image' ? 'image' : 'video',
              next
            ) ?? props.catalog,
            models,
            props.groupId
          )
        : next
    )
  }
  const templates = Object.values(
    props.catalog.interfaces ?? props.catalog.models
  ).filter(
    (model) =>
      model.modes[props.modeKey] ||
      props.models.some((name) =>
        Object.values(props.draft.bindings[name] ?? {}).some(
          (binding) =>
            binding.protocol?.templateModel === model.id &&
            binding.protocol.supplement?.[props.modeKey]
        )
      )
  )
  return (
    <section className='space-y-3 rounded-md border p-4'>
      <h4 className='font-medium'>
        {t('Choose a documented interface for unconfirmed models')}
      </h4>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Use only an interface whose input and output contract you have checked for these models.'
        )}
      </p>
      {props.models.length > 1 && (
        <Select
          value='__none__'
          onValueChange={(value) => applyPreset(props.models, String(value))}
        >
          <SelectTrigger
            className='h-auto min-h-9 w-full max-w-3xl [&_[data-slot=select-value]]:line-clamp-none [&_[data-slot=select-value]]:whitespace-normal'
            aria-label={t('Document parameter preset')}
          >
            <SelectValue>{t('Document parameter preset')}</SelectValue>
          </SelectTrigger>
          <SelectContent
            align='start'
            alignItemWithTrigger={false}
            className='w-[min(48rem,calc(100vw-3rem))] [&_[data-slot=select-item-text]]:break-words [&_[data-slot=select-item-text]]:whitespace-normal'
          >
            <SelectGroup>
              <SelectItem value='__none__'>
                {t('Choose a documented interface')}
              </SelectItem>
              {templates.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.title
                    ? `${model.title} · ${model.path ?? ''}`
                    : model.id}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      )}
      {props.models.map((name) => {
        const binding = props.draft.bindings[name]?.[props.modeKey]
        return (
          <section key={name} className='space-y-2 border-t py-3'>
            <h4 className='font-medium break-all'>{name}</h4>
            <Select
              value={binding?.protocol?.templateModel ?? '__none__'}
              onValueChange={(value) => applyPreset([name], String(value))}
            >
              <SelectTrigger
                className='h-auto min-h-9 w-full max-w-3xl [&_[data-slot=select-value]]:line-clamp-none [&_[data-slot=select-value]]:whitespace-normal'
                aria-label={`${name}: ${t('Documented interface')}`}
              >
                <SelectValue>
                  {interfaceReference(
                    props.catalog,
                    binding?.protocol?.templateModel ?? ''
                  )?.title ??
                    binding?.protocol?.templateModel ??
                    t('Choose a documented interface')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent
                align='start'
                alignItemWithTrigger={false}
                className='w-[min(48rem,calc(100vw-3rem))] [&_[data-slot=select-item-text]]:break-words [&_[data-slot=select-item-text]]:whitespace-normal'
              >
                <SelectGroup>
                  <SelectItem value='__none__'>
                    {t('Choose a documented interface')}
                  </SelectItem>
                  {templates.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.title
                        ? `${model.title} · ${model.path ?? ''}`
                        : model.id}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {binding?.protocol && (
              <label className='flex gap-2'>
                <Checkbox
                  checked={binding.protocol.confirmed}
                  onCheckedChange={(confirmed) => {
                    const next = clone(props.draft)
                    for (const value of Object.values(
                      next.bindings[name] ?? {}
                    )) {
                      if (
                        value.protocol &&
                        value.protocol.templateModel ===
                          binding.protocol?.templateModel
                      ) {
                        value.protocol = {
                          ...value.protocol,
                          confirmed: confirmed === true,
                        }
                      }
                    }
                    props.onChange(next)
                  }}
                />
                {t('I checked this interface applies to this model')}
              </label>
            )}
          </section>
        )
      })}
    </section>
  )
}
