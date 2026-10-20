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
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getServerErrorMessage } from '@/lib/server-error-message'

import { getModelConfiguration } from './api'
import { interfaceReference } from './document-interfaces'
import {
  ParameterComparison,
  SavedModelPrices,
} from './parameter-preview-details'
import { MODE_LABELS } from './types'
import { effectiveMode } from './workflow'

export function SavedModelParametersDialog(props: {
  channelId: number
  model: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: [
      'channels',
      'saved-model-parameters',
      props.channelId,
      props.model,
    ],
    queryFn: () => getModelConfiguration(props.channelId),
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    meta: { errorToast: false },
  })
  const document = query.data?.configuration
  const catalog = query.data?.catalog
  const bindings = document?.bindings[props.model] ?? {}
  let content
  if (query.isError) {
    content = (
      <ErrorState
        description={getServerErrorMessage(query.error)}
        onRetry={() => void query.refetch()}
      />
    )
  } else if (!query.isFetchedAfterMount || !document || !catalog) {
    content = <LoadingState />
  } else {
    // Only the saved interface identifies documentation. Never pick a different
    // model or the first catalog entry to fill a missing contract.
    const references = Object.entries(bindings)
      .map(([key]) => {
        const mode = effectiveMode(document, props.model, key)
        const id = mode?.protocol?.templateModel
        return id ? interfaceReference(catalog, id, props.model) : undefined
      })
      .filter((reference) => reference !== undefined)
    const keys = [
      ...new Set([
        ...Object.keys(bindings),
        ...references.flatMap((reference) => Object.keys(reference.modes)),
      ]),
    ]
    content = (
      <>
        <p className='text-sm'>
          {t('Configuration version')}: <code>{document.revision}</code>
        </p>
        {!Object.keys(bindings).length && (
          <EmptyState title={t('No saved parameters for this model')} />
        )}
        {!!Object.keys(bindings).length && (
          <SavedModelPrices document={document} model={props.model} />
        )}
        {keys.map((key) => {
          const binding = bindings[key]
          const mode = effectiveMode(document, props.model, key)
          const id = mode?.protocol?.templateModel
          const reference = id
            ? interfaceReference(catalog, id, props.model)
            : references.find((entry) => entry.modes[key])
          let status = t('Not configured')
          if (mode) status = mode.enabled ? t('Enabled') : t('Disabled')
          return (
            <details key={key} open className='rounded-lg border p-3'>
              <summary className='cursor-pointer font-medium'>
                {t(MODE_LABELS[key] ?? 'Input capability')}{' '}
                <Badge variant={mode?.enabled ? 'secondary' : 'outline'}>
                  {status}
                </Badge>
              </summary>
              {binding && !mode && (
                <p role='alert'>{t('Shared configuration is missing')}</p>
              )}
              <ParameterComparison
                mode={mode}
                binding={binding}
                reference={reference}
                modeKey={key}
              />
            </details>
          )
        })}
      </>
    )
  }
  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(open) => !open && props.onClose()}
      title={t('Saved parameter preview')}
      description={props.model}
      contentClassName='sm:max-w-[min(96vw,1200px)]'
      contentHeight='min(72dvh, 800px)'
      bodyClassName='space-y-4'
      footer={
        <>
          <Button
            type='button'
            variant='outline'
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {t('Refresh')}
          </Button>
          <Button type='button' onClick={props.onClose}>
            {t('Close')}
          </Button>
        </>
      }
    >
      <p className='text-muted-foreground text-sm'>
        {t(
          'Document ranges and saved settings are shown separately. This preview does not change configuration or prices.'
        )}
      </p>
      {content}
    </Dialog>
  )
}
