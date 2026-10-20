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
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'

import { clone } from './configuration'
import {
  CUSTOMER_BILLING_METHODS,
  videoPriceResolutions,
  applyCustomerPrice,
  customerPriceError,
  readCustomerPrice,
  readUniformCustomerPrice,
  applyModelPricing,
  type CustomerPriceFields,
  type CustomerPriceEdits,
} from './simple-pricing'
import { type Catalog, type Configuration, MODE_LABELS } from './types'
import { effectiveMode } from './workflow'
import { PerModelPrices } from './workflow-panels'

export function PricingEditor(props: {
  draft: Configuration
  baseline: Configuration
  catalog: Catalog
  models: string[]
  modeKey: string
  allModes?: boolean
  customerOnly?: boolean
  edits: CustomerPriceEdits
  onEdit: (key: string, fields: CustomerPriceFields | undefined) => void
  onChange: (value: Configuration) => void
}) {
  const { t } = useTranslation()
  const [bulk, setBulk] = useState<CustomerPriceFields>({ unit: '', value: '' })
  return (
    <section className='space-y-4'>
      <h3 className='font-semibold'>
        {t('Set customer billing method and unit price')}
      </h3>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Customer billing is independent of provider cost. Existing prices and advanced formulas are kept until you explicitly replace them.'
        )}
      </p>
      {props.allModes && (
        <p className='text-muted-foreground text-sm'>
          {t('Uniform price for all enabled modes')}
        </p>
      )}
      {!props.customerOnly && (
        <div className='flex flex-wrap items-end gap-3'>
          <label className='space-y-1 text-sm'>
            <span>{t('Billing method')}</span>
            <Select
              value={bulk.unit || '__none__'}
              onValueChange={(unit) => setBulk({ ...bulk, unit: String(unit) })}
            >
              <SelectTrigger aria-label={t('Default billing method')}>
                <SelectValue>
                  {t(
                    CUSTOMER_BILLING_METHODS[bulk.unit] ??
                      'Choose billing method'
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value='__none__' disabled>
                    {t('Choose billing method')}
                  </SelectItem>
                  {Object.entries(CUSTOMER_BILLING_METHODS).map(
                    ([unit, label]) => (
                      <SelectItem key={unit} value={unit}>
                        {t(label)}
                      </SelectItem>
                    )
                  )}
                </SelectGroup>
              </SelectContent>
            </Select>
          </label>
          <label className='space-y-1 text-sm'>
            <span>{t('Billing amount (USD)')}</span>
            <Input
              aria-label={t('Default billing amount (USD)')}
              type='number'
              min={0}
              step='any'
              value={bulk.value}
              onChange={(event) =>
                setBulk({ ...bulk, value: event.target.value })
              }
            />
          </label>
          <Button
            variant='outline'
            disabled={!!customerPriceError(bulk)}
            onClick={() => {
              let next = props.draft
              for (const name of props.models) {
                const mode = effectiveMode(next, name, props.modeKey)
                const uniform = props.allModes
                  ? readUniformCustomerPrice(next, name)
                  : undefined
                if (
                  (uniform ? uniform.modeCount === 0 : !mode) ||
                  (uniform && uniform.hasPrice) ||
                  (props.allModes &&
                    Object.values(next.bindings[name] ?? {}).some(
                      (binding) => binding.pricing
                    )) ||
                  mode?.billing?.expression ||
                  next.bindings[name]?.[props.modeKey]?.pricing ||
                  props.edits[`${props.modeKey}:${name}`]
                ) {
                  continue
                }
                next = applyCustomerPrice(
                  next,
                  name,
                  props.modeKey,
                  bulk,
                  props.allModes
                )
              }
              props.onChange(next)
            }}
          >
            {t('Fill only models without individual pricing')}
          </Button>
        </div>
      )}
      <div className='overflow-x-auto'>
        <Table className='min-w-[42rem]'>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Model')}</TableHead>
              <TableHead>{t('Billing method')}</TableHead>
              <TableHead>{t('Billing amount (USD)')}</TableHead>
              <TableHead>{t('Status')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.models.map((name) => {
              const mode = effectiveMode(props.draft, name, props.modeKey)
              const uniform = props.allModes
                ? readUniformCustomerPrice(props.draft, name)
                : undefined
              const key = `${props.allModes ? 'all' : props.modeKey}:${name}`
              const available = uniform ? uniform.modeCount > 0 : !!mode
              const storedFields =
                props.edits[key] ??
                (uniform ? uniform.fields : readCustomerPrice(mode))
              const resolutions = videoPriceResolutions(
                props.draft,
                name,
                props.modeKey,
                props.allModes
              )
              const fields: CustomerPriceFields = { ...storedFields }
              if (storedFields.resolutions) {
                if (resolutions.length > 1) {
                  fields.resolutions = Object.fromEntries(
                    resolutions.map((resolution) => [
                      resolution,
                      storedFields.resolutions?.[resolution] ?? '',
                    ])
                  )
                } else {
                  fields.value =
                    resolutions.length === 1
                      ? (storedFields.resolutions[resolutions[0]] ??
                        storedFields.value)
                      : storedFields.value
                  delete fields.resolutions
                }
              }
              const advanced = uniform
                ? uniform.hasPrice && !uniform.fields.unit && !uniform.mixed
                : !!mode?.billing?.expression && !readCustomerPrice(mode).unit
              let summary = t('Keep existing price')
              if (advanced) summary = t('Advanced pricing preserved')
              if (uniform?.mixed) {
                summary = t(
                  'Mode prices differ; select a mode to edit separately, or explicitly set a uniform price'
                )
              } else if (uniform?.incomplete) {
                summary = t(
                  'Some enabled modes have no price; enter a uniform price to fill them'
                )
              }
              if (fields.unit && !customerPriceError(fields)) {
                summary = fields.resolutions
                  ? resolutions
                      .map(
                        (resolution) =>
                          `${resolution}: ${fields.resolutions?.[resolution]} USD / ${t(CUSTOMER_BILLING_METHODS[fields.unit])}`
                      )
                      .join(' · ')
                  : `${Number(fields.value)} USD / ${t(CUSTOMER_BILLING_METHODS[fields.unit])}${uniform?.incomplete ? ` · ${t('Some enabled modes have no price')}` : ''}`
                if (mode?.billing?.confirmed === false) {
                  summary += ` · ${t('Not confirmed')}`
                }
              }
              if (storedFields.resolutions && resolutions.length < 2) {
                summary = t('Advanced pricing preserved')
              }
              const update = (next: CustomerPriceFields) => {
                const affectedKeys = props.allModes
                  ? Object.keys(props.draft.bindings[name] ?? {}).filter(
                      (key) => effectiveMode(props.draft, name, key)?.enabled
                    )
                  : [props.modeKey]
                // Clear stale edit buffers only for rates explicitly replaced.
                for (const mode of affectedKeys) {
                  props.onEdit(`${mode}:${name}`, undefined)
                }
                props.onEdit(`all:${name}`, undefined)
                props.onEdit(key, next)
                props.onChange(
                  applyCustomerPrice(
                    props.draft,
                    name,
                    props.modeKey,
                    next,
                    props.allModes
                  )
                )
              }
              return (
                <TableRow key={name}>
                  <TableCell className='max-w-64 break-all whitespace-normal'>
                    {name}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={fields.unit || '__keep__'}
                      onValueChange={(unit) => {
                        if (unit === '__keep__') {
                          const next = clone(props.draft)
                          const keys = props.allModes
                            ? Object.keys(next.bindings[name] ?? {}).filter(
                                (mode) =>
                                  effectiveMode(next, name, mode)?.enabled
                              )
                            : [props.modeKey]
                          for (const mode of keys) {
                            const binding = next.bindings[name]?.[mode]
                            if (!binding) continue
                            binding.billing = clone(
                              effectiveMode(props.baseline, name, mode)?.billing
                            )
                            binding.pricing = clone(
                              props.baseline.bindings[name]?.[mode]?.pricing
                            )
                            props.onEdit(`${mode}:${name}`, undefined)
                          }
                          props.onEdit(`all:${name}`, undefined)
                          props.onEdit(key, undefined)
                          props.onChange(next)
                          return
                        }
                        const next = { ...fields, unit: String(unit) }
                        if (unit === 'image_count') delete next.resolutions
                        update(next)
                      }}
                    >
                      <SelectTrigger
                        aria-label={`${name}: ${t('Billing method')}`}
                        disabled={!available}
                        className='min-w-32'
                      >
                        <SelectValue>
                          {t(
                            CUSTOMER_BILLING_METHODS[fields.unit] ??
                              'Keep existing price'
                          )}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value='__keep__'>
                            {t('Keep existing price')}
                          </SelectItem>
                          {Object.entries(CUSTOMER_BILLING_METHODS).map(
                            ([unit, label]) => (
                              <SelectItem key={unit} value={unit}>
                                {t(label)}
                              </SelectItem>
                            )
                          )}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    {!fields.resolutions && (
                      <Input
                        aria-label={`${name}: ${t('Billing amount (USD)')}`}
                        type='number'
                        min={0}
                        step='any'
                        className='min-w-28'
                        disabled={!available || !fields.unit}
                        value={fields.value}
                        onChange={(event) =>
                          update({ ...fields, value: event.target.value })
                        }
                      />
                    )}
                    {props.catalog.models[name]?.kind === 'video' &&
                      resolutions.length > 1 &&
                      fields.unit &&
                      fields.unit !== 'image_count' && (
                        <div className='mt-3 space-y-2'>
                          <label className='flex items-center gap-2 text-sm'>
                            <Checkbox
                              aria-label={`${name}: ${t('Price by video resolution')}`}
                              disabled={!available}
                              checked={!!fields.resolutions}
                              onCheckedChange={(checked) => {
                                const next = { ...fields }
                                if (checked) {
                                  next.resolutions = Object.fromEntries(
                                    resolutions.map((resolution) => [
                                      resolution,
                                      '',
                                    ])
                                  )
                                } else delete next.resolutions
                                update(next)
                              }}
                            />
                            {t('Price by video resolution')}
                          </label>
                          {fields.resolutions && (
                            <>
                              {resolutions.map((resolution) => (
                                <label
                                  key={resolution}
                                  className='flex items-center gap-2 text-sm'
                                >
                                  <span className='w-12'>{resolution}</span>
                                  <Input
                                    aria-label={`${name}: ${resolution} ${t('Billing amount (USD)')}`}
                                    type='number'
                                    min={0}
                                    step='any'
                                    disabled={!available}
                                    value={
                                      fields.resolutions?.[resolution] ?? ''
                                    }
                                    onChange={(event) =>
                                      update({
                                        ...fields,
                                        resolutions: {
                                          ...fields.resolutions,
                                          [resolution]: event.target.value,
                                        },
                                      })
                                    }
                                  />
                                </label>
                              ))}
                              <p className='text-muted-foreground max-w-64 text-xs'>
                                {t(
                                  'Enter a price for each listed resolution. Requests must specify a priced resolution.'
                                )}
                              </p>
                            </>
                          )}
                        </div>
                      )}
                  </TableCell>
                  <TableCell className='max-w-64 break-words whitespace-normal'>
                    {summary}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      {!props.customerOnly && (
        <details className='space-y-3'>
          <summary className='cursor-pointer font-medium'>
            {t('Advanced: provider cost evidence, units and formulas')}
          </summary>
          {props.allModes && (
            <p className='text-muted-foreground text-sm'>
              {t(
                'Provider costs and advanced formulas below still edit only the selected generation mode: {{mode}}',
                { mode: t(MODE_LABELS[props.modeKey] ?? props.modeKey) }
              )}
            </p>
          )}
          <PerModelPrices
            draft={props.draft}
            selected={props.models}
            modeKey={props.modeKey}
            onChange={(next) => {
              let updated = next
              for (const name of props.models) {
                const before = effectiveMode(props.draft, name, props.modeKey)
                const after = effectiveMode(next, name, props.modeKey)
                const binding = updated.bindings[name]?.[props.modeKey]
                if (
                  JSON.stringify(before?.billing) !==
                  JSON.stringify(after?.billing)
                ) {
                  props.onEdit(`${props.modeKey}:${name}`, undefined)
                  props.onEdit(`all:${name}`, undefined)
                  if (binding) delete binding.pricing
                  for (const key of Object.keys(updated.bindings[name] ?? {})) {
                    if (!effectiveMode(updated, name, key)?.enabled) continue
                    updated.bindings[name][key].billing = after?.billing
                    delete updated.bindings[name][key].pricing
                  }
                } else if (
                  binding?.pricing &&
                  JSON.stringify(before?.cost) !== JSON.stringify(after?.cost)
                ) {
                  updated = applyModelPricing(
                    updated,
                    props.catalog,
                    name,
                    props.modeKey,
                    binding.pricing,
                    props.baseline
                  )
                }
              }
              props.onChange(updated)
            }}
          />
        </details>
      )}
    </section>
  )
}
