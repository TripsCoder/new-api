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

import { previewDocumentRefresh } from './document-refresh'
import { PARAMETER_LABELS } from './parameter-labels'
import { MODE_LABELS, type Catalog, type Configuration } from './types'

const sectionLabels = {
  input: 'Default value',
  mapping: 'Field mapping',
  parameters: 'Parameter rules',
}

function RefreshValue({ value }: { value: unknown }) {
  const { t } = useTranslation()
  if (value === undefined) return <>{t('Not set')}</>
  if (typeof value !== 'object') return <>{String(value)}</>
  return (
    <details>
      <summary>{t('View rules')}</summary>
      <pre className='text-xs break-all whitespace-pre-wrap'>
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  )
}

export function DocumentRefreshPanel(props: {
  document: Configuration
  catalog: Catalog
  models: string[]
  onChange: (document: Configuration) => void
}) {
  const { t } = useTranslation()
  const [preview, setPreview] = useState<{
    baseline: Configuration
    catalog: Catalog
    selection: string
    result: ReturnType<typeof previewDocumentRefresh>
  } | null>(null)
  const historical = props.models.filter(
    (model) => Object.keys(props.document.bindings[model] ?? {}).length
  )
  const selection = JSON.stringify(props.models)
  const undocumented = props.models.filter((model) => {
    const id = props.catalog.models[model]?.interfaceId
    const rules = id && props.catalog.interfaces?.[id]?.modelRules
    return rules && Object.keys(rules).length > 0 && !rules[model]
  })
  // Do not apply an old preview over edits made elsewhere in the dialog.
  const current =
    preview?.baseline === props.document &&
    preview.catalog === props.catalog &&
    preview.selection === selection
      ? preview.result
      : null
  if (!historical.length && !undocumented.length) return null
  return (
    <section
      className='space-y-3 rounded-md border p-4'
      aria-label={t('Saved parameter configuration')}
    >
      <h4 className='font-semibold'>{t('Saved parameter configuration')}</h4>
      {!!undocumented.length && (
        <p role='status' className='text-sm'>
          {t(
            'Only generic interface fields are available; model-specific specifications are not documented for these models'
          )}
          : {undocumented.join(', ')}
        </p>
      )}
      {!!historical.length && (
        <>
          <p className='text-muted-foreground text-sm'>
            {t(
              'These models have saved parameters. Fetching models updates the model list; it does not reset saved parameters.'
            )}
          </p>
          <p className='text-sm break-all'>{historical.join(', ')}</p>
          <Button
            type='button'
            variant='outline'
            onClick={() =>
              setPreview({
                baseline: props.document,
                catalog: props.catalog,
                selection,
                result: previewDocumentRefresh(
                  props.document,
                  props.catalog,
                  historical
                ),
              })
            }
          >
            {t('Preview parameter refresh from documentation')}
          </Button>
        </>
      )}
      {current && (
        <div className='space-y-3'>
          <p className='text-sm'>
            {t(
              'Refresh replaces parameter rules, field mappings and defaults for the selected models, including disabled functions. Prices, enabled functions and interface confirmations are preserved. Changes are applied to the draft and take effect only after saving.'
            )}
          </p>
          {!!current.skipped.length && (
            <p role='status' className='text-sm'>
              {t(
                'Missing matching documentation; these functions will be kept unchanged'
              )}
              :{' '}
              {current.skipped
                .map(
                  ({ model, mode }) =>
                    `${model} · ${t(MODE_LABELS[mode] ?? mode)}`
                )
                .join(', ')}
            </p>
          )}
          {!current.changes.length && (
            <p>{t('No parameter changes to apply')}</p>
          )}
          {!!current.changes.length && (
            <div className='max-h-80 overflow-auto'>
              <table className='w-full text-left text-sm'>
                <thead>
                  <tr>
                    {['Model', 'Function', 'Parameter', 'Before', 'After'].map(
                      (label) => (
                        <th key={label} className='p-2'>
                          {t(label)}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody>
                  {current.changes.map((change) => (
                    <tr
                      key={`${change.model}:${change.mode}:${change.section}:${change.field}`}
                    >
                      <td className='max-w-48 p-2 break-all'>{change.model}</td>
                      <td className='p-2'>
                        {t(MODE_LABELS[change.mode] ?? change.mode)}
                      </td>
                      <td className='p-2'>
                        {t(PARAMETER_LABELS[change.field] ?? change.field)} ·{' '}
                        {t(sectionLabels[change.section])}
                      </td>
                      {(['before', 'after'] as const).map((side) => (
                        <td key={side} className='max-w-64 p-2 align-top'>
                          <RefreshValue value={change[side]} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className='flex flex-wrap gap-2'>
            <Button
              type='button'
              variant='outline'
              onClick={() => setPreview(null)}
            >
              {t('Keep saved parameters')}
            </Button>
            <Button
              type='button'
              disabled={!current.changes.length}
              onClick={() => {
                props.onChange(current.document)
                setPreview(null)
              }}
            >
              {t('Apply refresh to draft')}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
