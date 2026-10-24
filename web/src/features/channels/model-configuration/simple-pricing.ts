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
import { clone } from './configuration'
import type { Catalog, Configuration, Mode } from './types'
import { effectiveMode } from './workflow'

export type PricingRule = {
  method: 'fixed_markup' | 'percentage_markup' | 'direct_price'
  value: number | null
}
export const CUSTOMER_BILLING_METHODS: Record<string, string> = {
  request_count: 'Per request',
  seconds: 'Per second',
  image_count: 'Per image',
}
export type CustomerPriceFields = {
  unit: string
  value: string
  resolutions?: Record<string, string>
}
export type CustomerPriceEdits = Record<string, CustomerPriceFields>
export function videoPriceResolutions(
  document: Configuration,
  model: string,
  modeKey: string,
  allModes = false
): string[] {
  const allowed = new Set<string>()
  const keys = allModes
    ? Object.keys(document.bindings[model] ?? {})
    : [modeKey]
  for (const key of keys) {
    const mode = effectiveMode(document, model, key)
    if (!mode?.enabled || key.endsWith('image')) continue
    for (const field of ['resolution', 'size']) {
      const rule = mode.parameters?.[field]
      if (
        !rule ||
        mode.mapping?.[field]?.startsWith('@') ||
        rule.definition?.['x-business-allowed-values'] === 'unlimited'
      ) {
        continue
      }
      const candidates = rule.enum ?? rule.definition?.enum
      if (!Array.isArray(candidates)) continue
      for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue
        if (field === 'resolution') {
          if (candidate.trim()) allowed.add(candidate)
        } else {
          // Match the existing plugin's size-to-resolution billing fact.
          // Aspect ratios and model names never supply resolution choices.
          const dimensions = /^(\d{1,5})x(\d{1,5})$/i.exec(candidate)
          if (dimensions) {
            const height = Math.min(
              Number(dimensions[1]),
              Number(dimensions[2])
            )
            // The existing pixel-size plugin codec only publishes these usage
            // facts. Do not invent a new wire-to-billing mapping in this editor.
            if ([480, 720, 1080].includes(height)) allowed.add(`${height}p`)
          }
        }
      }
    }
  }
  return [...allowed]
}
export function readCustomerPrice(mode?: Mode): CustomerPriceFields {
  if (!mode?.billing || mode.billing.currency !== 'USD') {
    return { unit: '', value: '' }
  }
  const expression = mode.billing.expression.trim()
  let remainder = expression
  const prices: Record<string, CustomerPriceFields> = Object.create(null)
  let branch: RegExpExecArray | null
  while (
    (branch =
      /^(?:u\("resolution"\)|lower\(string\(u\("resolution"\)\)\)) == ("(?:[^"\\]|\\.)*") \? tier\(("(?:[^"\\]|\\.)*"), (.+?)\) : /.exec(
        remainder
      ))
  ) {
    let resolution: string
    let condition: string
    try {
      resolution = JSON.parse(branch[2])
      condition = JSON.parse(branch[1])
    } catch {
      // Custom expressions may use non-JSON string escapes. Preserve them as
      // advanced prices rather than crashing or rewriting their formula.
      return { unit: '', value: '' }
    }
    if (
      condition !==
      (branch[0].startsWith('lower(') ? resolution.toLowerCase() : resolution)
    ) {
      return { unit: '', value: '' }
    }
    if (prices[resolution]) return { unit: '', value: '' }
    prices[resolution] = readCustomerPrice({
      ...mode,
      billing: { expression: branch[3], currency: 'USD', confirmed: true },
    })
    remainder = remainder.slice(branch[0].length)
  }
  if (Object.keys(prices).length && mode?.billing) {
    const baseMatch = /^tier\("base", (.+)\)$/.exec(remainder)
    let base: CustomerPriceFields | undefined
    if (remainder === 'nil') {
      base = { unit: Object.values(prices)[0]?.unit ?? '', value: '' }
    } else if (baseMatch) {
      base = readCustomerPrice({
        ...mode,
        billing: { ...mode.billing, expression: baseMatch[1] },
      })
    }
    if (
      mode.billing.currency === 'USD' &&
      base?.unit &&
      Object.values(prices).every((price) => price.unit === base.unit)
    ) {
      return {
        ...base,
        resolutions: Object.fromEntries(
          Object.entries(prices).map(([resolution, price]) => [
            resolution,
            price.value,
          ])
        ),
      }
    }
    return { unit: '', value: '' }
  }
  const match = mode?.billing?.expression
    .trim()
    .match(
      /^(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*\*\s*u\("(request_count|seconds|image_count)"\)$/i
    )
  if (!match || mode?.billing?.currency !== 'USD') {
    return { unit: '', value: '' }
  }
  return { unit: match[2], value: match[1] }
}
export function customerPriceError(
  fields: CustomerPriceFields
): string | undefined {
  if (!Object.hasOwn(CUSTOMER_BILLING_METHODS, fields.unit)) {
    return 'Billing unit needs confirmation'
  }
  if (fields.resolutions) {
    const resolutions = fields.resolutions
    if (!['seconds', 'request_count'].includes(fields.unit)) {
      return 'Billing unit needs confirmation'
    }
    if (
      Object.keys(fields.resolutions).length < 2 ||
      Object.keys(fields.resolutions).some((key) => !key.trim()) ||
      new Set(Object.keys(resolutions).map((key) => key.toLowerCase())).size !==
        Object.keys(resolutions).length
    ) {
      return 'Enter a price value'
    }
    for (const resolution of Object.keys(resolutions)) {
      const error = customerPriceError({
        unit: fields.unit,
        value: fields.resolutions[resolution] ?? '',
      })
      if (error) return error
    }
    return undefined
  }
  if (fields.value.trim() === '') return 'Enter a price value'
  if (!Number.isFinite(Number(fields.value)) || Number(fields.value) < 0) {
    return 'Enter a non-negative price value'
  }
  return undefined
}
export function applyCustomerPrice(
  document: Configuration,
  model: string,
  modeKey: string,
  fields: CustomerPriceFields,
  allModes = false
): Configuration {
  if (customerPriceError(fields)) return document
  const next = clone(document)
  let expression = `${Number(fields.value)} * u("${fields.unit}")`
  if (fields.resolutions) {
    const resolutions = fields.resolutions
    const tiers = Object.keys(resolutions)
      .map(
        (resolution) =>
          `lower(string(u("resolution"))) == ${JSON.stringify(resolution.toLowerCase())} ? tier(${JSON.stringify(resolution)}, ${Number(fields.resolutions?.[resolution])} * u("${fields.unit}")) : `
      )
      .join('')
    // A missing/unpriced resolution must fail evaluation before submission,
    // rather than silently becoming a zero-price or invented fallback rate.
    expression = `${tiers}nil`
  }
  const keys = allModes
    ? Object.keys(next.bindings[model] ?? {}).filter(
        (key) => effectiveMode(next, model, key)?.enabled
      )
    : [modeKey]
  for (const key of keys) {
    const binding = next.bindings[model]?.[key]
    if (!binding) continue
    binding.billing = {
      expression,
      currency: 'USD',
      confirmed: true,
    }
    delete binding.pricing
  }
  return next
}

