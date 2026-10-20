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
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, it, expect } from 'vitest'

import {
  parseSafe,
  createSharedGroup,
  configurationModelChoices,
  restoreDocumentRules,
  selectionMatchesGroup,
  effectiveInput,
  readConfiguration,
  importCandidate,
  applyCandidate,
  acceptsStringArrayItems,
  modeFromDocument,
  parameterKeys,
  retainRequiredParameters,
  documentParameterNames,
} from './configuration'
import type { Configuration, Catalog, Mode } from './types'

const empty = (): Configuration => ({
  format: 'channel-model-configuration/v1',
  revision: 0,
  provider: 'paisio_media',
  groups: {},
  bindings: {},
})
const mode = (n: number): Mode => ({
  enabled: true,
  input: { n, async: false },
  parameters: { n: { type: 'integer' } },
  mapping: {},
  cost: { amount: null, confirmed: false },
})
const catalog = {
  models: {
    a: {
      modes: { text_image: { required: [] } },
      parameters: {},
      source: { url: 'https://example.com' },
    },
    b: {
      modes: { text_image: { required: [] } },
      parameters: {},
      source: { url: 'https://example.com' },
    },
  },
} as unknown as Catalog
describe('channel model configuration', () => {
  it('keeps all six real catalogs scoped to their selected documented modes', () => {
    const catalogs = JSON.parse(
      readFileSync(path.resolve('../pkg/modelconfig/catalog.json'), 'utf8')
    ) as { providers: Record<string, Catalog> }
    for (const provider of Object.values(catalogs.providers)) {
      for (const model of Object.values(provider.models)) {
        for (const key of Object.keys(model.modes)) {
          const mode = modeFromDocument(model, key)
          for (const field of Object.keys(mode.parameters ?? {})) {
            expect(
              model.parameters,
              `${provider.key}/${model.id}/${key}/${field}`
            ).toHaveProperty(field)
          }
          for (const [field, target] of Object.entries(mode.mapping ?? {})) {
            expect(mode.parameters).toHaveProperty(
              target.startsWith('@') ? field : target
            )
          }
          if (key === 'text_image' || key === 'text_video') {
            for (const field of [
              'images',
              'videos',
              'audios',
              'start_image_url',
              'end_image_url',
            ]) {
              if (
                !model.modes[key].required.includes(field) &&
                model.parameters[field]?.required !== true
              ) {
                expect(mode.parameters).not.toHaveProperty(field)
              }
            }
          }
          for (const field of [
            'image_size',
            'resolution',
            'quality',
            'n',
            'seed',
          ]) {
            if (model.parameters[field]) {
              expect(mode.parameters).toHaveProperty(field)
            }
          }
          for (const field of model.modes[key].required) {
            if (
              model.parameters[field] &&
              field !== 'model' &&
              field !== 'client_request_id'
            ) {
              expect(mode.parameters?.[field].required).toBe(true)
            }
          }
        }
      }
    }
  })

  it('initializes only the selected documented mode without generic image or video fields', () => {
    const reference = {
      ...catalog.models.a,
      kind: 'video',
      parameters: {
        prompt: { type: 'string', required: true },
        seconds: { type: 'integer' },
        images: { type: 'array', default: [] },
        videos: { type: 'array' },
        audios: { type: 'array' },
        start_image_url: { type: 'string' },
        end_image_url: { type: 'string' },
      },
      mapping: {
        duration: 'seconds',
        images: 'images',
        videos: 'videos',
        audios: 'audios',
      },
      modes: {
        text_video: { required: ['prompt'] },
        image_video: { required: ['prompt', 'images'] },
        frames: { required: [] },
        mixed_ref: { required: [] },
      },
    }
    const plain = modeFromDocument(reference, 'text_video')
    expect(Object.keys(plain.parameters ?? {})).toEqual(['prompt', 'seconds'])
    expect(plain.input).not.toHaveProperty('images')
    expect(plain.mapping).toEqual({
      duration: 'seconds',
      prompt: 'prompt',
      seconds: 'seconds',
    })
    const imageVideo = modeFromDocument(reference, 'image_video')
    expect(imageVideo.parameters?.images.required).toBe(true)
    expect(Object.keys(imageVideo.parameters ?? {})).toEqual([
      'prompt',
      'seconds',
      'images',
    ])
    expect(modeFromDocument(reference, 'frames').parameters).toHaveProperty(
      'end_image_url'
    )
    expect(modeFromDocument(reference, 'mixed_ref').parameters).toHaveProperty(
      'audios'
    )
    const documentedSeed = modeFromDocument(
      {
        ...reference,
        parameters: {
          ...reference.parameters,
          seed: { type: 'integer' },
          quality: { type: 'string' },
        },
      },
      'text_video'
    )
    expect(documentedSeed.parameters).toHaveProperty('seed')
    expect(documentedSeed.parameters).toHaveProperty('quality')
    const requiredReference = modeFromDocument(
      {
        ...reference,
        parameters: {
          ...reference.parameters,
          images: { type: 'array', required: true },
        },
      },
      'audio_ref'
    )
    expect(requiredReference.parameters?.images.required).toBe(true)
  })

  it('inherits required fields by capability, protects them against imports, and leaves optional zero and false editable', () => {
    const reference = {
      ...catalog.models.a,
      parameters: {
        prompt: { type: 'string', required: true },
        images: { type: 'array' },
        seconds: { type: 'integer' },
      },
      modes: {
        text_video: { required: ['prompt'] },
        image_video: { required: ['prompt', 'images'] },
      },
    }
    const plain = modeFromDocument(reference, 'text_video')
    const image = modeFromDocument(reference, 'image_video')
    expect(
      documentParameterNames({
        ...reference,
        documentedParameters: { duration: { type: 'integer' } },
      })
    ).toEqual({ seconds: 'duration' })
    expect(plain.parameters?.images?.required).not.toBe(true)
    expect(image.parameters?.images.required).toBe(true)
    const edited = {
      ...plain,
      input: { prompt: 'saved default', seconds: 0, async: false },
      parameters: { prompt: { required: false } },
      mapping: { prompt: '@ignore' },
    }
    const next = retainRequiredParameters(plain, edited)
    expect(next.parameters?.prompt).toEqual(plain.parameters?.prompt)
    expect(next.mapping?.prompt).toBe('prompt')
    expect(next.input).toEqual({ seconds: 0, async: false })
    expect(
      parameterKeys({
        ...plain,
        mapping: {
          seconds: 'seconds',
          duration: 'seconds',
          duration_seconds: 'seconds',
        },
      }).filter((key) =>
        ['seconds', 'duration', 'duration_seconds'].includes(key)
      )
    ).toEqual(['seconds'])
  })
  it('rejects credentials, unsafe fields and oversized imports', () => {
    for (const text of [
      '{"api_key":"x"}',
      '{"__proto__":{}}',
      '{"nested":{"Authorization":"x"}}',
      '{"prompt":"Bearer abc"}',
    ]) {
      expect(() => parseSafe(text)).toThrow()
    }
    expect(() => parseSafe(' '.repeat(1000001))).toThrow()
  })
  it('rejects malformed nested configuration before rendering', () => {
    for (const value of [
      { ...empty(), groups: { x: null } },
      { ...empty(), bindings: { a: { text_image: { groupId: 'missing' } } } },
    ]) {
      expect(() => readConfiguration(value, 'paisio_media')).toThrow()
    }
    expect(readConfiguration(empty(), 'paisio_media')).toEqual(empty())
  })
  it('preserves model differences and all enabled modes when grouping', () => {
    const d = empty()
    d.groups.a = {
      name: 'A',
      modes: { text_image: mode(1), edit_image: mode(3) },
    }
    d.groups.b = {
      name: 'B',
      modes: { text_image: mode(2), edit_image: mode(3) },
    }
    d.bindings = {
      a: { text_image: { groupId: 'a' }, edit_image: { groupId: 'a' } },
      b: { text_image: { groupId: 'b' }, edit_image: { groupId: 'b' } },
    }
    const next = createSharedGroup(d, catalog, ['a', 'b'], 'both')
    expect(effectiveInput(next, 'a', 'text_image').n).toBe(1)
    expect(effectiveInput(next, 'b', 'text_image').n).toBe(2)
    expect(next.groups.both.modes.edit_image.enabled).toBe(true)
    next.groups.both.modes.edit_image.input.n = 8
    expect(effectiveInput(next, 'a', 'edit_image').n).toBe(8)
    expect(effectiveInput(next, 'b', 'edit_image').n).toBe(8)
    expect(d.groups.a.modes.edit_image.input.n).toBe(3)
  })
  it('schema import retains explicit zero and false and nested definitions', () => {
    const candidate = importCandidate(
      {
        properties: {
          n: { type: 'integer', default: 1 },
          async: { type: 'boolean', default: true },
          refs: { type: 'array', maxItems: 3, items: { type: 'string' } },
        },
      },
      'a',
      'text_image'
    )
    const current = mode(0)
    const next = applyCandidate(current, candidate, false)
    expect(next.input.n).toBe(0)
    expect(next.input.async).toBe(false)
    expect(next.parameters?.refs.definition?.maxItems).toBe(3)
  })
  it('rejects external references and malformed imported constraints', () => {
    expect(() =>
      importCandidate(
        { properties: { x: { $ref: 'https://example.com' } } },
        'a',
        'text_image'
      )
    ).toThrow()
    expect(() =>
      importCandidate(
        {
          format: 'channel-mode-parameters/v1',
          parameters: {},
          constraints: { n: { enum: true } },
        },
        'a',
        'text_image'
      )
    ).toThrow()
  })
  it('imports effective member values without losing false, zero, arrays or rules', () => {
    const d = empty()
    d.groups.g = { name: 'G', modes: { text_image: mode(3) } }
    d.groups.g.modes.text_image.input.refs = ['shared']
    d.groups.g.modes.text_image.mapping = { imageSize: 'image_size' }
    d.bindings.a = {
      text_image: {
        groupId: 'g',
        input: { n: 0, async: false, refs: ['member'] },
        parameters: { n: { type: 'integer', maximum: 2 } },
        mapping: { ratio: 'aspect_ratio' },
      },
    }
    const candidate = importCandidate(d, 'a', 'text_image')
    expect(candidate.input).toEqual({ n: 0, async: false, refs: ['member'] })
    expect(candidate.parameters.n.maximum).toBe(2)
    expect(candidate.mapping).toEqual({
      imageSize: 'image_size',
      ratio: 'aspect_ratio',
    })
  })
})

