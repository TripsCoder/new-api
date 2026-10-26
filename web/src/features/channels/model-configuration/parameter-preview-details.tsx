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

import { StaticDataTable } from '@/components/data-table'
import { Badge } from '@/components/ui/badge'
import { toIntlLocale } from '@/i18n/languages'

import { parameterKeys } from './configuration'
import { PARAMETER_LABELS } from './parameter-labels'
import { CUSTOMER_BILLING_METHODS, readCustomerPrice } from './simple-pricing'
import {
  MODE_LABELS,
  type Binding,
  type CatalogModel,
  type Configuration,
  type Mode,
} from './types'
import { effectiveMode } from './workflow'

// These are display-only schema facts; unknown and conditional rules remain
// available verbatim instead of being interpreted as unconditional limits.

function schemaOf(value: Record<string, unknown>): Record<string, unknown> {
  const definition = value.definition
  if (
    definition &&
    typeof definition === 'object' &&
    !Array.isArray(definition)
  ) {
    const fields = { ...value }
    delete fields.definition
    return { ...definition, ...fields }
  }
  return { ...value }
}

function SchemaFacts(props: {
  value?: Record<string, unknown>
  documented?: boolean
}) {
  const { t } = useTranslation()
  if (!props.value) {
    return (
      <p className='text-muted-foreground'>
        {props.documented ? t('Not stated in documentation') : t('Not set')}
      </p>
    )
  }
  const ruleLabels = {
    type: t('Type'),
    enum: t('Allowed values'),
    const: t('Fixed value'),
    minimum: t('Minimum'),
    maximum: t('Maximum'),
    multipleOf: t('Step'),
    exclusiveMinimum: t('Exclusive minimum'),
    exclusiveMaximum: t('Exclusive maximum'),
    minItems: t('Minimum item count'),
    maxItems: t('Maximum item count'),
    minLength: t('Minimum length'),
    maxLength: t('Maximum length'),
    format: t('Format'),
    pattern: t('Pattern'),
    uniqueItems: t('Unique items'),
  }

  const schema = schemaOf(props.value)
  if (!props.documented && !Object.hasOwn(props.value, 'default')) {
    delete schema.default
  }
  const unlimited = schema['x-business-allowed-values'] === 'unlimited'
  const items = schema.items
  const required = schema.required
  return (
    <div className='space-y-2 text-sm'>
      {typeof required === 'boolean' && (
        <Badge variant='outline'>
          {required ? t('Required') : t('Optional')}
        </Badge>
      )}
      {unlimited && <p>{t('Unlimited allowed values')}</p>}
      <dl className='space-y-1'>
        {Object.entries(ruleLabels)
          .filter(
            ([key]) =>
              Object.hasOwn(schema, key) &&
              !(
                unlimited &&
                [
                  'enum',
                  'const',
                  'minimum',
                  'maximum',
                  'exclusiveMinimum',
                  'exclusiveMaximum',
                  'multipleOf',
                ].includes(key)
              )
          )
          .map(([key, label]) => (
            <div key={key} className='flex flex-wrap gap-x-2'>
              <dt className='text-muted-foreground'>{label}:</dt>
              <dd className='min-w-0 break-all'>
                {Array.isArray(schema[key])
                  ? schema[key]
                      .map((value) => JSON.stringify(value))
                      .join(' / ')
                  : String(schema[key])}
              </dd>
            </div>
          ))}
        {Object.hasOwn(schema, 'default') && (
          <div>
            <dt className='text-muted-foreground'>
              {props.documented ? t('Document default') : t('Default value')}:
            </dt>
            <dd>
              <code>{JSON.stringify(schema.default)}</code>
            </dd>
          </div>
        )}
        {props.documented &&
          !Object.hasOwn(schema, 'default') &&
          Object.hasOwn(schema, 'documentedDefault') && (
            <div>
              <dt className='text-muted-foreground'>
                {t('Document default')}:
              </dt>
              <dd>
                <code>{JSON.stringify(schema.documentedDefault)}</code>
              </dd>
            </div>
          )}
      </dl>
      {typeof schema.description === 'string' && (
        <p className='max-h-48 overflow-auto break-words whitespace-pre-wrap'>
          {schema.description}
        </p>
      )}
      {Boolean(items) && typeof items === 'object' && !Array.isArray(items) && (
        <details>
          <summary className='cursor-pointer'>{t('Item rules')}</summary>
          <SchemaFacts
            value={items as Record<string, unknown>}
            documented={props.documented}
          />
        </details>
      )}
      <details>
        <summary className='text-muted-foreground cursor-pointer'>
          {t('Complete parameter rules')}
        </summary>
        <pre className='max-h-64 max-w-96 overflow-auto text-xs break-all whitespace-pre-wrap'>
          {JSON.stringify(props.value, null, 2)}
        </pre>
      </details>
    </div>
  )
}