export function readUniformCustomerPrice(
  document: Configuration,
  model: string
) {
  const modes = Object.keys(document.bindings[model] ?? {})
    .map((key) => effectiveMode(document, model, key))
    .filter((mode) => mode?.enabled)
  const priced = modes.filter((mode) => mode?.billing?.expression)
  const signatures = new Set(
    priced.map((mode) =>
      JSON.stringify([
        mode?.billing?.expression.trim(),
        mode?.billing?.currency,
        mode?.billing?.confirmed,
      ])
    )
  )
  return {
    fields:
      signatures.size === 1
        ? readCustomerPrice(priced[0])
        : { unit: '', value: '' },
    mixed: signatures.size > 1,
    incomplete: priced.length > 0 && priced.length < modes.length,
    hasPrice: priced.length > 0,
    modeCount: modes.length,
  }
}
export function priceResult(
  mode: Mode,
  rule: PricingRule,
  unitFromContract?: string
): { expression?: string; unit?: string; amount?: number; reason?: string } {
  const unit = mode.cost.unit || unitFromContract
  const fact = (
    {
      request: 'request_count',
      request_count: 'request_count',
      image: 'image_count',
      image_count: 'image_count',
      second: 'seconds',
      seconds: 'seconds',
    } as Record<string, string>
  )[unit ?? '']
  if (rule.value === null) return { reason: 'Enter a price value', unit }
  if (!Number.isFinite(rule.value) || rule.value < 0) {
    return { reason: 'Enter a non-negative price value' }
  }
  if (!fact) return { reason: 'Billing unit needs confirmation', unit }
  const multiplier = `u("${fact}")`
  if (rule.method === 'direct_price') {
    return {
      expression: `${rule.value} * ${multiplier}`,
      unit,
      amount: rule.value,
    }
  }
  if (mode.cost.amount === null && !mode.cost.expression) {
    return {
      reason: 'Provider cost is unknown; existing selling price is preserved',
      unit,
    }
  }
  if (mode.cost.currency !== 'USD') {
    return {
      reason:
        'Currency conversion is not configured; existing selling price is preserved',
      unit,
    }
  }
  const base = mode.cost.expression || `${mode.cost.amount} * ${multiplier}`
  if (rule.method === 'fixed_markup') {
    return {
      expression: `(${base}) + ${rule.value} * ${multiplier}`,
      unit,
      amount: mode.cost.expression
        ? undefined
        : Number(mode.cost.amount) + rule.value,
    }
  }
  return {
    expression: `(${base}) * ${1 + rule.value / 100}`,
    unit,
    amount: mode.cost.expression
      ? undefined
      : Number(mode.cost.amount) * (1 + rule.value / 100),
  }
}
export function applyModelPricing(
  document: Configuration,
  catalog: Catalog,
  model: string,
  modeKey: string,
  rule: PricingRule,
  baseline?: Configuration
): Configuration {
  const next = clone(document)
  const mode = effectiveMode(next, model, modeKey)
  const binding = next.bindings[model]?.[modeKey]
  if (!mode || !binding) return next
  const result = priceResult(mode, rule, catalog.models[model]?.billingUnit)
  binding.pricing = clone(rule)
  if (result.expression) {
    binding.billing = {
      expression: result.expression,
      currency: 'USD',
      confirmed: true,
    }
  } else if (baseline) {
    binding.billing = clone(effectiveMode(baseline, model, modeKey)?.billing)
  }
  return next
}