describe('document restoration and selection isolation', () => {
  it('restores rules without clearing selling billing, native cost, or member differences', () => {
    const d = empty()
    const current = mode(0)
    current.billing = { currency: 'USD', expression: '0.23', confirmed: true }
    current.cost = {
      amount: 2,
      currency: 'CNY',
      unit: 'image',
      confirmed: true,
    }
    d.groups.g = {
      name: 'G',
      modes: { text_image: current, edit_image: mode(3) },
    }
    d.bindings.a = {
      text_image: {
        groupId: 'g',
        input: { n: 2 },
        billing: { currency: 'USD', expression: '0.31', confirmed: true },
        cost: { amount: 4, currency: 'CNY', unit: 'image', confirmed: true },
      },
    }
    const before = structuredClone(d)
    d.groups.g.modes.text_image = restoreDocumentRules(
      current,
      catalog.models.a,
      'text_image'
    )
    expect(d.groups.g.modes.text_image.billing).toEqual(
      before.groups.g.modes.text_image.billing
    )
    expect(d.groups.g.modes.text_image.cost).toEqual(
      before.groups.g.modes.text_image.cost
    )
    expect(d.groups.g.modes.text_image.input).toEqual({ n: 0, async: false })
    expect(d.groups.g.modes.text_image.billing).not.toBe(current.billing)
    expect(d.bindings).toEqual(before.bindings)
    expect(d.groups.g.modes.edit_image).toEqual(
      before.groups.g.modes.edit_image
    )
    expect(effectiveInput(d, 'a', 'text_image').n).toBe(2)
    expect(current.billing?.expression).toBe('0.23')
  })
  it('does not reuse a broad saved group when only some models are selected', () => {
    const d = empty()
    d.groups.g = {
      name: 'G',
      modes: { text_image: mode(1), text_video: mode(1) },
    }
    d.bindings = {
      a: { text_image: { groupId: 'g' } },
      b: { text_video: { groupId: 'g' } },
    }
    expect(selectionMatchesGroup(d, catalog, ['a'], 'g')).toBe(false)
    const next = createSharedGroup(d, catalog, ['a'], 'selected')
    expect(Object.keys(next.groups.selected.modes)).toEqual(['text_image'])
    expect(next.bindings.b).toEqual(d.bindings.b)
    expect(next.groups.g).toEqual(d.groups.g)
    next.groups.selected.modes.text_image.input.n = 5
    expect(effectiveInput(next, 'a', 'text_image').n).toBe(5)
    expect(effectiveInput(next, 'b', 'text_video').n).toBe(1)
  })
})