export function ParameterComparison(props: {
  mode?: Mode
  binding?: Binding
  reference?: CatalogModel
  modeKey: string
}) {
  const { t } = useTranslation()
  const mode = props.mode
  const reference = props.reference
  const documented = reference?.parameters ?? {}
  const raw = reference?.documentedParameters ?? {}
  const keys = new Set([
    ...Object.keys(documented),
    ...(mode ? parameterKeys(mode) : []),
  ])
  const coveredVendorFields = new Set<string>()
  for (const key of keys) {
    const schema = documented[key] ? schemaOf(documented[key]) : undefined
    const membership = schema?.['x-channel-parameter'] as
      | { vendorFields?: string[] }
      | undefined
    for (const field of membership?.vendorFields ?? []) {
      coveredVendorFields.add(field)
    }
    if (reference?.mapping?.[key] && !reference.mapping[key].startsWith('@')) {
      coveredVendorFields.add(reference.mapping[key])
    }
  }
  for (const key of Object.keys(raw)) {
    if (!coveredVendorFields.has(key)) keys.add(key)
  }
  return (
    <div className='mt-3 space-y-3'>
      {reference ? (
        <div className='space-y-1 text-sm'>
          <p>
            {t('Document interface')}: {reference.title ?? reference.id}{' '}
            <code>{reference.path}</code>
          </p>
          <p className='break-all'>
            {t('Source')}: {reference.source.url}
          </p>
          {reference.source.readAt && (
            <p>
              {t('Document snapshot')}: {reference.source.readAt}
            </p>
          )}
          {reference.warnings?.map((warning) => (
            <p key={warning} className='text-muted-foreground'>
              {warning}
            </p>
          ))}
        </div>
      ) : (
        <p className='text-muted-foreground'>
          {t('No documentation matches the saved interface')}
        </p>
      )}
      {mode?.protocol && !mode.protocol.confirmed && (
        <p>{t('Interface applicability is not confirmed')}</p>
      )}
      {mode?.capabilities && (
        <div
          className='flex flex-wrap gap-2'
          aria-label={t('Input capabilities')}
        >
          {(
            [
              ['images', 'Reference images'],
              ['videos', 'Reference videos'],
              ['audios', 'Reference audio'],
              ['firstFrame', 'First frame'],
              ['lastFrame', 'Last frame'],
            ] as const
          )
            .filter(([field]) => mode.capabilities?.[field] !== undefined)
            .map(([field, label]) => (
              <Badge key={field} variant='outline'>
                {t(label)}:{' '}
                {mode.capabilities?.[field] ? t('Enabled') : t('Disabled')}
              </Badge>
            ))}
        </div>
      )}
      <StaticDataTable
        data={[...keys]}
        getRowKey={(key) => key}
        tableClassName='table-fixed min-w-[700px]'
        columns={[
          {
            id: 'parameter',
            header: t('Parameter'),
            className: 'w-1/5',
            cell: (key) => {
              const source = documented[key]
                ? schemaOf(documented[key])
                : undefined
              const membership = source?.['x-channel-parameter'] as
                | { vendorFields?: string[] }
                | undefined
              return (
                <div className='space-y-1 break-words whitespace-normal'>
                  {PARAMETER_LABELS[key] && (
                    <p className='font-medium'>{t(PARAMETER_LABELS[key])}</p>
                  )}
                  <code className='break-all'>{key}</code>
                  {membership?.vendorFields?.length && (
                    <p className='text-muted-foreground break-all'>
                      {membership.vendorFields.join(', ')}
                    </p>
                  )}
                </div>
              )
            },
          },
          {
            id: 'document',
            header: t('Document support range'),
            className: 'w-2/5',
            cell: (key) => {
              const schema = documented[key] ?? raw[key]
              if (!schema) return <SchemaFacts documented />
              const value = { ...schema }
              if (reference?.modes[props.modeKey]?.required.includes(key)) {
                value.required = true
              }
              return <SchemaFacts value={value} documented />
            },
          },
          {
            id: 'saved',
            header: t('Current saved configuration'),
            className: 'w-2/5',
            cell: (key) => {
              const parameter = mode?.parameters?.[key]
              const hasDefault = !!mode && Object.hasOwn(mode.input, key)
              const mapping = mode?.mapping?.[key]
              if (!parameter && !hasDefault && !mapping) {
                return (
                  <p className='text-muted-foreground'>{t('Not configured')}</p>
                )
              }
              const individual =
                Object.hasOwn(props.binding?.parameters ?? {}, key) ||
                Object.hasOwn(props.binding?.input ?? {}, key) ||
                Object.hasOwn(props.binding?.mapping ?? {}, key)
              const value: Record<string, unknown> = parameter
                ? { ...parameter }
                : {}
              // A documented default is not an administrator's configured default.
              if (hasDefault) value.default = mode?.input[key]
              return (
                <div className='space-y-2 whitespace-normal'>
                  <Badge variant='outline'>
                    {individual
                      ? t('Individual settings')
                      : t('Shared settings')}
                  </Badge>
                  <SchemaFacts value={value} />
                  {parameter?.inputPolicy === 'upstream_default' && (
                    <p>
                      {t('Parameter delivery')}:{' '}
                      {t('Upstream only: configured default')}
                    </p>
                  )}
                  {!hasDefault &&
                    !Object.hasOwn(parameter ?? {}, 'default') && (
                      <p>
                        {t('Default value')}: {t('Not set')}
                      </p>
                    )}
                  {mapping && (
                    <p className='break-all'>
                      {t('Field mapping')}: <code>{mapping}</code>
                    </p>
                  )}
                </div>
              )
            },
          },
        ]}
      />
      <details>
        <summary className='cursor-pointer text-sm'>
          {t('Saved parameter JSON')}
        </summary>
        <pre className='max-h-80 overflow-auto text-xs break-all whitespace-pre-wrap'>
          {JSON.stringify(
            {
              enabled: mode?.enabled,
              capabilities: mode?.capabilities,
              protocol: mode?.protocol,
              input: mode?.input,
              parameters: mode?.parameters,
              mapping: mode?.mapping,
            },
            null,
            2
          )}
        </pre>
      </details>
    </div>
  )
}

