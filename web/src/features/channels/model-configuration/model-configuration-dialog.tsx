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
import { useEffect, useMemo, useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Dialog } from '@/components/dialog'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { handleServerError } from '@/lib/handle-server-error'

import { UpstreamModelSelection } from '../components/upstream-model-selection'
import { useChannelModelDiscovery } from '../hooks/use-channel-model-discovery'
import { parseModelsString } from '../lib'
import { modelDiscoveryErrorMessage } from '../lib/model-discovery'
import type { Channel } from '../types'
import {
  checkModelConfiguration,
  tryModelConfiguration,
  getRealConfigurationTask,
  getRealConfigurationArtifacts,
  type RealCallResult,
  getModelConfiguration,
  getConfigurationAvailability,
  restoreModelConfiguration,
  saveModelConfiguration,
} from './api'
import {
  changes,
  clone,
  createSharedGroup,
  configurationModelChoices,
  restoreDocumentRules,
  selectionMatchesGroup,
  effectiveInput,
  isObject,
  parseSafe,
  readParameterRules,
  retainRequiredParameters,
  documentParameterNames,
  readConfiguration,
} from './configuration'
import {
  projectDocumentInterfaces,
  interfaceReference,
} from './document-interfaces'
import { IndividualModelDialog } from './individual-model-dialog'
import { MappingPreview } from './mapping-preview'
import { ModelReview } from './model-review'
import { ParameterFields } from './parameter-fields'
import { ParameterImport } from './parameter-import'
import { applyParameterScope, selectedParameterMode } from './parameter-scope'
import { parameterConfigurationIssues } from './parameter-validation'
import { PricingEditor } from './pricing-editor'
import { realTestExample, savedTestChoices } from './real-test'
import { RequestCheckSummary } from './request-check-summary'
import { SavedModelParametersDialog } from './saved-model-parameters-dialog'
import { SelectedParameterFields } from './selected-parameter-fields'
import { SharedParameterFields } from './shared-parameter-fields'
import { customerPriceError, type CustomerPriceEdits } from './simple-pricing'
import {
  MODE_LABELS,
  type CheckResult,
  type Configuration,
  type Mode,
} from './types'
import { UnconfirmedInterfaces } from './unconfirmed-interface'
import {
  missingExisting,
  effectiveMode,
  VIDEO_CAPABILITY_VIEWS,
  capabilityMode,
  capabilityEnabled,
  IMAGE_MODES,
} from './workflow'
import {
  MissingModels,
  FunctionChoice,
  ModelScope,
  ParameterComparison,
} from './workflow-panels'

const REAL_TASK_LABELS: Record<string, string> = {
  SUCCESS: 'Completed',
  FAILURE: 'Failed',
  IN_PROGRESS: 'In progress',
  SUBMITTED: 'Submitted',
  NOT_START: 'Queued',
}
const PROVIDER_COST_LABELS: Record<string, string> = {
  settled: 'Actual provider cost',
  estimated: 'Estimated provider cost',
  pending_bill_verification: 'Provider bill needs verification',
  pending_actual_usage: 'Waiting for actual provider usage',
}
const AVAILABILITY_LABELS: Record<string, string> = {
  available: 'Provider accepting requests',
  preparing: 'Provider preparing',
  maintenance: 'Provider maintenance',
  unavailable: 'Availability not confirmed',
}

