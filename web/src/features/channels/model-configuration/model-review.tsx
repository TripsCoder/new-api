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
import { t } from 'i18next'
import { useTranslation } from 'react-i18next'

import {
  priceResult,
  CUSTOMER_BILLING_METHODS,
  readCustomerPrice,
  type PricingRule,
} from './simple-pricing'
import {
  MODE_LABELS,
  type Catalog,
  type Configuration,
  type Mode,
  type InputCapabilities,
  type Parameter,
} from './types'
import { effectiveMode } from './workflow'

const labels: Record<string, string> = {
  prompt: '提示词',
  resolution: '分辨率',
  aspect_ratio: '画面比例',
  seconds: '时长',
  duration: '时长',
  images: '参考图片',
  image: '参考图片',
  videos: '参考视频',
  audios: '参考音频',
  n: '数量',
  seed: '随机种子',
  quality: '质量',
  first_frame: '首帧',
  last_frame: '尾帧',
  start_image_url: '首帧',
  end_image_url: '尾帧',
  generate_audio: '生成音频',
}
const units: Record<string, string> = {
  seconds: '秒',
  second: '秒',
  image_count: '张',
  image: '张',
  request_count: '次',
  request: '次',
}
function readable(value: unknown): string {
  if (value === undefined || value === null) return '未设置'
  if (typeof value === 'boolean') return value ? '已开启' : '已关闭'
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value)
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item !== 'object')) {
      return value.map(readable).join('、') || '空列表'
    }
    return `已设置 ${value.length} 项，详见高级详情`
  }
  return '已设置，详见高级详情'
}
function capabilities(value: InputCapabilities | undefined): string {
  if (!value) return '沿用原能力设置'
  return (
    [
      ['images', '参考图片'],
      ['videos', '参考视频'],
      ['audios', '参考音频'],
      ['firstFrame', '首帧'],
      ['lastFrame', '尾帧'],
    ] as const
  )
    .map(([key, label]) => `${label}：${value[key] ? '已开启' : '已关闭'}`)
    .join('；')
}
function parameter(value: Parameter | undefined): string {
  if (!value) return '未设置额外限制'
  const parts = [value.required ? '上游要求填写' : '可不填写']
  if (value.inputPolicy === 'upstream_default') {
    parts.push(t('Upstream only: configured default'))
  }
  if (value.enum) parts.push(`允许值：${readable(value.enum)}`)
  if (value.minimum !== undefined) parts.push(`最小值：${value.minimum}`)
  if (value.maximum !== undefined) parts.push(`最大值：${value.maximum}`)
  if (value.definition?.maxItems !== undefined) {
    parts.push(`最多素材数：${value.definition.maxItems}`)
  }
  if (value.default !== undefined) {
    parts.push(`默认值：${readable(value.default)}`)
  }
  if (parts.length === 1 && value.definition) {
    parts.push('保留文档中的结构和组合限制')
  }
  return parts.join('；')
}
function cost(mode: Mode | undefined): string {
  if (!mode) return '未设置'
  const value = mode.cost
  if (value.expression) return '按高级成本规则计费，原文见详情'
  if (value.amount === null) return '成本未知'
  return `${value.amount} ${value.currency || '币种待确认'} / ${units[value.unit ?? ''] ?? '单位待确认'}（${value.confirmed ? '已确认' : '参考成本，待核实'}）`
}
const reasons: Record<string, string> = {
  'Enter a price value': '数值待填写',
  'Enter a non-negative price value': '请填写有效的非负数值',
  'Billing unit needs confirmation': '计费单位待确认',
  'Provider cost is unknown; existing selling price is preserved':
    '上游成本未知，保留现有售价',
  'Currency conversion is not configured; existing selling price is preserved':
    '币种换算待确认，保留现有售价',
}
function price(
  mode: Mode | undefined,
  rule: PricingRule | undefined,
  unit: string | undefined,
  after: boolean,
  changed: boolean
): string {
  if (rule && mode) {
    const method = {
      fixed_markup: '固定加价',
      percentage_markup: '百分比加价',
      direct_price: '直接设置售价',
    }[rule.method]
    const result = priceResult(mode, rule, unit)
    const suffix =
      rule.method === 'percentage_markup'
        ? '%'
        : ` USD / ${units[result.unit ?? ''] ?? '单位待确认'}`
    let final = '按实际用量及高级规则计算'
    if (result.amount !== undefined) {
      final = `${Number(result.amount.toFixed(8))} USD / ${units[result.unit ?? ''] ?? '单位待确认'}`
    }
    if (result.reason) final = reasons[result.reason] ?? '待确认，详见高级详情'
    return `加价方式：${method}；数值：${rule.value === null ? '待填写' : `${rule.value}${suffix}`}；最终单位价格：${final}`
  }
  const customerPrice = readCustomerPrice(mode)
  if (customerPrice.unit) {
    if (customerPrice.resolutions) {
      const rates = Object.entries(customerPrice.resolutions)
        .map(([resolution, value]) => `${resolution}: ${value} USD`)
        .join(' · ')
      if (customerPrice.value === '') {
        return `${t(CUSTOMER_BILLING_METHODS[customerPrice.unit])}; ${rates}`
      }
      return t(
        '{{method}}; {{rates}}; other or unspecified resolutions: {{base}} USD',
        {
          method: t(CUSTOMER_BILLING_METHODS[customerPrice.unit]),
          rates,
          base: customerPrice.value,
        }
      )
    }
    return `计费方法：按${units[customerPrice.unit] ?? customerPrice.unit}；计费金额：${customerPrice.value} USD / ${units[customerPrice.unit] ?? customerPrice.unit}`
  }
  if (!mode?.billing?.expression) return '未设置售价'
  if (!after) return '原高级定价，原文见详情'
  return changed ? '已修改高级定价，原文见详情' : '保留原高级定价，原文见详情'
}
type Row = {
  id: string
  name: string
  before: string
  after: string
  rawBefore: unknown
  rawAfter: unknown
}
function describe(
  before: Mode | undefined,
  after: Mode | undefined,
  beforeRule: PricingRule | undefined,
  afterRule: PricingRule | undefined,
  unit: string | undefined
) {
  const rows: Row[] = []
  const add = (
    id: string,
    name: string,
    a: unknown,
    b: unknown,
    aText: string,
    bText: string
  ) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      rows.push({
        id,
        name,
        before: aText,
        after: bText,
        rawBefore: a,
        rawAfter: b,
      })
    }
  }
  add(
    'enabled',
    '功能状态',
    before?.enabled,
    after?.enabled,
    readable(before?.enabled),
    readable(after?.enabled)
  )
  for (const section of ['input', 'parameters', 'mapping'] as const) {
    const a = before?.[section] ?? {}
    const b = after?.[section] ?? {}
    for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const suffix = {
        input: '默认值',
        parameters: '允许值与限制',
        mapping: '上游处理方式',
      }[section]
      const show = (value: unknown) => {
        if (section === 'parameters') {
          return parameter(value as Parameter | undefined)
        }
        if (section === 'mapping') {
          if (value === undefined) return '沿用原处理方式'
          if (value === '@reject') return '传入时报错'
          if (value === '@ignore') return '明确忽略'
          return labels[String(value)]
            ? `发送为“${labels[String(value)]}”`
            : '发送到已配置的上游字段，详见高级详情'
        }
        return readable(value)
      }
      add(
        `${section}.${field}`,
        `${labels[field] ?? '其他参数'} · ${suffix}`,
        a[field],
        b[field],
        show(a[field]),
        show(b[field])
      )
    }
  }
  add('cost', '上游成本', before?.cost, after?.cost, cost(before), cost(after))
  const billingChanged =
    JSON.stringify(before?.billing) !== JSON.stringify(after?.billing)
  const priorPrice = {
    billing: before?.billing,
    rule: beforeRule,
    cost: beforeRule ? before?.cost : undefined,
  }
  const nextPrice = {
    billing: after?.billing,
    rule: afterRule,
    cost: afterRule ? after?.cost : undefined,
  }
  add(
    'price',
    '销售计价规则',
    priorPrice,
    nextPrice,
    price(before, beforeRule, unit, false, billingChanged),
    price(after, afterRule, unit, true, billingChanged)
  )
  add(
    'capabilities',
    '接受的素材类型',
    before?.capabilities,
    after?.capabilities,
    capabilities(before?.capabilities),
    capabilities(after?.capabilities)
  )
  if (
    rows.length &&
    before?.billing?.expression &&
    after?.billing?.expression &&
    !billingChanged &&
    !afterRule
  ) {
    rows.push({
      id: 'preserved-price',
      name: '销售计价规则',
      before: price(before, beforeRule, unit, false, false),
      after: price(after, afterRule, unit, true, false),
      rawBefore: before.billing,
      rawAfter: after.billing,
    })
  }
  return rows
}
export function ModelReview(props: {
  baseline: Configuration
  draft: Configuration
  catalog?: Catalog
  models?: string[]
}) {
  const { t } = useTranslation()
  const sections: {
    title: string
    models: { name: string; mode: string; rows: Row[] }[]
  }[] = [
    { title: '共享设置修改', models: [] },
    { title: '单独设置修改', models: [] },
    { title: '未变化', models: [] },
  ]
  for (const name of new Set(
    props.models ?? [
      ...Object.keys(props.baseline.bindings),
      ...Object.keys(props.draft.bindings),
    ]
  )) {
    let changed = false
    for (const mode of new Set([
      ...Object.keys(props.baseline.bindings[name] ?? {}),
      ...Object.keys(props.draft.bindings[name] ?? {}),
    ])) {
      const rows = describe(
        effectiveMode(props.baseline, name, mode),
        effectiveMode(props.draft, name, mode),
        props.baseline.bindings[name]?.[mode]?.pricing,
        props.draft.bindings[name]?.[mode]?.pricing,
        props.catalog?.models[name]?.billingUnit
      )
      if (!rows.length) continue
      changed = true
      const own =
        JSON.stringify({
          ...props.baseline.bindings[name]?.[mode],
          groupId: undefined,
        }) !==
        JSON.stringify({
          ...props.draft.bindings[name]?.[mode],
          groupId: undefined,
        })
      sections[own ? 1 : 0].models.push({ name, mode, rows })
    }
    if (!changed) sections[2].models.push({ name, mode: '', rows: [] })
  }
  return (
    <div className='space-y-5' data-testid='model-save-review'>
      {sections.map((section) => (
        <section key={section.title}>
          <h4 className='font-medium'>{section.title}</h4>
          {!section.models.length && (
            <p className='text-muted-foreground text-sm'>无</p>
          )}
          {section.models.map((item) => (
            <details
              key={`${item.name}|${item.mode}`}
              className='border-b py-3'
              open={item.rows.length > 0}
            >
              <summary className='cursor-pointer text-sm'>
                {item.name}
                {item.mode &&
                  ` · ${t(MODE_LABELS[item.mode] ?? 'Input capability')}`}
              </summary>
              {item.rows.length > 0 && (
                <>
                  <div className='text-muted-foreground grid grid-cols-3 gap-3 pt-3 text-xs'>
                    <span>参数</span>
                    <span>保存前</span>
                    <span>保存后</span>
                  </div>
                  {item.rows.map((row) => (
                    <div
                      key={row.id}
                      className='grid grid-cols-3 gap-3 py-2 text-sm'
                      data-testid='review-readable-row'
                    >
                      <span>{row.name}</span>
                      <span className='text-muted-foreground break-all'>
                        {row.before}
                      </span>
                      <span className='break-all'>{row.after}</span>
                    </div>
                  ))}
                  <details data-testid='review-raw-details'>
                    <summary className='cursor-pointer text-sm'>
                      高级：查看此模型配置原文
                    </summary>
                    <pre className='max-h-64 overflow-auto text-xs whitespace-pre-wrap'>
                      {JSON.stringify(
                        item.rows.map((row) => ({
                          parameter: row.id,
                          before: row.rawBefore,
                          after: row.rawAfter,
                        })),
                        null,
                        2
                      )}
                    </pre>
                  </details>
                </>
              )}
            </details>
          ))}
        </section>
      ))}
    </div>
  )
}
