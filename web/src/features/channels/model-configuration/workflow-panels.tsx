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

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table'

import { applyCapabilitySupplement } from './capability-supplement'
import { CapabilitySupplementEditor } from './capability-supplement-editor'
import { clone, changes, DURATION_ALIASES } from './configuration'
import {
  MODE_LABELS,
  type Catalog,
  type Configuration,
  type Cost,
  type Billing,
} from './types'
import {
  applyIndependentCapability,
  VIDEO_CAPABILITY_VIEWS,
  capabilityMode,
  capabilityEnabled,
  isCapabilitySubsetLocked,
  documentedReferenceSupport,
  effectiveMode,
  IMAGE_MODES,
} from './workflow'

export function MissingModels(props: {
  models: string[]
  removed: string[]
  onToggle: (name: string, keep: boolean) => void
}) {
  const { t } = useTranslation()
  const keptCount = props.models.filter(
    (name) => !props.removed.includes(name)
  ).length
  return (
    <section
      className='space-y-3 rounded-md border p-4'
      aria-label={t('Not returned this time (existing models)')}
    >
      <div className='flex items-center gap-2'>
        <Checkbox
          aria-label={`${t('Select all (filtered)')} · ${t('Keep model')}`}
          checked={props.models.length > 0 && keptCount === props.models.length}
          indeterminate={keptCount > 0 && keptCount < props.models.length}
          disabled={props.models.length === 0}
          onCheckedChange={(keep) => {
            for (const name of props.models) props.onToggle(name, keep === true)
          }}
        />
        <h3 className='font-semibold'>
          {t('Not returned this time (existing models)')} ·{' '}
          {props.models.length}
        </h3>
        <span className='text-muted-foreground ml-auto text-xs'>
          {keptCount} / {props.models.length}
        </span>
      </div>
      <p className='text-muted-foreground text-sm'>
        {t(
          'A missing response does not prove permanent removal. Keep these models unless you explicitly choose to remove them from this channel.'
        )}
      </p>
      <div className='grid gap-3 md:grid-cols-2'>
        {props.models.map((name) => (
          <label key={name} className='flex items-start gap-2 break-all'>
            <Checkbox
              aria-label={`${t('Keep model')}: ${name}`}
              checked={!props.removed.includes(name)}
              onCheckedChange={(keep) => props.onToggle(name, keep === true)}
            />
            <span className='text-sm'>{name}</span>
          </label>
        ))}
      </div>
      {props.removed.length > 0 && (
        <p className='text-destructive text-sm'>
          {t('Will be removed only after saving')}: {props.removed.join(', ')}
        </p>
      )}
    </section>
  )
}
export function FunctionChoice(props: {
  draft: Configuration
  catalog: Catalog
  selected: string[]
  groupId: string
  kind: 'image' | 'video'
  onKind: (kind: 'image' | 'video') => void
  onChange: (next: Configuration) => void
}) {
  const { t } = useTranslation()
  const modes = props.kind === 'image' ? IMAGE_MODES : VIDEO_CAPABILITY_VIEWS
  const referenceLabels: Record<string, string> = {
    images: 'Reference images',
    videos: 'Reference videos',
    audios: 'Reference audio',
  }
  const referenceFields = Object.keys(referenceLabels).filter(
    (field) =>
      !modes.includes(
        {
          images: 'image_video',
          videos: 'video_ref',
          audios: 'audio_ref',
        }[field] ?? ''
      )
  )
  return (
    <section className='space-y-5'>
      <h3 className='font-semibold'>
        {t('Choose output type, then supported functions')}
      </h3>
      <div className='flex gap-2' role='group' aria-label={t('Output type')}>
        {(['image', 'video'] as const).map((kind) => (
          <Button
            key={kind}
            variant={props.kind === kind ? 'default' : 'outline'}
            aria-pressed={props.kind === kind}
            onClick={() => props.onKind(kind)}
          >
            {t(kind === 'image' ? 'Image' : 'Video')}
          </Button>
        ))}
      </div>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Choose several functions. Requests may send any documented valid subset; reference materials are optional unless the upstream explicitly requires them. Other output types remain unchanged.'
        )}
      </p>
      <div className='divide-y'>
        {modes.map((key) => {
          const label = MODE_LABELS[key]
          const supported = props.selected.filter((name) => {
            const model = props.catalog.models[name]
            if (key === 'first_frame' && model?.capabilities) {
              return model.capabilities.firstFrame
            }
            if (key === 'frames' && model?.capabilities) {
              return (
                model.capabilities.firstFrame && model.capabilities.lastFrame
              )
            }
            if (key === 'mixed_ref' && model?.capabilities) {
              return model.capabilities.multipleReferences
            }
            return !!model?.modes[capabilityMode(key)]
          })
          return (
            <div key={key} className='space-y-2 py-3'>
              <label className='flex items-center gap-2 font-medium'>
                <Checkbox
                  aria-label={t(label)}
                  checked={capabilityEnabled(
                    props.draft,
                    props.selected,
                    props.groupId,
                    key
                  )}
                  disabled={
                    props.selected.length === 0 ||
                    isCapabilitySubsetLocked(
                      props.draft,
                      props.catalog,
                      props.selected,
                      key
                    )
                  }
                  onCheckedChange={(enabled) =>
                    props.onChange(
                      applyIndependentCapability(
                        props.draft,
                        props.catalog,
                        props.selected,
                        props.groupId,
                        key,
                        enabled === true
                      )
                    )
                  }
                />
                {t(label)}
                <Badge variant='outline'>
                  {supported.length} / {props.selected.length}
                </Badge>
              </label>
              <p className='text-muted-foreground text-sm'>
                {t('Documented for')}:{' '}
                {supported
                  .filter(
                    (name) =>
                      !Object.values(props.draft.bindings[name] ?? {}).some(
                        (binding) =>
                          binding.protocol?.supplement?.[capabilityMode(key)]
                      )
                  )
                  .join(', ') || t('Interface settings needed')}
              </p>
              {supported.some((name) =>
                Object.values(props.draft.bindings[name] ?? {}).some(
                  (binding) =>
                    binding.protocol?.supplement?.[capabilityMode(key)]
                )
              ) && (
                <p className='text-sm'>
                  {t('Supplement missing capability')}:{' '}
                  {supported
                    .filter((name) =>
                      Object.values(props.draft.bindings[name] ?? {}).some(
                        (binding) =>
                          binding.protocol?.supplement?.[capabilityMode(key)]
                      )
                    )
                    .join(', ')}
                </p>
              )}
              <CapabilitySupplementEditor
                capability={key}
                models={props.selected.filter(
                  (name) => !supported.includes(name)
                )}
                onApply={(supplement) =>
                  props.onChange(
                    applyCapabilitySupplement(
                      props.draft,
                      props.catalog,
                      props.selected.filter(
                        (name) => !supported.includes(name)
                      ),
                      props.groupId,
                      capabilityMode(key),
                      supplement
                    )
                  )
                }
              />
            </div>
          )
        })}
      </div>
      <h4 className='font-medium'>{t('Support by model')}</h4>
      <div className='overflow-auto'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Model')}</TableHead>
              {[...modes, ...referenceFields].map((key) => (
                <TableHead key={key}>
                  {t(MODE_LABELS[key] ?? referenceLabels[key] ?? key)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.selected.map((name) => (
              <TableRow key={name}>
                <TableCell className='max-w-64 break-all whitespace-normal'>
                  {name}
                </TableCell>
                {modes.map((key) => {
                  let status = props.catalog.models[name]?.modes[key]
                    ? 'Documented'
                    : 'Not confirmed'
                  if (
                    Object.values(props.draft.bindings[name] ?? {}).some(
                      (binding) =>
                        binding.protocol?.supplement?.[capabilityMode(key)]
                    )
                  ) {
                    status = 'Supplement missing capability'
                  }
                  return <TableCell key={key}>{t(status)}</TableCell>
                })}
                {referenceFields.map((field) => (
                  <TableCell key={field}>
                    {documentedReferenceSupport(props.catalog, name, field)
                      ? t('Documented')
                      : t('Not confirmed')}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}
export function ModelScope(props: {
  models: string[]
  selected: string[]
  removed: string[]
  draft: Configuration
  baseline: Configuration
  member: string
  onMember: (name: string) => void
  onIndividual: (name: string) => void
}) {
  const { t } = useTranslation()
  return (
    <aside
      className='space-y-3 xl:sticky xl:top-0 xl:self-start'
      aria-label={t('Actual affected models')}
    >
      <h3 className='font-semibold'>
        {t('Selected')} · {props.models.length}
      </h3>
      <p className='text-sm break-all'>
        {props.models.join(', ') || t('No models selected')}
      </p>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Only the selected members are edited. A shared group with other members is split before editing.'
        )}
      </p>
      <div className='max-h-96 overflow-auto rounded-md border'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Model')}</TableHead>
              <TableHead>{t('Scope')}</TableHead>
              <TableHead>{t('Saved settings')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.models.map((name) => (
              <TableRow
                key={name}
                data-state={name === props.member ? 'selected' : undefined}
              >
                <TableCell className='max-w-48 break-all whitespace-normal'>
                  <Button
                    size='sm'
                    variant='link'
                    className='h-auto p-0 text-left break-all whitespace-normal'
                    onClick={() => props.onMember(name)}
                  >
                    {name}
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    className='mt-1'
                    aria-label={`${name}: ${t('Individual settings')}`}
                    onClick={() => props.onIndividual(name)}
                  >
                    {t('Individual settings')}
                  </Button>
                </TableCell>
                <TableCell>
                  {props.removed.includes(name) && t('Remove from channel')}
                  {!props.removed.includes(name) &&
                    props.selected.includes(name) &&
                    t('Selected')}
                  {!props.removed.includes(name) &&
                    !props.selected.includes(name) &&
                    t('Not selected')}
                </TableCell>
                <TableCell>
                  {t(
                    props.baseline.bindings[name]
                      ? 'Configured'
                      : 'Not configured'
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </aside>
  )
}
const PARAMETER_NAMES: Record<string, string> = {
  prompt: '提示词',
  images: '参考图片',
  image: '参考图片',
  videos: '参考视频',
  audios: '参考音频',
  resolution: '分辨率',
  aspect_ratio: '画面比例',
  seconds: '时长',
  duration: '时长',
  n: '数量',
  seed: '随机种子',
  quality: '质量',
}
function describeParameter(value: unknown): string {
  if (value === undefined) return '未设置'
  if (value === true) return '开启'
  if (value === false) return '关闭'
  if (Array.isArray(value)) return value.map(String).join('、') || '空列表'
  if (typeof value === 'object') return '已设置'
  return String(value)
}
export function ParameterComparison(props: {
  draft: Configuration
  models: string[]
  modeKey: string
  baseline: Configuration
}) {
  const { t } = useTranslation()
  const names = [
    ...new Set(
      props.models.flatMap((name) =>
        Object.keys(
          effectiveMode(props.draft, name, props.modeKey)?.parameters ?? {}
        ).map((key) => (DURATION_ALIASES.includes(key) ? 'seconds' : key))
      )
    ),
  ]

  return (
    <details open className='space-y-3'>
      <summary className='cursor-pointer font-medium'>
        {t('Compare model parameters and current changes')}
      </summary>
      <div className='max-h-80 overflow-auto'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>参数</TableHead>
              {props.models.map((name) => (
                <TableHead
                  key={name}
                  className='max-w-64 min-w-40 break-all whitespace-normal'
                >
                  {name}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {names
              .filter((key) => key !== 'model' && key !== 'client_request_id')
              .map((key) => (
                <TableRow key={key}>
                  <TableCell>{PARAMETER_NAMES[key] ?? key}</TableCell>
                  {props.models.map((name) => {
                    const before = effectiveMode(
                      props.baseline,
                      name,
                      props.modeKey
                    )
                    const after = effectiveMode(
                      props.draft,
                      name,
                      props.modeKey
                    )
                    const field = DURATION_ALIASES.includes(key)
                      ? (DURATION_ALIASES.find(
                          (alias) => after?.parameters?.[alias]
                        ) ?? key)
                      : key
                    const previousField = DURATION_ALIASES.includes(key)
                      ? (DURATION_ALIASES.find(
                          (alias) => before?.parameters?.[alias]
                        ) ?? field)
                      : field
                    const p = after?.parameters?.[field]
                    return (
                      <TableCell
                        key={name}
                        className='max-w-64 whitespace-normal'
                      >
                        {p ? (
                          <div className='space-y-1 text-sm'>
                            <p>{p.required ? '上游要求填写' : '可不填写'}</p>
                            <p>
                              原默认：
                              {describeParameter(
                                before?.input[previousField] ??
                                  before?.parameters?.[previousField]?.default
                              )}
                            </p>
                            <p>
                              当前默认：
                              {describeParameter(
                                after?.input[field] ?? p.default
                              )}
                            </p>
                            {p.enum && (
                              <p>允许值：{describeParameter(p.enum)}</p>
                            )}
                            {p.definition?.maxItems !== undefined && (
                              <p>最多素材数：{String(p.definition.maxItems)}</p>
                            )}
                          </div>
                        ) : (
                          '此能力未配置该参数'
                        )}
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>
      <p className='text-muted-foreground text-sm'>
        对比各模型保存前与当前草稿的参数；单独设置继续独立生效。
      </p>
      <details>
        <summary className='cursor-pointer text-sm'>
          高级：原始配置与技术差异
        </summary>
        <pre className='max-h-48 overflow-auto text-xs whitespace-pre-wrap'>
          {JSON.stringify(
            changes(props.baseline.bindings, props.draft.bindings),
            null,
            2
          )}
        </pre>
      </details>
    </details>
  )
}
export function PerModelPrices(props: {
  draft: Configuration
  selected: string[]
  modeKey: string
  onChange: (next: Configuration) => void
}) {
  const { t } = useTranslation()
  const [cost, setCost] = useState('')
  const [sale, setSale] = useState('')
  function update(name: string, patch: { cost?: Cost; billing?: Billing }) {
    const next = clone(props.draft)
    const binding = next.bindings[name]?.[props.modeKey]
    if (!binding) return
    Object.assign(binding, patch)
    props.onChange(next)
  }
  return (
    <section className='space-y-4'>
      <h3 className='font-semibold'>
        {t('Independent prices for every model')}
      </h3>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Shared parameters never imply shared prices. Bulk values fill only empty rows; edit each row independently. Provider cost and selling price are separate.'
        )}
      </p>
      <div className='flex flex-wrap items-end gap-3'>
        <label className='space-y-2 text-sm'>
          {t('Default provider unit cost (USD)')}
          <Input
            type='number'
            min={0}
            step='any'
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        </label>
        <label className='space-y-2 text-sm'>
          {t('Default selling formula (USD)')}
          <Input value={sale} onChange={(e) => setSale(e.target.value)} />
        </label>
        <Button
          variant='outline'
          onClick={() => {
            const next = clone(props.draft)
            for (const name of props.selected) {
              const binding = next.bindings[name]?.[props.modeKey]
              const current = effectiveMode(next, name, props.modeKey)
              if (!binding || !current) continue
              if (cost !== '' && current.cost.amount === null) {
                binding.cost = {
                  ...current.cost,
                  amount: Number(cost),
                  currency: 'USD',
                  unit: current.cost.unit ?? 'request',
                  confirmed: false,
                }
              }
              if (sale.trim() && !current.billing?.expression) {
                binding.billing = {
                  expression: sale,
                  currency: 'USD',
                  confirmed: false,
                }
              }
            }
            props.onChange(next)
          }}
        >
          {t('Fill empty price rows')}
        </Button>
      </div>
      <div className='overflow-auto'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Model')}</TableHead>
              <TableHead>{t('Provider unit cost')}</TableHead>
              <TableHead>{t('Currency')}</TableHead>
              <TableHead>{t('Billing unit')}</TableHead>
              <TableHead>{t('Selling price formula in USD')}</TableHead>
              <TableHead>{t('Use selling price')}</TableHead>
              <TableHead>{t('Account cost evidence')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.selected.map((name) => {
              const current = effectiveMode(props.draft, name, props.modeKey)
              return (
                <TableRow key={name}>
                  <TableCell className='max-w-64 break-all whitespace-normal'>
                    {name}
                    {!current && <p>{t('This function is not configured')}</p>}
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label={`${name}: ${t('Provider unit cost')}`}
                      type='number'
                      min={0}
                      step='any'
                      disabled={!current}
                      value={current?.cost.amount ?? ''}
                      onChange={(e) =>
                        current &&
                        update(name, {
                          cost: {
                            ...current.cost,
                            amount:
                              e.target.value === ''
                                ? null
                                : Number(e.target.value),
                            confirmed: false,
                          },
                        })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label={`${name}: ${t('Currency')}`}
                      disabled={!current}
                      value={current?.cost.currency ?? ''}
                      onChange={(e) =>
                        current &&
                        update(name, {
                          cost: {
                            ...current.cost,
                            currency: e.target.value,
                            confirmed: false,
                          },
                        })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label={`${name}: ${t('Billing unit')}`}
                      disabled={!current}
                      value={current?.cost.unit ?? ''}
                      onChange={(e) =>
                        current &&
                        update(name, {
                          cost: {
                            ...current.cost,
                            unit: e.target.value,
                            confirmed: false,
                          },
                        })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label={`${name}: ${t('Selling price formula in USD')}`}
                      disabled={!current}
                      value={current?.billing?.expression ?? ''}
                      onChange={(e) =>
                        update(name, {
                          billing: {
                            expression: e.target.value,
                            currency: 'USD',
                            confirmed: false,
                          },
                        })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Checkbox
                      aria-label={`${name}: ${t('Use selling price')}`}
                      disabled={!current?.billing?.expression}
                      checked={current?.billing?.confirmed ?? false}
                      onCheckedChange={(confirmed) =>
                        update(name, {
                          billing: {
                            expression: current?.billing?.expression ?? '',
                            currency: 'USD',
                            confirmed: confirmed === true,
                          },
                        })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    {current && (
                      <details className='min-w-56 space-y-2'>
                        <summary>{t('Account cost evidence')}</summary>
                        <Input
                          aria-label={`${name}: ${t('Cost evidence URL')}`}
                          placeholder='https://'
                          value={current.cost.source?.url ?? ''}
                          onChange={(event) =>
                            update(name, {
                              cost: {
                                ...current.cost,
                                confirmed: false,
                                source: {
                                  url: event.target.value,
                                  status: 'unverified',
                                },
                              },
                            })
                          }
                        />
                        <Input
                          aria-label={`${name}: ${t('Optional account cost formula')}`}
                          value={current.cost.expression ?? ''}
                          onChange={(event) =>
                            update(name, {
                              cost: {
                                ...current.cost,
                                expression: event.target.value,
                                confirmed: false,
                              },
                            })
                          }
                        />
                        <label className='flex gap-2'>
                          <Checkbox
                            aria-label={`${name}: ${t('I checked the cost for this account')}`}
                            disabled={
                              current.cost.amount === null ||
                              !current.cost.unit ||
                              !current.cost.currency ||
                              !current.cost.source?.url
                            }
                            checked={current.cost.confirmed}
                            onCheckedChange={(checked) =>
                              update(name, {
                                cost: {
                                  ...current.cost,
                                  confirmed: checked === true,
                                },
                              })
                            }
                          />
                          {t('I checked the cost for this account')}
                        </label>
                      </details>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Blank provider cost means unknown, not zero. A reference price is not a verified account cost. Existing selling prices remain until explicitly enabled.'
        )}
      </p>
    </section>
  )
}