export function ModelConfigurationDialog(props: {
  channel: Channel
  open: boolean
  preview?: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const saveLock = useRef(false)
  const client = useQueryClient()
  const queryKey = ['channels', 'model-configuration', props.channel.id]
  const query = useQuery({
    queryKey,
    queryFn: () => getModelConfiguration(props.channel.id),
    enabled: props.open,
  })
  const [maxEstimate, setMaxEstimate] = useState(''),
    [feeAck, setFeeAck] = useState(false),
    [unknownCostAck, setUnknownCostAck] = useState(false),
    [realPending, setRealPending] = useState(false)
  const [realTask, setRealTask] = useState<RealCallResult | null>(null),
    [realArtifacts, setRealArtifacts] = useState<
      { key: string; type: string; content_url: string }[]
    >([])
  const [draft, setDraft] = useState<Configuration | null>(null),
    [baseline, setBaseline] = useState<Configuration | null>(null)
  const [savedBatchModels, setSavedBatchModels] = useState<string[] | null>(
    null
  )
  const [realModelChoice, setRealModelChoice] = useState('')
  const [realModeChoice, setRealModeChoice] = useState('')
  const [realSampleTexts, setRealSampleTexts] = useState<
    Record<string, string>
  >({})
  const [realTaskTarget, setRealTaskTarget] = useState({ model: '', mode: '' })
  const [editingModel, setEditingModel] = useState<string | null>(null)
  const [previewModel, setPreviewModel] = useState<string | null>(null)
  const [sampleTexts, setSampleTexts] = useState<Record<string, string>>({})
  const [routeSnapshot, setRouteSnapshot] = useState(props.channel.models)
  useEffect(() => {
    if (query.data?.channelModels !== undefined) {
      setRouteSnapshot(query.data.channelModels)
    }
  }, [query.data?.channelModels])
  const [capabilityKey, setCapabilityKey] = useState('text_video')
  const [allParameters, setAllParameters] = useState(true)
  const [kind, setKind] = useState<'image' | 'video'>('video')
  const [removedModels, setRemovedModels] = useState<string[]>([])
  const [modelSearch, setModelSearch] = useState('')
  const [priceEdits, setPriceEdits] = useState<CustomerPriceEdits>({})
  const [step, setStep] = useState(0),
    [selected, setSelected] = useState<string[]>([]),
    [groupId, setGroupId] = useState(''),
    [modeKey, setModeKey] = useState('')
  const [member, setMember] = useState(''),
    [historyRevision, setHistoryRevision] = useState(''),
    [saving, setSaving] = useState(false),
    [checking, setChecking] = useState(false)
  const [results, setResults] = useState<
      Record<
        string,
        { fingerprint: string; result?: CheckResult; error?: string }
      >
    >({}),
    [undo, setUndo] = useState<Record<string, Mode[]>>({})
  const [raw, setRaw] = useState<Record<string, string>>({}),
    [rawDirty, setRawDirty] = useState<Record<string, boolean>>({}),
    [singleJSON, setSingleJSON] = useState<string | null>(null),
    [configurationJSON, setConfigurationJSON] = useState('')
  const request = useMemo(
    () => ({ kind: 'saved' as const, channelId: props.channel.id }),
    [props.channel.id]
  )
  const discovery = useChannelModelDiscovery({
    enabled: props.open,
    request,
    requiresEvidence: props.channel.type === 61,
  })
  useEffect(() => {
    if (props.open && query.data && !draft) {
      setDraft(clone(query.data.configuration))
      setBaseline(clone(query.data.configuration))
      setSelected(
        Object.keys(query.data.configuration.bindings).length
          ? Object.keys(query.data.configuration.bindings)
          : parseModelsString(routeSnapshot)
      )
    }
  }, [query.data, draft, routeSnapshot, props.open])
  useEffect(() => {
    if (props.open) return
    setDraft(null)
    setBaseline(null)
    setSelected([])
    setStep(0)
    setPreviewModel(null)
    setGroupId('')
    setModeKey('')
    setRemovedModels([])
    setModelSearch('')
    setPriceEdits({})
    setRaw({})
    setRawDirty({})
    setSingleJSON(null)
    setSampleTexts({})
    setSavedBatchModels(null)
    setRealModelChoice('')
    setRealModeChoice('')
    setRealSampleTexts({})
    setRealTaskTarget({ model: '', mode: '' })
    setResults({})
    setRealTask(null)
    setRealArtifacts([])
  }, [props.open])
  const missing = missingExisting(
    discovery.models,
    parseModelsString(routeSnapshot),
    discovery.status === 'success'
  )
  const configuredModels = parseModelsString(routeSnapshot)
  const returnedModels = [...new Set(discovery.models)]
  const newlyDiscovered = returnedModels.filter(
    (name) => !configuredModels.includes(name)
  )
  const configuredReturned = returnedModels.filter((name) =>
    configuredModels.includes(name)
  )
  const catalog = projectDocumentInterfaces(
    query.data?.catalog,
    [...new Set([...returnedModels, ...configuredModels, ...selected])],
    kind,
    draft
  )

  const availability = useQuery({
    queryKey: [
      'channels',
      'model-configuration-availability',
      props.channel.id,
    ],
    queryFn: () => getConfigurationAvailability(props.channel.id),
    enabled: props.open && catalog?.key === 'xcmapi_media',
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  })
  const group = draft?.groups[groupId],
    mode = group?.modes[modeKey],
    scope = `${groupId}|${modeKey}`
  const scopeModels = [...new Set(selected)].filter(
    (name) => !configuredModels.includes(name) && !removedModels.includes(name)
  )
  const linked = draft
    ? Object.keys(draft.bindings).filter(
        (name) =>
          scopeModels.includes(name) &&
          (modeKey && !(allParameters && step === 2)
            ? draft.bindings[name]?.[modeKey]?.groupId === groupId
            : Object.values(draft.bindings[name]).some(
                (binding) => binding.groupId === groupId
              ))
      )
    : []
  const typeSelected = scopeModels.filter(
    (name) =>
      !catalog?.models[name]?.kind ||
      catalog.models[name].kind === 'unknown' ||
      catalog.models[name].kind === kind
  )
  const testModel =
    linked.includes(member) || (!linked.length && scopeModels.includes(member))
      ? member
      : (linked.find(
          (model) => draft?.bindings[model]?.[modeKey]?.groupId === groupId
        ) ??
        linked[0] ??
        scopeModels[0] ??
        '')
  const viewKeys = (
    kind === 'image' ? IMAGE_MODES : VIDEO_CAPABILITY_VIEWS
  ).filter(
    (key) =>
      capabilityEnabled(
        draft ?? ({ groups: {}, bindings: {} } as Configuration),
        typeSelected,
        groupId,
        key
      ) &&
      typeSelected.some((name) => draft?.bindings[name]?.[capabilityMode(key)])
  )
  const testKey = `${testModel}|${capabilityKey || modeKey}`
  const example: Record<string, unknown> = {
    model: testModel,
    prompt: '请在这里填写测试提示词',
  }
  if (capabilityKey === 'image_video' || capabilityKey === 'edit_image') {
    example.images = [
      'https://replace-with-your-public-url.invalid/reference.png',
    ]
  }
  if (capabilityKey === 'first_frame' || capabilityKey === 'frames') {
    example.images = ['https://replace-with-your-public-url.invalid/first.png']
    if (capabilityKey === 'frames') {
      example.images = [
        'https://replace-with-your-public-url.invalid/first.png',
        'https://replace-with-your-public-url.invalid/last.png',
      ]
    }
  }
  if (capabilityKey === 'video_ref') {
    example.videos = [
      'https://replace-with-your-public-url.invalid/reference.mp4',
    ]
  }
  if (capabilityKey === 'audio_ref') {
    example.audios = [
      'https://replace-with-your-public-url.invalid/reference.mp3',
    ]
  }
  const sampleText = sampleTexts[testKey] ?? JSON.stringify(example, null, 2)
  let sampleError = ''
  let sampleInput: Record<string, unknown> = {}
  try {
    const value = parseSafe(sampleText)
    if (!isObject(value)) throw new Error('测试 JSON 必须是对象')
    if (value.model !== testModel) {
      throw new Error('测试 JSON 的模型必须与当前模型一致')
    }
    sampleInput = { ...value }
    delete sampleInput.model
  } catch (error) {
    sampleError = error instanceof Error ? error.message : '测试 JSON 无效'
  }
  const result = results[testKey]
  const fingerprint = draft
    ? JSON.stringify({
        revision: draft.revision,
        group,
        membership: draft.bindings[testModel],
        mode: modeKey,
        sampleInput,
      })
    : ''
  useEffect(() => {
    setFeeAck(false)
  }, [fingerprint, testModel, modeKey, props.channel.id])
  const changeRows =
    baseline && draft
      ? changes(baseline, draft).filter((row) => row.path !== 'revision')
      : []
  const realChoices = savedTestChoices(
    baseline,
    (savedBatchModels ?? scopeModels).filter(
      (name) => selected.includes(name) && !removedModels.includes(name)
    )
  )
  const realTestModel =
    realChoices.find((choice) => choice.model === realModelChoice)?.model ??
    realChoices[0]?.model ??
    ''
  const realModes =
    realChoices.find((choice) => choice.model === realTestModel)?.modes ?? []
  const realTestMode = realModes.includes(realModeChoice)
    ? realModeChoice
    : (realModes[0] ?? '')
  const realTestKey = JSON.stringify([realTestModel, realTestMode])
  const realSampleText =
    realSampleTexts[realTestKey] ??
    JSON.stringify(
      realTestExample(
        realTestModel,
        realTestMode,
        baseline
          ? effectiveMode(baseline, realTestModel, realTestMode)
          : undefined
      ),
      null,
      2
    )
  let realSampleInput: Record<string, unknown> = {}
  let realSampleError = ''
  try {
    const input = parseSafe(realSampleText)
    if (!isObject(input)) throw new Error('The test JSON must be an object')
    if (input.model !== realTestModel) {
      throw new Error('The test JSON model must match the selected model')
    }
    realSampleInput = { ...input }
    delete realSampleInput.model
  } catch (error) {
    realSampleError = t(
      error instanceof Error ? error.message : 'Invalid test JSON'
    )
  }
  useEffect(() => {
    setFeeAck(false)
  }, [realTestModel, realTestMode, realSampleText, baseline?.revision])
  const unknown = scopeModels.filter(
    (model) =>
      !catalog?.models[model]?.modes ||
      !Object.keys(catalog.models[model].modes).length
  )
  const interfaceGaps = scopeModels.flatMap((name) =>
    Object.keys(draft?.bindings[name] ?? {}).flatMap((key) => {
      if (!draft || !catalog) return []
      const value = effectiveMode(draft, name, key)
      if (!value?.enabled) return []
      const protocol = value.protocol
      if (!protocol && catalog.models[name]?.modes[key]) return []
      if (
        protocol?.confirmed &&
        interfaceReference(catalog, protocol.templateModel, name)?.modes[key]
      ) {
        return []
      }
      let message = 'Choose a documented interface'
      if (protocol) {
        message = protocol.confirmed
          ? 'selected protocol template does not implement this generation mode'
          : 'confirm protocol applicability before saving a manual binding'
      }
      return [{ name, key, message }]
    })
  )
  function updateMode(next: Mode, remember = false): void {
    if (!draft || !mode) return
    if (remember) {
      setUndo((previous) => ({
        ...previous,
        [scope]: [...(previous[scope] ?? []), clone(mode)].slice(-5),
      }))
    }
    const nextDraft = clone(draft)
    nextDraft.groups[groupId].modes[modeKey] = retainRequiredParameters(
      mode,
      next
    )
    // Required rules may be member exceptions when documents differ.
    for (const name of linked) {
      const memberMode = effectiveMode(draft, name, modeKey)
      for (const [field, parameter] of Object.entries(
        memberMode?.parameters ?? {}
      )) {
        if (!parameter.required) continue
        for (const section of ['input', 'parameters', 'mapping'] as const) {
          const edited = nextDraft.groups[groupId].modes[modeKey][section]
          if (!edited) continue
          const previous = mode[section] ?? {}
          if (Object.hasOwn(previous, field)) {
            Object.assign(edited, { [field]: clone(mode[section]?.[field]) })
          } else delete edited[field]
        }
      }
    }
    setDraft(nextDraft)
  }
  function begin(): void {
    if (!draft || !catalog) return
    if (!scopeModels.length) {
      if (removedModels.length) {
        setGroupId('')
        setModeKey('')
        setMember('')
        setStep(4)
        return
      }
      toast.error(t('Select at least one model'))
      return
    }
    setSavedBatchModels(null)
    const ids = [
      ...new Set(
        scopeModels.flatMap((model) =>
          Object.values(draft.bindings[model] ?? {}).map(
            (binding) => binding.groupId
          )
        )
      ),
    ]
    let next = draft,
      id = ids.length === 1 ? ids[0] : ''
    if (!selectionMatchesGroup(draft, catalog, scopeModels, id)) {
      const previousMembers = Object.keys(draft.bindings).filter((model) =>
        Object.values(draft.bindings[model]).some(
          (binding) => binding.groupId === id
        )
      )
      if (
        !id ||
        previousMembers.length !== scopeModels.length ||
        previousMembers.some((model) => !scopeModels.includes(model))
      ) {
        id = `shared-${crypto.randomUUID()}`
      }
      next = createSharedGroup(draft, catalog, scopeModels, id)
      setDraft(next)
    }
    setGroupId(id)
    setModeKey(
      Object.keys(next.groups[id].modes).find(
        (key) => next.groups[id].modes[key].enabled
      ) ??
        Object.keys(next.groups[id].modes)[0] ??
        ''
    )
    setMember(scopeModels[0])
    setKind(
      catalog.models[scopeModels[0]]?.kind === 'image' ? 'image' : 'video'
    )
    setStep(1)
  }
  async function check(): Promise<void> {
    if (!draft || !mode || !testModel || sampleError) return
    setChecking(true)
    try {
      const checked = await checkModelConfiguration(
        props.channel.id,
        draft,
        testModel,
        modeKey,
        sampleInput
      )
      setResults((previous) => ({
        ...previous,
        [testKey]: { fingerprint, result: checked },
      }))
    } catch (error) {
      setResults((previous) => ({
        ...previous,
        [testKey]: {
          fingerprint,
          error: error instanceof Error ? error.message : t('Check failed'),
        },
      }))
    } finally {
      setChecking(false)
    }
  }
  async function realCall(): Promise<void> {
    if (
      props.preview ||
      !baseline ||
      changeRows.length ||
      !feeAck ||
      realPending ||
      !realTestModel ||
      !realTestMode
    ) {
      return
    }
    setRealPending(true)
    setFeeAck(false)
    setRealArtifacts([])
    try {
      if (realSampleError) throw new Error(realSampleError)
      if (realSampleText.includes('.invalid/')) {
        throw new Error('请先替换测试素材占位地址')
      }
      const input = realSampleInput
      const created = await tryModelConfiguration(
        props.channel.id,
        baseline.revision,
        realTestModel,
        realTestMode,
        { ...effectiveInput(baseline, realTestModel, realTestMode), ...input },
        Number(maxEstimate),
        unknownCostAck
      )
      setRealTask(created)
      setRealTaskTarget({ model: realTestModel, mode: realTestMode })
    } catch (error) {
      if (
        error instanceof Error &&
        error.message ===
          'Input references do not match the selected generation mode'
      ) {
        toast.error(
          t(
            'Model {{model}}: input references do not match {{mode}}; select the matching saved mode or edit the reference fields',
            {
              model: realTestModel,
              mode: t(MODE_LABELS[realTestMode] ?? realTestMode),
            }
          )
        )
      } else {
        handleServerError(error)
      }
    } finally {
      setRealPending(false)
    }
  }
  async function refreshRealTask(): Promise<void> {
    if (!realTask || realPending) return
    setRealPending(true)
    try {
      const updated = await getRealConfigurationTask(
        props.channel.id,
        realTask.taskId
      )
      setRealTask({ ...realTask, ...updated })
      if (updated.status === 'SUCCESS') {
        setRealArtifacts(await getRealConfigurationArtifacts(realTask.taskId))
      }
    } catch (error) {
      handleServerError(error)
    } finally {
      setRealPending(false)
    }
  }
  async function save(): Promise<void> {
    if (!draft || saving || saveLock.current) return
    if (catalog) {
      const issues = parameterConfigurationIssues(draft, catalog, scopeModels)
      if (issues.length) {
        toast.error(issues[0])
        return
      }
    }
    const priceError = Object.values(priceEdits)
      .map(customerPriceError)
      .find(Boolean)
    if (priceError) {
      toast.error(t(priceError))
      return
    }
    saveLock.current = true
    setSaving(true)
    try {
      const saved = await saveModelConfiguration(
        props.channel.id,
        draft,
        scopeModels,
        removedModels,
        routeSnapshot
      )
      setDraft(saved)
      setSavedBatchModels(scopeModels.filter((name) => saved.bindings[name]))
      setRouteSnapshot((previous) =>
        previous
          .split(',')
          .filter((name) => !removedModels.includes(name.trim()))
          .join(',')
      )
      setRemovedModels([])
      setBaseline(clone(saved))
      await client.invalidateQueries({ queryKey })
      toast.success(t('Configuration saved and applied to this channel'))
    } catch (error) {
      handleServerError(error)
    } finally {
      saveLock.current = false
      setSaving(false)
    }
  }
  function exportJSON(value: unknown, name: string): void {
    const text = JSON.stringify(value, null, 2)
    try {
      parseSafe(text)
    } catch (error) {
      toast.error(t(error instanceof Error ? error.message : 'Export failed'))
      return
    }
    const url = URL.createObjectURL(
      new Blob([text], { type: 'application/json' })
    )
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  function next(): void {
    if (draft && catalog && step >= 2) {
      const issues = parameterConfigurationIssues(draft, catalog, scopeModels)
      if (issues.length) {
        toast.error(issues[0])
        return
      }
    }
    if (step === 0) {
      begin()
      return
    }
    if (step === 3 || step === 4) {
      const priceError = Object.values(priceEdits)
        .map(customerPriceError)
        .find(Boolean)
      if (priceError) {
        toast.error(t(priceError))
        return
      }
    }
    if (Object.values(rawDirty).some(Boolean) || singleJSON !== null) {
      toast.error(t('Apply or fix the JSON text before continuing'))
      return
    }
    if (step === 1) {
      const keys = kind === 'image' ? IMAGE_MODES : VIDEO_CAPABILITY_VIEWS
      if (!keys.some((key) => group?.modes[capabilityMode(key)]?.enabled)) {
        toast.error(t('Enable at least one generation mode'))
        return
      }
      const active =
        keys.find((key) => group?.modes[capabilityMode(key)]?.enabled) ?? ''
      setAllParameters(true)
      setCapabilityKey(active)
      setModeKey(capabilityMode(active))
    }
    if (step < 4) {
      setStep(step + 1)
      return
    }
    void save()
  }
  let nextLabel =
    step === 4
      ? t('Save and apply to this channel')
      : t(
          [
            'Next: output type and functions',
            'Next: documented parameters',
            'Next: model prices',
            'Next: check and save',
          ][step]
        )
  if (step === 0 && !scopeModels.length && removedModels.length) {
    nextLabel = t('Next: check and save')
  }

  return (
    <Dialog
      open={props.open}
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!saving) props.onOpenChange(open)
      }}
      title={t('Model and interface settings')}
      description={`${props.channel.name} · #${props.channel.id}`}
      contentClassName='sm:max-w-[min(96vw,1500px)]'
      contentHeight='min(84dvh, 1000px)'
      bodyClassName='space-y-6'
      footer={
        <>
          <span className='text-muted-foreground mr-auto text-sm'>
            {t('Channel keys and other channels will not change')}
          </span>
          <Button
            variant='outline'
            disabled={saving}
            onClick={() => props.onOpenChange(false)}
          >
            {t('Close')}
          </Button>
          <Button
            variant='outline'
            disabled={step === 0 || saving}
            onClick={() => {
              if (
                Object.values(rawDirty).some(Boolean) ||
                singleJSON !== null
              ) {
                toast.error(t('Apply or fix the JSON text before continuing'))
                return
              }
              setStep((value) => value - 1)
            }}
          >
            {t('Back')}
          </Button>
          <Button
            onClick={(event) => {
              if (event.detail > 1) return
              next()
            }}
            disabled={!draft || saving}
          >
            {saving ? t('Saving...') : nextLabel}
          </Button>
        </>
      }
    >
      <nav
        aria-label={t('Configuration steps')}
        className='flex flex-wrap gap-2'
      >
        {[
          'Select models',
          'Output type and functions',
          'Documented parameters',
          'Model prices',
          'Check and save',
        ].map((label, index) => (
          <Button
            key={label}
            variant={step === index ? 'default' : 'outline'}
            aria-current={step === index ? 'step' : undefined}
            disabled={index > step}
            onClick={() => {
              if (
                Object.values(rawDirty).some(Boolean) ||
                singleJSON !== null
              ) {
                toast.error(t('Apply or fix the JSON text before continuing'))
                return
              }
              setStep(index)
            }}
          >
            {index + 1}. {t(label)}
          </Button>
        ))}
      </nav>
      <div className='grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]'>
        <div className='min-w-0 space-y-6'>
          {query.isPending && <LoadingState />}
          {query.isError && (
            <ErrorState
              description={query.error.message}
              onRetry={() => void query.refetch()}
            />
          )}
          {draft && catalog && step === 0 && (
            <section className='space-y-4'>
              <div className='flex flex-wrap items-center justify-between gap-3'>
                <div>
                  <h3 className='font-semibold'>
                    {t('Select models to configure together')}
                  </h3>
                  <p className='text-muted-foreground text-sm'>
                    {t(
                      'Selecting models does not delete other models or change their keys'
                    )}
                  </p>
                </div>
                <Button
                  onClick={() => discovery.fetch()}
                  disabled={discovery.status === 'loading'}
                >
                  {discovery.status === 'loading'
                    ? t('Reading models...')
                    : t('Read model list')}
                </Button>
              </div>
              {discovery.status === 'error' && (
                <Alert variant='destructive'>
                  <AlertTitle>{t('Model list could not be read')}</AlertTitle>
                  <AlertDescription>
                    {modelDiscoveryErrorMessage(discovery.error, t)}
                  </AlertDescription>
                </Alert>
              )}
              {discovery.status === 'success' && (
                <p className='text-sm'>
                  {t('Models returned by the channel')}:{' '}
                  {discovery.models.length}.{' '}
                  {t(
                    'Missing models are kept; a public catalog is not added to this result.'
                  )}
                </p>
              )}
              {discovery.status === 'success' && (
                <div className='space-y-3'>
                  <Input
                    aria-label={t('Search models...')}
                    placeholder={t('Search models...')}
                    value={modelSearch}
                    onChange={(event) => setModelSearch(event.target.value)}
                  />
                  <Tabs defaultValue='new'>
                    <TabsList className='w-full'>
                      <TabsTrigger value='new'>
                        {t('Newly discovered models')} ({newlyDiscovered.length}
                        )
                      </TabsTrigger>
                      <TabsTrigger value='existing'>
                        {t('Configured')} ({configuredReturned.length})
                      </TabsTrigger>
                      <TabsTrigger value='removed'>
                        {t('Removed')} ({missing.length})
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value='new'>
                      <UpstreamModelSelection
                        models={newlyDiscovered}
                        selected={selected}
                        onChange={setSelected}
                        existingModels={configuredModels}
                        showChanges={false}
                        summaryText=''
                        search={modelSearch}
                        showSelectionSummary={false}
                      />
                    </TabsContent>
                    <TabsContent value='existing'>
                      <UpstreamModelSelection
                        models={configuredReturned}
                        onViewParameters={setPreviewModel}
                        selected={selected}
                        onChange={setSelected}
                        existingModels={configuredModels}
                        showChanges={false}
                        summaryText=''
                        search={modelSearch}
                        showSelectionSummary={false}
                      />
                    </TabsContent>
                    <TabsContent value='removed'>
                      <MissingModels
                        models={missing.filter((name) =>
                          name
                            .toLowerCase()
                            .includes(modelSearch.trim().toLowerCase())
                        )}
                        removed={removedModels}
                        onToggle={(name, keep) => {
                          setRemovedModels((previous) =>
                            keep
                              ? previous.filter((value) => value !== name)
                              : [...new Set([...previous, name])]
                          )
                          if (!keep) {
                            setSelected((previous) =>
                              previous.filter((value) => value !== name)
                            )
                          }
                        }}
                      />
                    </TabsContent>
                  </Tabs>
                  <p className='text-muted-foreground text-sm'>
                    {t('{{n}} model(s) selected', { n: scopeModels.length })}
                  </p>
                </div>
              )}
              {discovery.status !== 'success' && (
                <UpstreamModelSelection
                  models={configurationModelChoices(
                    [],
                    parseModelsString(routeSnapshot),
                    Object.keys(draft?.bindings ?? {}),
                    selected
                  ).filter((name) => !missing.includes(name))}
                  selected={selected}
                  onChange={setSelected}
                  existingModels={parseModelsString(routeSnapshot)}
                  onViewParameters={setPreviewModel}
                />
              )}
              <details>
                <summary className='cursor-pointer font-medium'>
                  {t('View documented models or enter a model ID')}
                </summary>
                <p className='text-muted-foreground my-3 text-sm'>
                  {t(
                    'These are documentation references, not a successful account model lookup'
                  )}
                </p>
                <Field>
                  <FieldLabel>{t('Add a model ID manually')}</FieldLabel>
                  <Input
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        const value = event.currentTarget.value.trim()
                        if (value) {
                          setSelected((previous) => [
                            ...new Set([...previous, value]),
                          ])
                          event.currentTarget.value = ''
                        }
                      }
                    }}
                    placeholder={t('Enter an exact model ID and press Enter')}
                  />
                </Field>
                <div className='mt-3 flex max-h-64 flex-wrap gap-2 overflow-auto'>
                  {Object.keys(catalog.models).map((model) => (
                    <Button
                      key={model}
                      size='sm'
                      variant={
                        selected.includes(model) ? 'secondary' : 'outline'
                      }
                      onClick={() =>
                        setSelected((previous) =>
                          previous.includes(model)
                            ? previous.filter((value) => value !== model)
                            : [...previous, model]
                        )
                      }
                    >
                      {model}
                    </Button>
                  ))}
                </div>
              </details>
              {unknown.length > 0 && (
                <Alert>
                  <AlertTitle>
                    {t('Some interface settings still need confirmation')}
                  </AlertTitle>
                  <AlertDescription>
                    {unknown.join(', ')}.{' '}
                    {t(
                      'These models can be kept as drafts; their capabilities are not guessed from names.'
                    )}
                  </AlertDescription>
                </Alert>
              )}
            </section>
          )}
          {draft && catalog && step === 1 && (
            <FunctionChoice
              draft={draft}
              catalog={catalog}
              selected={typeSelected}
              groupId={groupId}
              kind={kind}
              onKind={setKind}
              onChange={(next) => {
                setDraft(next)
              }}
            />
          )}
          {draft && catalog && step === 2 && (
            <section className='space-y-6'>
              {!group || !mode ? (
                <Alert>
                  <AlertTitle>
                    {t('No documented generation mode is available')}
                  </AlertTitle>
                  <AlertDescription>
                    {t(
                      'Go back and choose a documented model. Unknown models remain drafts.'
                    )}
                  </AlertDescription>
                </Alert>
              ) : (
                <>
                  <div className='bg-muted/40 rounded-lg border p-4'>
                    <h3 className='text-lg font-semibold'>
                      {t('Shared settings for selected models')} ·{' '}
                      {linked.length}
                    </h3>
                    <p className='text-muted-foreground text-sm'>
                      {t(
                        'Changes apply to all linked models. A model with individual settings keeps its own values.'
                      )}
                    </p>
                  </div>
                  <FieldGroup>
                    <Field>
                      <FieldLabel>
                        {t('Parameters for this function')}
                      </FieldLabel>
                      <Select
                        value={allParameters ? 'all' : capabilityKey}
                        onValueChange={(value) => {
                          if (
                            Object.values(rawDirty).some(Boolean) ||
                            singleJSON !== null
                          ) {
                            toast.error(
                              t(
                                'Apply or fix the JSON text before switching modes'
                              )
                            )
                            return
                          }
                          setAllParameters(value === 'all')
                          if (value === 'all') return
                          setCapabilityKey(String(value))
                          setModeKey(capabilityMode(String(value)))
                        }}
                      >
                        <SelectTrigger aria-label={t('Input capability')}>
                          <SelectValue>
                            {t(
                              allParameters
                                ? 'All selected functions'
                                : (MODE_LABELS[capabilityKey] ?? capabilityKey)
                            )}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value='all'>
                              {t('All selected functions')}
                            </SelectItem>
                            {viewKeys.map((key) => (
                              <SelectItem key={key} value={key}>
                                {t(MODE_LABELS[key] ?? key)}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                  </FieldGroup>

                  <UnconfirmedInterfaces
                    draft={draft}
                    catalog={catalog}
                    models={
                      catalog.interfaces
                        ? linked
                        : linked.filter(
                            (name) => !catalog.models[name]?.modes[modeKey]
                          )
                    }
                    modeKey={modeKey}
                    groupId={groupId}
                    allParameters={allParameters}
                    onChange={(next) => {
                      setDraft(next)
                    }}
                  />
                  <div className='flex flex-wrap gap-2'>
                    <Badge variant='secondary'>
                      {t(
                        linked.some(
                          (name) =>
                            !Object.keys(
                              selectedParameterMode(draft, name, groupId, kind)
                                .parameters ?? {}
                            ).length
                        )
                          ? 'Choose a documented interface'
                          : 'Document rules loaded; real availability is not verified'
                      )}
                    </Badge>
                    <Button
                      size='sm'
                      variant='outline'
                      onClick={() => {
                        const sourceModel = linked
                          .map(
                            (model) =>
                              catalog.models[model] ??
                              catalog.models[
                                effectiveMode(draft, model, modeKey)?.protocol
                                  ?.templateModel ?? ''
                              ]
                          )
                          .find((model) => model?.modes[modeKey])
                        if (!sourceModel) return
                        updateMode(
                          restoreDocumentRules(mode, sourceModel, modeKey),
                          true
                        )
                      }}
                    >
                      {t('Restore document rules')}
                    </Button>
                    <Button
                      size='sm'
                      variant='outline'
                      disabled={!undo[scope]?.length}
                      onClick={() => {
                        const values = [...(undo[scope] ?? [])],
                          old = values.pop()
                        if (old) {
                          updateMode(old)
                          setUndo((previous) => ({
                            ...previous,
                            [scope]: values,
                          }))
                        }
                      }}
                    >
                      {t('Undo last import or restore')}
                    </Button>
                  </div>
                  {allParameters ? (
                    <SelectedParameterFields
                      document={draft}
                      catalog={catalog}
                      models={linked.filter((name) =>
                        typeSelected.includes(name)
                      )}
                      groupId={groupId}
                      kind={kind}
                      onChange={(next) => {
                        setDraft(next)
                      }}
                    />
                  ) : (
                    <SharedParameterFields
                      document={draft}
                      catalog={catalog}
                      models={linked}
                      groupId={groupId}
                      modeKey={modeKey}
                      capability={capabilityKey}
                      onSharedChange={updateMode}
                      onChange={(next) => {
                        setDraft(next)
                      }}
                    />
                  )}
                  <ParameterComparison
                    draft={draft}
                    baseline={baseline ?? draft}
                    models={scopeModels.filter((name) => draft.bindings[name])}
                    modeKey={modeKey}
                  />
                  <MappingPreview
                    capability={allParameters ? undefined : capabilityKey}
                    documentedNames={documentParameterNames(
                      catalog.models[testModel] ??
                        catalog.models[
                          effectiveMode(draft, testModel, modeKey)?.protocol
                            ?.templateModel ?? ''
                        ]
                    )}
                    mode={
                      allParameters
                        ? selectedParameterMode(draft, testModel, groupId, kind)
                        : (effectiveMode(draft, testModel, modeKey) ?? mode)
                    }
                    onChange={(value) => {
                      if (allParameters) {
                        setDraft(
                          applyParameterScope(
                            draft,
                            [testModel],
                            groupId,
                            kind,
                            selectedParameterMode(
                              draft,
                              testModel,
                              groupId,
                              kind
                            ),
                            value,
                            true
                          )
                        )
                        return
                      }
                      const next = clone(draft)
                      const binding = next.bindings[testModel]?.[modeKey]
                      if (!binding) return
                      binding.mapping = value.mapping
                      setDraft(next)
                    }}
                  />
                  <Alert>
                    <AlertTitle>{t('Needs confirmation')}</AlertTitle>
                    <AlertDescription>
                      <p>
                        {t(
                          'Account cost and real availability have not been verified. Unknown cost does not mean free.'
                        )}
                      </p>
                      {[
                        ...new Set(
                          linked.flatMap(
                            (model) => catalog.models[model]?.warnings ?? []
                          )
                        ),
                      ].map((warning) => (
                        <p key={warning}>{warning}</p>
                      ))}
                      {linked.some(
                        (model) => !catalog.models[model]?.modes[modeKey]
                      ) && <p>{t('Interface settings needed')}</p>}
                    </AlertDescription>
                  </Alert>
                  <section className='space-y-3'>
                    <h3 className='font-semibold'>
                      {t('Check this model and generation mode')}
                    </h3>
                    <Select
                      value={testModel}
                      onValueChange={(value) => setMember(String(value))}
                    >
                      <SelectTrigger aria-label={t('Choose a model to check')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {linked.map((model) => (
                            <SelectItem key={model} value={model}>
                              {model}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <h4 className='font-medium'>
                      {t('No-charge request input preview')}
                    </h4>
                    <p className='text-muted-foreground text-sm'>
                      {t(
                        'Sample request values are used only for this check and are never saved as defaults.'
                      )}
                    </p>
                    <Field>
                      <FieldLabel>测试请求 JSON · {testModel}</FieldLabel>
                      <Textarea
                        rows={9}
                        aria-label='测试请求 JSON'
                        value={sampleText}
                        onChange={(event) =>
                          setSampleTexts((previous) => ({
                            ...previous,
                            [testKey]: event.target.value,
                          }))
                        }
                      />
                    </Field>
                    <p className='text-muted-foreground text-sm'>
                      示例中的 .invalid
                      地址是占位符，必须替换为真实可访问的素材地址。切换模型或能力会保留各自编辑的
                      JSON；不会自动覆盖。
                    </p>
                    {sampleError && (
                      <p role='alert' className='text-destructive text-sm'>
                        {sampleError}
                      </p>
                    )}
                    <Button
                      onClick={() => void check()}
                      disabled={
                        checking ||
                        !!sampleError ||
                        !draft.bindings[testModel]?.[modeKey]
                      }
                    >
                      {checking ? t('Checking...') : t('Check filled values')}
                    </Button>
                    <p className='text-muted-foreground text-sm'>
                      {t(
                        'This check sends no generation request. A passed check is not a successful real call. Each model and mode is checked separately.'
                      )}
                    </p>
                    <p className='text-muted-foreground text-sm'>
                      {t(
                        'Only the current model is checked offline. Interface applicability is confirmed when checking and saving; unconfirmed models do not block this check.'
                      )}
                    </p>
                    {result && (
                      <Alert variant={result.error ? 'destructive' : 'default'}>
                        <AlertTitle>
                          {result.error
                            ? t('Please correct the filled values')
                            : t('Input check passed; no real call was made')}
                        </AlertTitle>
                        <AlertDescription>
                          {result.fingerprint !== fingerprint && (
                            <p>
                              {t('Settings changed; this check is out of date')}
                            </p>
                          )}
                          {result.error && <p>{result.error}</p>}
                          {result.result && (
                            <RequestCheckSummary result={result.result} />
                          )}
                          <details>
                            <summary>
                              {t('View check details and content to send')}
                            </summary>
                            <pre className='mt-2 max-h-64 overflow-auto text-xs break-all whitespace-pre-wrap'>
                              {JSON.stringify(result.result ?? {}, null, 2)}
                            </pre>
                          </details>
                        </AlertDescription>
                      </Alert>
                    )}
                  </section>
                  <details className='space-y-4'>
                    <summary className='cursor-pointer font-medium'>
                      {t('Advanced: complete parameters, JSON and file import')}
                    </summary>
                    <ParameterFields
                      documentedNames={documentParameterNames(
                        catalog.models[testModel]
                      )}
                      capability={capabilityKey}
                      mode={mode}
                      onChange={updateMode}
                      advanced
                    />
                    <ParameterImport
                      key={scope}
                      model={testModel}
                      modeKey={modeKey}
                      mode={mode}
                      onApply={(nextMode) => updateMode(nextMode, true)}
                    />
                    <Button
                      variant='outline'
                      onClick={() =>
                        exportJSON(
                          {
                            format: 'channel-mode-parameters/v1',
                            scope: {
                              channelId: props.channel.id,
                              model: testModel,
                              mode: modeKey,
                            },
                            parameters: mode.input,
                            constraints: mode.parameters,
                            mapping: mode.mapping,
                          },
                          `channel-${props.channel.id}-${modeKey}.json`
                        )
                      }
                    >
                      {t('Export all parameters for this mode')}
                    </Button>
                    <Field>
                      <FieldLabel>{t('Send settings as JSON')}</FieldLabel>
                      <p className='text-muted-foreground text-sm'>
                        {t(
                          'JSON is parameter text in a fixed format. Invalid edits are kept until you fix and apply them.'
                        )}
                      </p>
                      <Textarea
                        rows={7}
                        aria-label={t('Shared request parameter JSON')}
                        value={
                          rawDirty[scope]
                            ? raw[scope]
                            : JSON.stringify(mode.input, null, 2)
                        }
                        onChange={(event) => {
                          setRaw((previous) => ({
                            ...previous,
                            [scope]: event.target.value,
                          }))
                          setRawDirty((previous) => ({
                            ...previous,
                            [scope]: true,
                          }))
                        }}
                      />
                    </Field>
                    <Button
                      variant='outline'
                      onClick={() => {
                        try {
                          const value = parseSafe(raw[scope] ?? '')
                          if (!isObject(value)) {
                            throw new Error('Import a JSON object')
                          }
                          updateMode({ ...mode, input: value })
                          setRawDirty((previous) => ({
                            ...previous,
                            [scope]: false,
                          }))
                        } catch (error) {
                          toast.error(
                            t(
                              error instanceof Error
                                ? error.message
                                : 'Import failed'
                            )
                          )
                        }
                      }}
                    >
                      {t('Check and apply JSON')}
                    </Button>
                    <Field>
                      <FieldLabel>
                        {t('Complete parameter rules and field connections')}
                      </FieldLabel>
                      <Textarea
                        rows={8}
                        defaultValue={JSON.stringify(
                          {
                            parameters: mode.parameters,
                            mapping: mode.mapping,
                          },
                          null,
                          2
                        )}
                        key={`rules-${scope}`}
                        onBlur={(event) => {
                          try {
                            const value = parseSafe(event.target.value)
                            if (
                              !isObject(value) ||
                              !isObject(value.parameters) ||
                              !isObject(value.mapping)
                            ) {
                              throw new Error(
                                'Enter parameter rules and field connections'
                              )
                            }
                            updateMode(
                              {
                                ...mode,
                                parameters: readParameterRules(
                                  value.parameters
                                ),
                                mapping: value.mapping as Record<
                                  string,
                                  string
                                >,
                              },
                              true
                            )
                          } catch (error) {
                            toast.error(
                              t(
                                error instanceof Error
                                  ? error.message
                                  : 'Import failed'
                              )
                            )
                          }
                        }}
                      />
                    </Field>
                  </details>
                  <details className='space-y-3'>
                    <summary className='cursor-pointer font-medium'>
                      {t('Advanced: document sources and original records')}
                    </summary>
                    <p className='text-sm'>
                      {t(
                        'Model catalog is optional. Missing sources do not block saving a draft.'
                      )}
                    </p>
                    <a
                      href={catalog.docsURL}
                      target='_blank'
                      rel='noreferrer'
                      className='underline'
                    >
                      {t('Open API documentation')}
                    </a>
                    {catalog.marketURL && (
                      <a
                        href={catalog.marketURL}
                        target='_blank'
                        rel='noreferrer'
                        className='ml-4 underline'
                      >
                        {t('Open public model catalog')}
                      </a>
                    )}
                    {catalog.documents.map((document) => (
                      <details key={document.id}>
                        <summary>
                          {document.title} · {document.method} {document.path}
                        </summary>
                        <p className='text-xs'>
                          {document.source.url} · {document.source.readAt} ·{' '}
                          {document.source.sha256}
                        </p>
                        <pre className='max-h-80 overflow-auto text-xs whitespace-pre-wrap'>
                          {JSON.stringify(
                            {
                              schema: document.schema,
                              description: document.description,
                            },
                            null,
                            2
                          )}
                        </pre>
                      </details>
                    ))}
                  </details>
                </>
              )}
            </section>
          )}

          {catalog?.key === 'xcmapi_media' && (
            <Alert>
              <AlertTitle>{t('Current XCM public availability')}</AlertTitle>
              <AlertDescription className='space-y-2'>
                <p>
                  {t(
                    'Enabled configuration and current provider availability are separate. Availability refreshes automatically before a real submission, including daily openings.'
                  )}
                </p>
                <p>
                  {testModel || t('Select a model')}:{' '}
                  {t(
                    AVAILABILITY_LABELS[
                      availability.data?.models[testModel] ?? ''
                    ] ?? 'Availability not confirmed'
                  )}
                </p>
                {availability.data?.fetchedAt ? (
                  <p>
                    {t('Checked at')}:{' '}
                    {new Date(
                      availability.data.fetchedAt * 1000
                    ).toLocaleString()}
                  </p>
                ) : null}
                <Button
                  size='sm'
                  variant='outline'
                  disabled={availability.isFetching}
                  onClick={() => void availability.refetch()}
                >
                  {t('Refresh availability')}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {draft && step === 3 && catalog && (
            <PricingEditor
              baseline={baseline ?? draft}
              catalog={catalog}
              draft={draft}
              models={scopeModels.filter((name) => draft.bindings[name])}
              modeKey={modeKey}
              allModes
              edits={priceEdits}
              onEdit={(key, fields) => {
                setPriceEdits((previous) => {
                  const next = { ...previous }
                  if (fields) next[key] = fields
                  else delete next[key]
                  return next
                })
              }}
              onChange={(next) => {
                setDraft(next)
              }}
            />
          )}
          {draft && step === 4 && (
            <section className='space-y-5'>
              <div>
                <h3 className='text-lg font-semibold'>
                  {t('Review changes before saving')}
                </h3>
                <p className='text-muted-foreground text-sm'>
                  {props.channel.name} · #{props.channel.id} ·{' '}
                  {t('Current version')}: {draft.revision}
                </p>
              </div>
              <Alert>
                <AlertTitle>
                  {t(
                    realTask
                      ? 'Real call submitted'
                      : 'No real generation call was made'
                  )}
                </AlertTitle>
                <AlertDescription>
                  {t(
                    'Checking filled values or viewing document examples does not verify account availability or final charges.'
                  )}
                </AlertDescription>
              </Alert>
              <details className='space-y-3 rounded-md border p-4'>
                <summary className='cursor-pointer font-medium'>
                  {t('Real generation test')}
                </summary>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor='real-test-model'>
                      {t('Saved model for this test')}
                    </FieldLabel>
                    <Select
                      value={realTestModel}
                      disabled={realPending || !realChoices.length}
                      onValueChange={(value) => {
                        setRealModelChoice(String(value))
                        setFeeAck(false)
                      }}
                    >
                      <SelectTrigger
                        id='real-test-model'
                        className='h-auto min-h-9 w-full [&_[data-slot=select-value]]:whitespace-normal'
                        aria-label={t('Saved model for this test')}
                      >
                        <SelectValue>
                          {realTestModel ||
                            t('No saved models in the current batch')}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {realChoices.map((choice) => (
                            <SelectItem key={choice.model} value={choice.model}>
                              {choice.model}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor='real-test-mode'>
                      {t('Enabled mode for this test')}
                    </FieldLabel>
                    <Select
                      value={realTestMode}
                      disabled={realPending || !realModes.length}
                      onValueChange={(value) => {
                        setRealModeChoice(String(value))
                        setFeeAck(false)
                      }}
                    >
                      <SelectTrigger
                        id='real-test-mode'
                        className='w-full'
                        aria-label={t('Enabled mode for this test')}
                      >
                        <SelectValue>
                          {t(
                            MODE_LABELS[realTestMode] ??
                              'Choose a generation mode'
                          )}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {realModes.map((key) => (
                            <SelectItem key={key} value={key}>
                              {t(MODE_LABELS[key] ?? key)}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                </FieldGroup>
                <p className='text-muted-foreground text-sm'>
                  {realChoices.length
                    ? t(
                        'Testing saved revision {{revision}}; only enabled modes of this batch are listed',
                        { revision: baseline?.revision }
                      )
                    : t(
                        'Save the current model selection before running a real test'
                      )}
                </p>
                <p className='text-muted-foreground text-sm'>
                  {t('会向上游发送请求，可能产生上游费用。请先保存配置。')}
                </p>
                <Field>
                  <FieldLabel>{t('Real call input JSON')}</FieldLabel>
                  <Textarea
                    rows={5}
                    aria-label={t('Real call input JSON')}
                    value={realSampleText}
                    onChange={(event) => {
                      setRealSampleTexts((previous) => ({
                        ...previous,
                        [realTestKey]: event.target.value,
                      }))
                      setFeeAck(false)
                    }}
                    placeholder='{"prompt":"..."}'
                  />
                </Field>
                {realSampleError && (
                  <p role='alert' className='text-destructive text-sm'>
                    {realSampleError}
                  </p>
                )}
                <Field>
                  <FieldLabel>
                    {t('Maximum estimated customer charge in USD')}
                  </FieldLabel>
                  <Input
                    type='number'
                    min='0'
                    step='any'
                    value={maxEstimate}
                    onChange={(event) => {
                      setMaxEstimate(event.target.value)
                      setFeeAck(false)
                    }}
                  />
                </Field>
                <Field orientation='horizontal'>
                  <Checkbox
                    id='real-test-unknown-cost'
                    checked={unknownCostAck}
                    onCheckedChange={setUnknownCostAck}
                  />
                  <FieldLabel htmlFor='real-test-unknown-cost'>
                    {t(
                      'I accept that the provider account cost may be unknown'
                    )}
                  </FieldLabel>
                </Field>
                <Field orientation='horizontal'>
                  <Checkbox
                    id='real-test-charge-ack'
                    checked={feeAck}
                    onCheckedChange={setFeeAck}
                  />
                  <FieldLabel htmlFor='real-test-charge-ack'>
                    {t('Charge my wallet for one real call on this channel')}
                  </FieldLabel>
                </Field>
                <Button
                  variant='outline'
                  disabled={
                    props.preview ||
                    !!realSampleError ||
                    realSampleText.includes('.invalid/') ||
                    realPending ||
                    saving ||
                    changeRows.length > 0 ||
                    !baseline?.revision ||
                    !feeAck ||
                    !realTestModel ||
                    !realTestMode ||
                    !Number.isFinite(Number(maxEstimate)) ||
                    Number(maxEstimate) <= 0
                  }
                  onClick={() => void realCall()}
                >
                  {t('Run one real call')}
                </Button>
                {changeRows.length > 0 && (
                  <p className='text-sm'>
                    {t('Save the configuration before a real call')}
                  </p>
                )}
                {realTask && (
                  <div className='space-y-2' aria-live='polite'>
                    <p className='text-sm break-all'>
                      {realTaskTarget.model} ·{' '}
                      {t(
                        MODE_LABELS[realTaskTarget.mode] ?? realTaskTarget.mode
                      )}{' '}
                      · {realTask.taskId} ·{' '}
                      {t(REAL_TASK_LABELS[realTask.status] ?? 'Queued')}{' '}
                      {realTask.progress}
                    </p>
                    {realTask.estimatedUSD !== undefined && (
                      <p className='text-sm'>
                        {t('Estimated customer charge')}: USD{' '}
                        {realTask.estimatedUSD}
                      </p>
                    )}
                    {realTask.providerCost && (
                      <p className='text-sm'>
                        {t('Provider account cost')}:{' '}
                        {realTask.providerCost.currency}{' '}
                        {realTask.providerCost.actual ??
                          realTask.providerCost.estimate ??
                          t('Unknown')}{' '}
                        ·{' '}
                        {t(
                          PROVIDER_COST_LABELS[realTask.providerCost.status] ??
                            'Unknown'
                        )}
                      </p>
                    )}
                    <Button
                      variant='outline'
                      disabled={realPending}
                      onClick={() => void refreshRealTask()}
                    >
                      {t('Refresh real task result')}
                    </Button>
                    {realArtifacts.map((artifact) => (
                      <a
                        key={artifact.key}
                        className='block text-sm underline'
                        href={artifact.content_url}
                        target='_blank'
                        rel='noreferrer'
                      >
                        {t('Open generated artifact')} · {artifact.type}
                      </a>
                    ))}
                  </div>
                )}
              </details>
              {removedModels.length > 0 && (
                <Alert variant='destructive'>
                  <AlertTitle>
                    {t('Models removed from this channel after saving')}
                  </AlertTitle>
                  <AlertDescription>
                    {removedModels.join(', ')} ·{' '}
                    {t('Historical tasks and keys are retained')}
                  </AlertDescription>
                </Alert>
              )}
              {interfaceGaps.length > 0 && (
                <Alert>
                  <AlertTitle>{t('Interface settings needed')}</AlertTitle>
                  <AlertDescription>
                    <ul className='list-inside list-disc'>
                      {interfaceGaps.map(({ name, key, message }) => (
                        <li key={`${name}-${key}`}>
                          {name} · {t(MODE_LABELS[key] ?? key)}: {t(message)}
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
              {baseline && (
                <ModelReview
                  baseline={baseline}
                  draft={draft}
                  catalog={catalog}
                  models={scopeModels}
                />
              )}
              <details>
                <summary className='cursor-pointer text-sm'>
                  高级：完整技术差异
                </summary>
                <div className='max-h-72 overflow-auto'>
                  {changeRows.map((row) => (
                    <details key={row.path} className='py-2'>
                      <summary className='cursor-pointer text-sm break-all'>
                        {row.path}
                      </summary>
                      <pre className='overflow-auto text-xs break-all whitespace-pre-wrap'>
                        {JSON.stringify(
                          { before: row.before, after: row.after },
                          null,
                          2
                        )}
                      </pre>
                    </details>
                  ))}
                </div>
              </details>
              <p className='text-muted-foreground text-sm'>
                {t(
                  'Save parameters and apply this batch of enabled new models and explicit removals to this channel. Other models stay unchanged.'
                )}
              </p>
              <details className='space-y-3'>
                <summary className='cursor-pointer font-medium'>
                  {t('Import, export and restore a saved configuration')}
                </summary>
                <Button
                  variant='outline'
                  onClick={() =>
                    exportJSON(
                      draft,
                      `channel-${props.channel.id}-configuration.json`
                    )
                  }
                >
                  {t('Export this channel configuration')}
                </Button>
                <Field>
                  <FieldLabel>
                    {t('Import channel configuration JSON')}
                  </FieldLabel>
                  <Textarea
                    rows={5}
                    value={configurationJSON}
                    onChange={(event) =>
                      setConfigurationJSON(event.target.value)
                    }
                  />
                </Field>
                <Button
                  variant='outline'
                  onClick={() => {
                    try {
                      const value = readConfiguration(
                        parseSafe(configurationJSON),
                        draft.provider
                      )
                      if (
                        !isObject(value) ||
                        value.format !== draft.format ||
                        value.provider !== draft.provider ||
                        !isObject(value.groups) ||
                        !isObject(value.bindings)
                      ) {
                        throw new Error(
                          'Configuration does not belong to this provider'
                        )
                      }
                      setDraft({
                        ...readConfiguration(value, draft.provider),
                        revision: draft.revision,
                      })
                    } catch (error) {
                      toast.error(
                        t(
                          error instanceof Error
                            ? error.message
                            : 'Import failed'
                        )
                      )
                    }
                  }}
                >
                  {t('Read configuration into this draft')}
                </Button>
                <Field>
                  <FieldLabel>{t('Previously saved version')}</FieldLabel>
                  <Select
                    value={historyRevision}
                    onValueChange={(value) => setHistoryRevision(String(value))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('Choose a saved version')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {query.data?.versions.map((version) => (
                          <SelectItem
                            key={version.revision}
                            value={String(version.revision)}
                          >
                            {version.revision}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Button
                  variant='outline'
                  disabled={!historyRevision || saving}
                  onClick={async () => {
                    setSaving(true)
                    try {
                      const restored = await restoreModelConfiguration(
                        props.channel.id,
                        Number(historyRevision),
                        draft.revision
                      )
                      setDraft(restored)
                      setBaseline(clone(restored))
                      await client.invalidateQueries({ queryKey })
                      toast.success(
                        t('Previous configuration restored as a new version')
                      )
                    } catch (error) {
                      handleServerError(error)
                    } finally {
                      setSaving(false)
                    }
                  }}
                >
                  {t('Restore the selected saved configuration')}
                </Button>
                <p className='text-muted-foreground text-sm'>
                  {t(
                    'Restoring creates a new saved version. It is different from restoring document rules, and does not change keys or historical tasks.'
                  )}
                </p>
              </details>
            </section>
          )}
        </div>
        {draft && baseline && (
          <ModelScope
            onIndividual={(name) => {
              if (scopeModels.includes(name)) setEditingModel(name)
            }}
            models={scopeModels}
            selected={selected}
            removed={removedModels}
            draft={draft}
            baseline={baseline}
            member={testModel}
            onMember={(name) => {
              if (!scopeModels.includes(name)) return
              if (singleJSON !== null) {
                toast.error(t('Apply or fix the JSON text before continuing'))
                return
              }
              setMember(name)
            }}
          />
        )}
      </div>
      {previewModel && (
        <SavedModelParametersDialog
          key={previewModel}
          channelId={props.channel.id}
          model={previewModel}
          onClose={() => setPreviewModel(null)}
        />
      )}
      {draft &&
        catalog &&
        editingModel &&
        scopeModels.includes(editingModel) && (
          <IndividualModelDialog
            key={editingModel}
            model={editingModel}
            document={draft}
            catalog={catalog}
            initialModeKey={allParameters ? 'all' : modeKey}
            initialKind={kind}
            onCancel={() => setEditingModel(null)}
            onApply={(next) => {
              setDraft(next)
              setEditingModel(null)
            }}
          />
        )}
    </Dialog>
  )
}