function SavedAmount(props: {
  value: string | number
  currency: string
  unit: string
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  let amount = `${String(props.value)} ${props.currency}`
  // Existing currency helpers convert to the global display currency. Here the
  // saved currency and precision must remain explicit without any conversion.
  if (
    /^[A-Z]{3}$/.test(props.currency) &&
    Number.isFinite(Number(props.value))
  ) {
    amount = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: props.currency,
      maximumFractionDigits: 20,
    }).format(Number(props.value))
  }
  return (
    <span>
      {amount} / {t(CUSTOMER_BILLING_METHODS[props.unit] ?? props.unit)}
    </span>
  )
}

export function SavedModelPrices(props: {
  document: Configuration
  model: string
}) {
  const { t } = useTranslation()
  const rows = Object.keys(props.document.bindings[props.model] ?? {}).map(
    (key) => ({ key, mode: effectiveMode(props.document, props.model, key) })
  )
  return (
    <section
      className='space-y-2 rounded-lg border p-3'
      aria-label={t('Saved model prices')}
    >
      <h3 className='font-semibold'>{t('Saved model prices')}</h3>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Saved channel prices only; public document quotes are not applied. Prices in the aggregation service may differ.'
        )}
      </p>
      <StaticDataTable
        data={rows}
        getRowKey={(row) => row.key}
        columns={[
          {
            id: 'mode',
            header: t('Input capability'),
            cell: (row) => (
              <span>
                {t(MODE_LABELS[row.key] ?? row.key)} ·{' '}
                {row.mode?.enabled ? t('Enabled') : t('Disabled')}
              </span>
            ),
          },
          {
            id: 'price',
            header: t('Saved selling price'),
            cell: (row) => {
              if (!row.mode?.billing?.expression) return t('Not set')
              const price = readCustomerPrice(row.mode)
              return (
                <div className='space-y-1 whitespace-normal'>
                  {!row.mode.billing.confirmed && (
                    <Badge variant='outline'>{t('Pending confirmation')}</Badge>
                  )}
                  {price.unit && price.value !== '' && (
                    <p>
                      {t('Base price')}:{' '}
                      <SavedAmount
                        value={price.value}
                        currency={row.mode.billing.currency}
                        unit={price.unit}
                      />
                    </p>
                  )}
                  {Object.entries(price.resolutions ?? {}).map(
                    ([resolution, value]) => (
                      <p key={resolution}>
                        {resolution}:{' '}
                        <SavedAmount
                          value={value}
                          currency={row.mode?.billing?.currency ?? 'USD'}
                          unit={price.unit}
                        />
                      </p>
                    )
                  )}
                  {!price.unit && <p>{t('Custom pricing expression')}</p>}
                  <details>
                    <summary className='cursor-pointer text-sm'>
                      {t('Saved billing expression')}
                    </summary>
                    <code className='block max-w-lg break-all whitespace-pre-wrap'>
                      {row.mode.billing.expression}
                    </code>
                  </details>
                </div>
              )
            },
          },
          {
            id: 'cost',
            header: t('Saved provider cost'),
            cell: (row) => {
              const cost = row.mode?.cost
              if (!cost) return t('Not set')
              return (
                <div className='space-y-1 whitespace-normal'>
                  {!cost.confirmed && (
                    <Badge variant='outline'>{t('Pending confirmation')}</Badge>
                  )}
                  {cost.amount != null ? (
                    <SavedAmount
                      value={cost.amount}
                      currency={cost.currency ?? ''}
                      unit={cost.unit ?? ''}
                    />
                  ) : (
                    <p>{t('Not set')}</p>
                  )}
                  {cost.expression && (
                    <details>
                      <summary className='cursor-pointer'>
                        {t('Saved billing expression')}
                      </summary>
                      <code className='block max-w-lg break-all whitespace-pre-wrap'>
                        {cost.expression}
                      </code>
                    </details>
                  )}
                </div>
              )
            },
          },
        ]}
      />
    </section>
  )
}