it('keeps preset-audio objects in the JSON editor instead of converting them to URL strings', () => {
  expect(
    acceptsStringArrayItems({
      type: 'array',
      definition: {
        items: { type: 'object', properties: { voice_id: { type: 'string' } } },
      },
    })
  ).toBe(false)
  expect(
    acceptsStringArrayItems({
      type: 'array',
      definition: {
        items: { anyOf: [{ type: 'string' }, { type: 'object' }] },
      },
    })
  ).toBe(true)
  expect(
    acceptsStringArrayItems({
      type: 'array',
      definition: { items: { type: 'string' } },
    })
  ).toBe(true)
})

it('keeps manually configured protocol and parameters when discovery disappears or returns', () => {
  const document = empty()
  document.groups.g = {
    name: 'manual',
    modes: {
      text_video: {
        enabled: true,
        input: { seconds: 9 },
        cost: { amount: null, confirmed: false },
        protocol: { templateModel: 'contract-template', confirmed: true },
      },
    },
  }
  document.bindings['future-video'] = { text_video: { groupId: 'g' } }
  const catalog: Catalog = {
    key: 'paisio_media',
    name: 'test',
    baseURL: 'https://provider.invalid',
    docsURL: 'https://docs.invalid',
    models: {},
    documents: [],
    warnings: [],
  }
  const before = structuredClone(document)
  const absent = createSharedGroup(
    document,
    catalog,
    ['future-video'],
    'absent'
  )
  expect(absent.groups.absent.modes.text_video.protocol).toEqual(
    document.groups.g.modes.text_video.protocol
  )
  expect(absent.groups.absent.modes.text_video.input).toEqual({ seconds: 9 })
  const returned = createSharedGroup(
    absent,
    catalog,
    ['future-video'],
    'returned'
  )
  expect(returned.groups.returned.modes.text_video.protocol).toEqual(
    document.groups.g.modes.text_video.protocol
  )
  expect(returned.groups.returned.modes.text_video.input).toEqual({
    seconds: 9,
  })
  expect(document).toEqual(before)
})

it('keeps missing IDs selectable and merges their later return without losing hand edits', () => {
  expect(configurationModelChoices([], ['old'], ['manual'], ['new'])).toEqual([
    'old',
    'manual',
    'new',
  ])
  expect(
    configurationModelChoices(
      ['manual', 'old', 'later'],
      ['old'],
      ['manual'],
      ['new']
    )
  ).toEqual(['manual', 'old', 'later', 'new'])
})
