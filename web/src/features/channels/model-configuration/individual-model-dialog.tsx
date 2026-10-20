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

import { Dialog } from '@/components/dialog'
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
import { Textarea } from '@/components/ui/textarea'

import {
  clone,
  createSharedGroup,
  isObject,
  parseSafe,
  readConfiguration,
  modeFromDocument,
  documentParameterNames,
  retainRequiredParameters,
  restoreDocumentRules,
} from './configuration'
import { interfaceReference } from './document-interfaces'
import { ParameterFields } from './parameter-fields'
import {
  applyParameterScope,
  selectedParameterMode,
  selectedParameterModes,
} from './parameter-scope'
import {
  MODE_LABELS,
  type Catalog,
  type Configuration,
  type Binding,
} from './types'
import { UnconfirmedInterfaces } from './unconfirmed-interface'
import { applyIndividualFields, effectiveMode } from './workflow'

export function IndividualModelDialog(props: {
  model: string
  document: Configuration
  catalog: Catalog
  initialModeKey?: string
  initialKind?: 'image' | 'video'
  onCancel: () => void
  onApply: (value: Configuration) => void
}) {
  const { t } = useTranslation()
  const [working, setWorking] = useState(() => {
    if (Object.keys(props.document.bindings[props.model] ?? {}).length) {
      return clone(props.document)
    }
    const id = `individual-${crypto.randomUUID()}`
    const next = createSharedGroup(
      props.document,
      props.catalog,
      [props.model],
      id
    )
    if (!Object.keys(next.bindings[props.model] ?? {}).length) {
      const key = props.initialKind === 'image' ? 'text_image' : 'text_video'
      next.groups[id].modes[key] = {
        enabled: true,
        input: {},
        parameters: {},
        mapping: {},
        cost: { amount: null, confirmed: false },
      }
      next.bindings[props.model] = { [key]: { groupId: id } }
    }
    return next
  })
  const [modeKey, setModeKey] = useState(
    () =>
      (props.initialModeKey &&
      working.bindings[props.model]?.[props.initialModeKey]
        ? props.initialModeKey
        : undefined) ??
      Object.keys(working.bindings[props.model] ?? {}).find(
        (key) => effectiveMode(working, props.model, key)?.enabled
      ) ??
      Object.keys(working.bindings[props.model] ?? {})[0] ??
      ''
  )
  const [editor, setEditor] = useState<'fields' | 'json'>('fields')
  const [allParameters, setAllParameters] = useState(
    props.initialModeKey === 'all'
  )
  const [json, setJSON] = useState('')
  const [error, setError] = useState('')
  const binding = working.bindings[props.model]?.[modeKey]
  const kind = modeKey.endsWith('image') ? 'image' : 'video'
  const groupId = binding?.groupId ?? ''
  const effective = allParameters
    ? selectedParameterMode(working, props.model, groupId, kind)
    : effectiveMode(working, props.model, modeKey)
  const referenceModel =
    interfaceReference(
      props.catalog,
      effectiveMode(working, props.model, modeKey)?.protocol?.templateModel ??
        '',
      props.model
    ) ?? props.catalog.models[props.model]
  const overrides = allParameters
    ? selectedParameterModes(
        working,
        props.model,
        groupId,
        kind
      ).reduce<Binding>(
        (combined, key) => {
          const member = working.bindings[props.model][key]
          return {
            groupId,
            input: { ...combined.input, ...member.input },
            parameters: { ...combined.parameters, ...member.parameters },
            mapping: { ...combined.mapping, ...member.mapping },
          }
        },
        { groupId }
      )
    : binding
  function fromJSON(): Configuration {
    const raw = parseSafe(json)
    if (
      !isObject(raw) ||
      Object.keys(raw).some(
        (key) => !['input', 'parameters', 'mapping'].includes(key)
      )
    ) {
      throw new Error('Use only input, parameters and mapping in this editor')
    }
    const next = clone(working)
    next.bindings[props.model][modeKey] = {
      ...binding,
      input: isObject(raw.input) ? raw.input : {},
      parameters: isObject(raw.parameters) ? raw.parameters : {},
      mapping: isObject(raw.mapping) ? raw.mapping : {},
    } as Binding
    const validated = readConfiguration(next, working.provider)
    const edited = effectiveMode(validated, props.model, modeKey)
    if (!effective || !edited) return validated
    return applyIndividualFields(
      working,
      props.model,
      modeKey,
      retainRequiredParameters(effective, edited)
    )
  }
  function switchEditor(next: 'fields' | 'json') {
    try {
      let value = working
      if (editor === 'json') value = fromJSON()
      setWorking(value)
      if (next === 'json') {
        setAllParameters(false)
        const member = value.bindings[props.model]?.[modeKey]
        setJSON(
          JSON.stringify(
            {
              input: member?.input ?? {},
              parameters: member?.parameters ?? {},
              mapping: member?.mapping ?? {},
            },
            null,
            2
          )
        )
      }
      setEditor(next)
      setError('')
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Invalid JSON')
    }
  }
  function clear(field: string) {
    const next = clone(working)
    const keys = allParameters
      ? selectedParameterModes(next, props.model, groupId, kind)
      : [modeKey]
    for (const key of keys) {
      const member = next.bindings[props.model][key]
      const shared = next.groups[member.groupId].modes[key]
      const source = referenceModel
      const reference = source ? modeFromDocument(source, key) : undefined
      if (member.input) delete member.input[field]
      if (member.parameters) {
        delete member.parameters[field]
        if (!shared.parameters?.[field] && reference?.parameters?.[field]) {
          member.parameters[field] = reference.parameters[field]
        }
      }
      if (member.mapping) {
        delete member.mapping[field]
        if (!shared.mapping?.[field] && reference?.mapping?.[field]) {
          member.mapping[field] = reference.mapping[field]
        }
      }
    }
    setWorking(next)
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onCancel()
      }}
      title={t('Individual model settings')}
      description={props.model}
      contentClassName='sm:max-w-4xl'
      contentHeight='min(72dvh,800px)'
      bodyClassName='space-y-4'
      footer={
        <>
          <span className='text-muted-foreground mr-auto text-sm'>
            {t(
              'Applies only to this model in the current draft. The channel changes only at final save.'
            )}
          </span>
          <Button variant='outline' onClick={props.onCancel}>
            {t('Cancel')}
          </Button>
          <Button
            disabled={!binding}
            onClick={() => {
              try {
                const next = editor === 'json' ? fromJSON() : working
                props.onApply(next)
              } catch (error) {
                setError(
                  error instanceof Error ? error.message : 'Invalid JSON'
                )
              }
            }}
          >
            {t('Apply individual settings')}
          </Button>
        </>
      }
    >
      <div className='flex gap-2' role='group' aria-label={t('Editor mode')}>
        <Button
          aria-pressed={editor === 'fields'}
          variant={editor === 'fields' ? 'default' : 'outline'}
          onClick={() => switchEditor('fields')}
        >
          {t('Parameter list')}
        </Button>
        <Button
          aria-pressed={editor === 'json'}
          variant={editor === 'json' ? 'default' : 'outline'}
          onClick={() => switchEditor('json')}
        >
          JSON
        </Button>
      </div>
      {error && (
        <Alert variant='destructive'>
          <AlertDescription>{t(error)}</AlertDescription>
        </Alert>
      )}
      <Select
        value={allParameters ? 'all' : modeKey}
        onValueChange={(value) => {
          try {
            if (editor === 'json') setWorking(fromJSON())
            setAllParameters(value === 'all')
            if (value !== 'all') setModeKey(String(value))
            setEditor('fields')
            setError('')
          } catch (error) {
            setError(error instanceof Error ? error.message : 'Invalid JSON')
          }
        }}
      >
        <SelectTrigger aria-label={t('Input capability')}>
          <SelectValue>
            {t(
              allParameters
                ? 'All selected functions'
                : (MODE_LABELS[modeKey] ?? modeKey)
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value='all'>{t('All selected functions')}</SelectItem>
            {Object.keys(working.bindings[props.model] ?? {})
              .filter((key) => key !== 'mixed_ref')
              .map((key) => (
                <SelectItem key={key} value={key}>
                  {t(MODE_LABELS[key] ?? key)}
                </SelectItem>
              ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <UnconfirmedInterfaces
        draft={working}
        catalog={props.catalog}
        models={
          props.catalog.interfaces ||
          !props.catalog.models[props.model]?.modes[modeKey]
            ? [props.model]
            : []
        }
        modeKey={modeKey}
        groupId={groupId}
        allParameters={allParameters}
        onChange={setWorking}
      />
      {referenceModel && (
        <Button
          variant='outline'
          onClick={() => {
            let next = clone(working)
            const keys = allParameters
              ? selectedParameterModes(next, props.model, groupId, kind)
              : [modeKey]
            for (const key of keys) {
              const current = effectiveMode(next, props.model, key)
              if (current && referenceModel.modes[key]) {
                next = applyIndividualFields(
                  next,
                  props.model,
                  key,
                  restoreDocumentRules(current, referenceModel, key)
                )
              }
            }
            setWorking(next)
          }}
        >
          {t('Restore document rules')}
        </Button>
      )}
      {effective && binding && editor === 'fields' && (
        <ParameterFields
          allowExclusion
          documentedNames={documentParameterNames(referenceModel)}
          mode={effective}
          contractMaximums={Object.fromEntries(
            Object.entries(referenceModel?.parameters ?? {}).flatMap(
              ([field, rule]) =>
                typeof rule.maxItems === 'number'
                  ? [[field, rule.maxItems]]
                  : []
            )
          )}
          capability={allParameters ? undefined : modeKey}
          advanced
          overrides={overrides}
          onClearOverride={clear}
          onChange={(value) =>
            setWorking(
              allParameters
                ? applyParameterScope(
                    working,
                    [props.model],
                    groupId,
                    kind,
                    effective,
                    value,
                    true
                  )
                : applyIndividualFields(working, props.model, modeKey, value)
            )
          }
        />
      )}
      {editor === 'json' && (
        <>
          <p className='text-muted-foreground text-sm'>
            {t(
              'Only explicit overrides are saved here. Unedited fields continue to inherit shared settings.'
            )}
          </p>
          <Textarea
            aria-label={t('Individual overrides JSON')}
            rows={16}
            value={json}
            onChange={(event) => setJSON(event.target.value)}
          />
        </>
      )}
      {!effective && (
        <p>
          {t(
            'This model needs a documented input capability before it can be configured.'
          )}
        </p>
      )}
    </Dialog>
  )
}
