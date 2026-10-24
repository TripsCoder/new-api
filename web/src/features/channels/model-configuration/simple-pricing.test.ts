import { describe, it, expect } from 'vitest'

import {
  priceResult,
  applyCustomerPrice,
  readCustomerPrice,
  customerPriceError,
  readUniformCustomerPrice,
  videoPriceResolutions,
} from './simple-pricing'
import type { Configuration, Mode } from './types'

const mode = (cost: Mode['cost']): Mode => ({ enabled: true, input: {}, cost })
describe('customer billing method and amount', () => {
  it('keeps documented resolution names and round trips arbitrary selected tiers', () => {
    const document: Configuration = {
      format: 'channel-model-configuration/v1',
      provider: 'fixture',
      revision: 1,
      groups: {
        g: {
          name: 'g',
          modes: {
            text_video: {
              ...mode({ amount: null, confirmed: false }),
              parameters: {
                resolution: { enum: ['480p', '768px', '2K', '4K'] },
              },
            },
          },
        },
      },
      bindings: {
        A: {
          text_video: {
            groupId: 'g',
            parameters: {
              resolution: { enum: ['768px', '2K', '4K'] },
            },
          },
        },
      },
    }
    const before = structuredClone(document)
    expect(videoPriceResolutions(document, 'A', 'text_video')).toEqual([
      '768px',
      '2K',
      '4K',
    ])
    const fields = {
      unit: 'seconds',
      value: '',
      resolutions: { '768px': '0', '2K': '0.2', '4K': '0.4' },
    }
    expect(customerPriceError(fields)).toBeUndefined()
    const saved = applyCustomerPrice(document, 'A', 'text_video', fields)
    expect(readUniformCustomerPrice(saved, 'A').fields).toEqual(fields)
    expect(saved.bindings.A.text_video.billing?.expression).toContain(
      '== "2k" ? tier("2K", 0.2 * u("seconds"))'
    )
    expect(document).toEqual(before)
    expect(saved.groups).toEqual(before.groups)
    expect(
      customerPriceError({ ...fields, resolutions: { '2K': '1', '2k': '2' } })
    ).toBeTruthy()
    const escaped = {
      ...fields,
      resolutions: { 'custom"tier': '1', '4K': '2' },
    }
    expect(
      readCustomerPrice({
        ...mode({ amount: null, confirmed: false }),
        billing: applyCustomerPrice(document, 'A', 'text_video', escaped)
          .bindings.A.text_video.billing,
      })
    ).toEqual(escaped)
  })
  it('derives resolution tiers from enabled effective parameter choices and pixel sizes', () => {
    const document: Configuration = {
      format: 'channel-model-configuration/v1',
      provider: 'fixture',
      revision: 1,
      groups: {
        g: {
          name: 'g',
          modes: {
            text_video: {
              ...mode({ amount: null, confirmed: false }),
              parameters: { resolution: { enum: ['480p', '720p', '1080p'] } },
            },
            video_ref: {
              ...mode({ amount: null, confirmed: false }),
              parameters: {
                size: { enum: ['1280x720', '720x1280', '1920x1080'] },
              },
            },
          },
        },
      },
      bindings: {
        A: {
          text_video: {
            groupId: 'g',
            parameters: { resolution: { enum: ['720p', '1080p'] } },
          },
          video_ref: { groupId: 'g' },
        },
      },
    }
    expect(videoPriceResolutions(document, 'A', 'text_video')).toEqual([
      '720p',
      '1080p',
    ])
    expect(videoPriceResolutions(document, 'A', 'video_ref')).toEqual([
      '720p',
      '1080p',
    ])
    document.bindings.A.text_video.parameters = {
      resolution: { enum: ['720p'] },
    }
    expect(videoPriceResolutions(document, 'A', 'text_video')).toEqual(['720p'])
    expect(videoPriceResolutions(document, 'A', 'text_video', true)).toEqual([
      '720p',
      '1080p',
    ])
    document.bindings.A.video_ref.enabled = false
    expect(videoPriceResolutions(document, 'A', 'text_video', true)).toEqual([
      '720p',
    ])
    for (const parameter of [
      { type: 'string' },
      { default: '1080p' },
      { enum: [] },
      {
        enum: ['720p'],
        definition: { 'x-business-allowed-values': 'unlimited' },
      },
    ]) {
      document.bindings.A.text_video.parameters = { resolution: parameter }
      expect(videoPriceResolutions(document, 'A', 'text_video')).toEqual([])
    }
    document.bindings.A.text_video.parameters = {
      size: { enum: ['1280x720', '720x1280', '720x720'] },
      resolution: { enum: [] },
    }
    expect(videoPriceResolutions(document, 'A', 'text_video')).toEqual(['720p'])
    document.bindings.A.text_video.mapping = { size: '@ignore' }
    expect(videoPriceResolutions(document, 'A', 'text_video')).toEqual([])
  })
  it('round trips selected resolution tiers without requiring or using a base rate', () => {
    const document: Configuration = {
      format: 'channel-model-configuration/v1',
      provider: 'fixture',
      revision: 1,
      groups: {
        g: {
          name: 'g',
          modes: { text_video: mode({ amount: null, confirmed: false }) },
        },
      },
      bindings: { A: { text_video: { groupId: 'g' } } },
    }
    const fields = {
      unit: 'seconds',
      value: '0.5',
      resolutions: { '720p': '0', '1080p': '0.3' },
    }
    for (const value of ['', '-1', 'Infinity']) {
      expect(customerPriceError({ ...fields, value })).toBeUndefined()
    }
    const next = applyCustomerPrice(document, 'A', 'text_video', fields)
    expect(next.bindings.A.text_video.billing?.expression).toBe(
      'lower(string(u("resolution"))) == "720p" ? tier("720p", 0 * u("seconds")) : lower(string(u("resolution"))) == "1080p" ? tier("1080p", 0.3 * u("seconds")) : nil'
    )
    expect(readUniformCustomerPrice(next, 'A').fields).toEqual({
      ...fields,
      value: '',
    })
    expect(
      readCustomerPrice({
        ...mode({ amount: null, confirmed: false }),
        billing: {
          expression:
            'u("resolution") == "720p" ? tier("720p", 0 * u("seconds")) : u("resolution") == "1080p" ? tier("1080p", 0.3 * u("seconds")) : tier("base", 0.5 * u("seconds"))',
          currency: 'USD',
          confirmed: true,
        },
      })
    ).toEqual(fields)
    expect(
      customerPriceError({ ...fields, resolutions: { '720p': '0' } })
    ).toBeTruthy()
    expect(
      customerPriceError({
        ...fields,
        resolutions: { '720p': '', '1080p': '0.3' },
      })
    ).toBeTruthy()
  })
  it('round trips resolution rates, preserves zero and rejects incomplete tiers', () => {
    const document: Configuration = {
      format: 'channel-model-configuration/v1',
      provider: 'fixture',
      revision: 1,
      groups: {
        g: {
          name: 'g',
          modes: { text_video: mode({ amount: null, confirmed: false }) },
        },
      },
      bindings: {
        A: { text_video: { groupId: 'g' } },
        B: { text_video: { groupId: 'g' } },
      },
    }
    const fields = {
      unit: 'seconds',
      value: '0.5',
      resolutions: { '480p': '0', '720p': '0.2', '1080p': '0.3' },
    }
    const next = applyCustomerPrice(document, 'A', 'text_video', fields)
    expect(next.bindings.A.text_video.billing?.expression).toBe(
      'lower(string(u("resolution"))) == "480p" ? tier("480p", 0 * u("seconds")) : lower(string(u("resolution"))) == "720p" ? tier("720p", 0.2 * u("seconds")) : lower(string(u("resolution"))) == "1080p" ? tier("1080p", 0.3 * u("seconds")) : nil'
    )
    expect(readUniformCustomerPrice(next, 'A').fields).toEqual({
      ...fields,
      value: '',
    })
    expect(next.bindings.B).toEqual(document.bindings.B)
    expect(next.groups).toEqual(document.groups)
    for (const value of ['', '-1', 'Infinity']) {
      const invalid = {
        ...fields,
        resolutions: { ...fields.resolutions, '720p': value },
      }
      expect(customerPriceError(invalid)).toBeTruthy()
      expect(applyCustomerPrice(next, 'A', 'text_video', invalid)).toBe(next)
    }
    const flat = applyCustomerPrice(next, 'A', 'text_video', {
      unit: 'seconds',
      value: '0.4',
    })
    expect(readUniformCustomerPrice(flat, 'A').fields).toEqual({
      unit: 'seconds',
      value: '0.4',
    })
  })
  it('sets a model rate across enabled modes once and preserves later mode exceptions', () => {
    const document: Configuration = {
      format: 'channel-model-configuration/v1',
      provider: 'fixture',
      revision: 1,
      groups: {
        g: {
          name: 'g',
          modes: {
            text_video: mode({ amount: null, confirmed: false }),
            image_video: mode({ amount: null, confirmed: false }),
            video_ref: mode({ amount: null, confirmed: false }),
            frames: {
              ...mode({ amount: null, confirmed: false }),
              enabled: false,
            },
          },
        },
      },
      bindings: {
        A: {
          text_video: { groupId: 'g' },
          image_video: { groupId: 'g' },
          video_ref: { groupId: 'g' },
          frames: { groupId: 'g' },
        },
        B: { text_video: { groupId: 'g' } },
      },
    }
    const uniform = applyCustomerPrice(
      document,
      'A',
      'text_video',
      { unit: 'request_count', value: '2' },
      true
    )
    for (const key of ['text_video', 'image_video', 'video_ref']) {
      expect(uniform.bindings.A[key].billing?.expression).toBe(
        '2 * u("request_count")'
      )
    }
    expect(uniform.bindings.A.frames).toEqual(document.bindings.A.frames)
    expect(uniform.bindings.B).toEqual(document.bindings.B)
    expect(uniform.groups).toEqual(document.groups)
    expect(readUniformCustomerPrice(uniform, 'A')).toMatchObject({
      fields: { unit: 'request_count', value: '2' },
      mixed: false,
      incomplete: false,
    })
    const exception = applyCustomerPrice(uniform, 'A', 'video_ref', {
      unit: 'seconds',
      value: '0.7',
    })
    expect(exception.bindings.A.text_video).toEqual(
      uniform.bindings.A.text_video
    )
    expect(exception.bindings.A.image_video).toEqual(
      uniform.bindings.A.image_video
    )
    expect(exception.bindings.A.video_ref.billing?.expression).toBe(
      '0.7 * u("seconds")'
    )
    expect(readUniformCustomerPrice(exception, 'A').mixed).toBe(true)
    const partial = applyCustomerPrice(document, 'A', 'image_video', {
      unit: 'request_count',
      value: '0',
    })
    expect(readUniformCustomerPrice(partial, 'A')).toMatchObject({
      fields: { unit: 'request_count', value: '0' },
      mixed: false,
      incomplete: true,
    })
  })
  it('round trips explicit request, second and image rates without using supplier costs', () => {
    const document: Configuration = {
      format: 'channel-model-configuration/v1',
      provider: 'fixture',
      revision: 1,
      groups: {
        g: {
          name: 'g',
          modes: {
            text_video: mode({
              amount: 99,
              unit: 'second',
              currency: 'CNY',
              confirmed: false,
            }),
          },
        },
      },
      bindings: {
        A: {
          text_video: {
            groupId: 'g',
            pricing: { method: 'percentage_markup', value: 25 },
          },
        },
        B: { text_video: { groupId: 'g' } },
      },
    }
    for (const unit of ['request_count', 'seconds', 'image_count']) {
      const next = applyCustomerPrice(document, 'A', 'text_video', {
        unit,
        value: '0.25',
      })
      const billing = next.bindings.A.text_video.billing
      expect(billing).toEqual({
        expression: `0.25 * u("${unit}")`,
        currency: 'USD',
        confirmed: true,
      })
      expect(
        readCustomerPrice({ ...document.groups.g.modes.text_video, billing })
      ).toEqual({ unit, value: '0.25' })
      expect(next.groups).toEqual(document.groups)
      expect(next.bindings.B).toEqual(document.bindings.B)
      expect(next.bindings.A.text_video.pricing).toBeUndefined()
    }
  })
  it('keeps blank/invalid drafts from becoming free prices and preserves advanced formulas', () => {
    for (const value of ['', '-1', 'NaN', 'Infinity']) {
      expect(customerPriceError({ unit: 'seconds', value })).toBeTruthy()
    }
    expect(customerPriceError({ unit: '', value: '1' })).toBeTruthy()
    expect(customerPriceError({ unit: 'seconds', value: '0' })).toBeUndefined()
    expect(
      readCustomerPrice({
        ...mode({ amount: null, confirmed: false }),
        billing: {
          expression: 'u("seconds") > 5 ? 12 : 5',
          currency: 'USD',
          confirmed: true,
        },
      })
    ).toEqual({ unit: '', value: '' })
  })
})
describe('markup calculations preserve pricing meaning', () => {
  it('does not turn unknown cost or a blank value into zero', () => {
    expect(
      priceResult(
        mode({
          amount: null,
          confirmed: false,
          unit: 'seconds',
          currency: 'USD',
        }),
        { method: 'fixed_markup', value: 1 }
      ).expression
    ).toBeUndefined()
    expect(
      priceResult(
        mode({ amount: 1, confirmed: false, unit: 'seconds', currency: 'USD' }),
        { method: 'direct_price', value: null }
      ).expression
    ).toBeUndefined()
  })
  it('keeps second/image/request units and separates percentage from fixed amounts', () => {
    expect(
      priceResult(
        mode({ amount: 2, confirmed: false, unit: 'seconds', currency: 'USD' }),
        { method: 'percentage_markup', value: 25 }
      )
    ).toMatchObject({ amount: 2.5, unit: 'seconds' })
    expect(
      priceResult(
        mode({
          amount: 2,
          confirmed: false,
          unit: 'image_count',
          currency: 'USD',
        }),
        { method: 'fixed_markup', value: 1 }
      )
    ).toMatchObject({ amount: 3, unit: 'image_count' })
    expect(
      priceResult(
        mode({ amount: null, confirmed: false }),
        { method: 'direct_price', value: 0 },
        'request_count'
      ).expression
    ).toBe('0 * u("request_count")')
  })
  it('never adds a USD markup to another currency and preserves complex formula structure', () => {
    expect(
      priceResult(
        mode({ amount: 1, confirmed: false, currency: 'CNY', unit: 'seconds' }),
        { method: 'fixed_markup', value: 1 }
      ).expression
    ).toBeUndefined()
    const complex = 'u("seconds") > 5 ? 10 : 4'
    const result = priceResult(
      mode({
        amount: null,
        confirmed: false,
        currency: 'USD',
        unit: 'seconds',
        expression: complex,
      }),
      { method: 'percentage_markup', value: 10 }
    )
    expect(result.expression).toBe(`(${complex}) * 1.1`)
    expect(result.amount).toBeUndefined()
  })
})
