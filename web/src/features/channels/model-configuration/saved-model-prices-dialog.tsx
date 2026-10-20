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
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { markServerErrorHandled } from '@/lib/handle-server-error'
import { getServerErrorMessage } from '@/lib/server-error-message'

import { parseModelsString } from '../lib'
import type { Channel } from '../types'
import { getModelConfiguration, saveModelConfiguration } from './api'
import { clone } from './configuration'
import { projectDocumentInterfaces } from './document-interfaces'
import { PricingEditor } from './pricing-editor'
import { customerPriceError, type CustomerPriceEdits } from './simple-pricing'
import { MODE_LABELS, type ConfigurationResponse } from './types'
import { effectiveMode } from './workflow'

export function SavedModelPricesDialog(props: {
  channel: Channel
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [session, setSession] = useState(0)
  const query = useQuery({
    queryKey: ['channels', 'saved-model-prices', props.channel.id],
    queryFn: () => getModelConfiguration(props.channel.id),
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  })
  if (!query.isFetchedAfterMount || !query.data) {
    return (
      <Dialog
        open
        onOpenChange={(open) => !open && props.onClose()}
        title={t('Edit saved model prices')}
      >
        {query.isError ? (
          <ErrorState
            description={getServerErrorMessage(query.error)}
            onRetry={() => void query.refetch()}
          />
        ) : (
          <LoadingState />
        )}
      </Dialog>
    )
  }
  return (
    <SavedPricesSession
      key={session}
      channel={props.channel}
      response={query.data}
      reloading={query.isFetching}
      onClose={props.onClose}
      onReload={async () => {
        const result = await query.refetch()
        if (result.isSuccess) setSession((value) => value + 1)
      }}
    />
  )
}

function SavedPricesSession(props: {
  channel: Channel
  response: ConfigurationResponse
  reloading: boolean
  onClose: () => void
  onReload: () => Promise<void>
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  // Keep one saved revision throughout this editing session. Background query
  // refreshes must not erase edits or advance the optimistic concurrency token.
  const [snapshot] = useState(() => props.response)
  const [draft, setDraft] = useState(() => clone(snapshot.configuration))
  const models = parseModelsString(
    snapshot.channelModels ?? props.channel.models
  ).filter((name) => snapshot.configuration.bindings[name])
  const [model, setModel] = useState(() => models[0] ?? '')
  const [scope, setScope] = useState('all')
  const [edits, setEdits] = useState<CustomerPriceEdits>({})
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const lock = useRef(false)
  const modes = Object.keys(draft.bindings[model] ?? {}).filter(
    (mode) => effectiveMode(draft, model, mode)?.enabled
  )
  const modeKey = scope === 'all' ? (modes[0] ?? '') : scope
  const catalog =
    projectDocumentInterfaces(
      snapshot.catalog,
      [model],
      modeKey.endsWith('image') ? 'image' : 'video',
      draft
    ) ?? snapshot.catalog
  const priceError = Object.values(edits).map(customerPriceError).find(Boolean)
  const changed =
    JSON.stringify(draft) !== JSON.stringify(snapshot.configuration)
  const busy = saving || props.reloading

  async function save(): Promise<void> {
    if (lock.current || busy || priceError || !changed) return
    lock.current = true
    setSaving(true)
    setError('')
    try {
      // Explicit empty route lists preserve routing, including historical and
      // missing models. Only the editor's billing overrides change this payload.
      await saveModelConfiguration(
        props.channel.id,
        draft,
        [],
        [],
        snapshot.channelModels ?? props.channel.models
      )
      void client.invalidateQueries({
        queryKey: ['channels', 'model-configuration', props.channel.id],
      })
      void client.invalidateQueries({
        queryKey: ['channels', 'saved-model-prices', props.channel.id],
      })
      toast.success(t('Saved successfully'))
      props.onClose()
    } catch (cause) {
      markServerErrorHandled(cause)
      setError(getServerErrorMessage(cause))
    } finally {
      lock.current = false
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      title={t('Edit saved model prices')}
      description={`${props.channel.name} · #${props.channel.id}`}
      contentClassName='sm:max-w-5xl'
      contentHeight='min(76dvh, 850px)'
      showCloseButton={!saving}
      onOpenChange={(open) => {
        if (!open && !lock.current) props.onClose()
      }}
      footer={
        <>
          <Button variant='outline' disabled={busy} onClick={props.onClose}>
            {t('Cancel')}
          </Button>
          <Button
            disabled={busy || !changed || !!priceError}
            onClick={() => void save()}
          >
            {saving ? t('Saving...') : t('Save prices')}
          </Button>
        </>
      }
    >
      <p className='text-muted-foreground mb-4 text-sm'>
        {t(
          'Edit saved selling prices only. Channel routes, interface parameters and provider costs stay unchanged.'
        )}
      </p>
      {!models.length ? (
        <EmptyState title={t('No saved model configuration to price')} />
      ) : (
        <fieldset disabled={busy} className='space-y-4'>
          <div className='flex flex-wrap gap-3'>
            <label className='min-w-64 space-y-1 text-sm'>
              <span>{t('Model')}</span>
              <Select
                value={model}
                onValueChange={(value) => {
                  setModel(String(value))
                  setScope('all')
                }}
              >
                <SelectTrigger aria-label={t('Model')}>
                  <SelectValue>{model}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {models.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </label>
            <label className='min-w-64 space-y-1 text-sm'>
              <span>{t('Generation mode being edited')}</span>
              <Select
                value={scope}
                onValueChange={(value) => setScope(String(value))}
              >
                <SelectTrigger aria-label={t('Generation mode being edited')}>
                  <SelectValue>
                    {scope === 'all'
                      ? t('Uniform price for all enabled modes')
                      : t(MODE_LABELS[scope] ?? scope)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value='all'>
                      {t('Uniform price for all enabled modes')}
                    </SelectItem>
                    {modes.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {t(MODE_LABELS[mode] ?? mode)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </label>
          </div>
          <PricingEditor
            customerOnly
            draft={draft}
            baseline={snapshot.configuration}
            catalog={catalog}
            models={[model]}
            modeKey={modeKey}
            allModes={scope === 'all'}
            edits={edits}
            onEdit={(key, fields) =>
              setEdits((previous) => {
                const next = { ...previous }
                if (fields) next[key] = fields
                else delete next[key]
                return next
              })
            }
            onChange={setDraft}
          />
          {priceError && (
            <Alert variant='destructive'>
              <AlertDescription>{t(priceError)}</AlertDescription>
            </Alert>
          )}
        </fieldset>
      )}
      {error && (
        <Alert variant='destructive' className='mt-4'>
          <AlertDescription>
            {error}
            <Button
              variant='outline'
              disabled={busy}
              onClick={() => void props.onReload()}
            >
              {t('Reload pricing')}
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </Dialog>
  )
}
