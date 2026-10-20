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
import { describe, it, expect } from 'vitest'

import {
  createSharedGroup,
  parseSafe,
  readConfiguration,
} from './configuration'
import type { Catalog, Configuration } from './types'
import {
  applyModeChoice,
  applyIndependentCapability,
  relevantParameter,
  applyIndividualFields,
  effectiveMode,
  configurationImpact,
  missingExisting,
  capabilityEnabled,
  VIDEO_CAPABILITY_VIEWS,
} from './workflow'

const ref = { url: 'https://docs.example/real-contract' }
const parameters = {
  prompt: { type: 'string', required: true },
  images: { type: 'array' },
  videos: { type: 'array' },
  audios: { type: 'array' },
  resolution: { type: 'string', enum: ['720p', '1080p'], default: '720p' },
}
const model = {
  id: 'A',
  kind: 'video',
  status: 'reviewed',
  parameters,
  modes: {
    text_video: { required: [] },
    image_video: { required: [] },
    video_ref: { required: [] },
    audio_ref: { required: [] },
    mixed_ref: { required: [] },
  },
  source: ref,
}
const catalog = {
  models: { A: model, B: { ...model, id: 'B' }, C: { ...model, id: 'C' } },
  key: 'yuxibox_media',
  name: 'fixture',
  baseURL: 'https://fixture.invalid',
  docsURL: ref.url,
  documents: [],
  warnings: [],
} as Catalog
const empty = (): Configuration => ({
  format: 'channel-model-configuration/v1',
  revision: 1,
  provider: 'yuxibox_media',
  groups: {},
  bindings: {},
})
describe('channel workflow scope and capabilities', () => {
  it('keeps pending capability choices for documented and unknown models without inventing their contract', () => {
    const pendingCatalog = {
      ...catalog,
      models: {
        ...catalog.models,
        B: { ...catalog.models.B, modes: { text_video: { required: [] } } },
      },
    }
    let doc = createSharedGroup(
      empty(),
      pendingCatalog,
      ['A', 'B', 'unknown'],
      'g'
    )
    doc = applyIndependentCapability(
      doc,
      pendingCatalog,
      ['A', 'B', 'unknown'],
      'g',
      'video_ref',
      true
    )
    for (const name of ['A', 'B', 'unknown']) {
      expect(effectiveMode(doc, name, 'video_ref')?.enabled).toBe(true)
    }
    expect(doc.bindings.B.video_ref.parameters).toEqual({})
    expect(effectiveMode(doc, 'B', 'video_ref')?.protocol).toBeUndefined()
    expect(effectiveMode(doc, 'B', 'video_ref')?.cost.amount).toBeNull()
    expect(effectiveMode(doc, 'A', 'video_ref')?.parameters).toHaveProperty(
      'videos'
    )
    doc = applyIndependentCapability(
      doc,
      pendingCatalog,
      ['unknown'],
      'g',
      'first_frame',
      true
    )
    expect(effectiveMode(doc, 'unknown', 'frames')?.enabled).toBe(true)
    expect(
      effectiveMode(doc, 'unknown', 'frames')?.mapping?.end_image_url
    ).toBe('@reject')
  })
  it('uses the actual response difference, retaining all missing entries until explicit removal', () => {
    expect(missingExisting(['A'], ['A', 'B', 'C'], true)).toEqual(['B', 'C'])
    expect(missingExisting([], ['A', 'B'], false)).toEqual([])
    expect(missingExisting([], ['A', 'B'], true)).toEqual(['A', 'B'])
  })
  it('splits selected members without changing unselected configuration and independent prices', () => {
    const baseline = createSharedGroup(
      empty(),
      catalog,
      ['A', 'B', 'C'],
      'original'
    )
    baseline.bindings.A.text_video.cost = {
      amount: 1,
      confirmed: false,
      currency: 'USD',
      unit: 'request',
    }
    baseline.bindings.B.text_video.cost = {
      amount: 2,
      confirmed: false,
      currency: 'USD',
      unit: 'request',
    }
    const next = createSharedGroup(
      baseline,
      catalog,
      ['A', 'B'],
      'selected-only'
    )
    expect(next.bindings.C).toEqual(baseline.bindings.C)
    expect(effectiveMode(next, 'C', 'text_video')).toEqual(
      effectiveMode(baseline, 'C', 'text_video')
    )
    expect(effectiveMode(next, 'A', 'text_video')?.cost.amount).toBe(1)
    expect(effectiveMode(next, 'B', 'text_video')?.cost.amount).toBe(2)
    next.bindings.A.text_video.cost = {
      amount: 4,
      confirmed: false,
      currency: 'USD',
      unit: 'request',
    }
    expect(configurationImpact(baseline, next)).not.toContain('C')
    expect(effectiveMode(next, 'B', 'text_video')?.cost.amount).toBe(2)
  })
  it('a combined capability does not enable other video modes or invent required materials', () => {
    const doc = createSharedGroup(empty(), catalog, ['A', 'B'], 'group')
    for (const mode of Object.values(doc.groups.group.modes)) {
      mode.enabled = false
    }
    const next = applyModeChoice(
      doc,
      catalog,
      ['A', 'B'],
      'group',
      'mixed_ref',
      true
    )
    for (const key of [
      'text_video',
      'image_video',
      'video_ref',
      'audio_ref',
      'mixed_ref',
    ]) {
      const mode = effectiveMode(next, 'A', key)
      expect(mode?.enabled).toBe(key === 'mixed_ref')
      for (const field of ['images', 'videos', 'audios']) {
        expect(mode?.parameters?.[field]?.required).not.toBe(true)
      }
    }
    expect(next.bindings.A.text_image).toBeUndefined()
  })
  it('JSON round trips preserve false, zero, empty arrays, defaults, allowed sets, per-model prices and unmapped policies', () => {
    const doc = createSharedGroup(empty(), catalog, ['A', 'B'], 'group')
    doc.bindings.A.text_video.input = {
      seed: 0,
      generate_audio: false,
      images: [],
    }
    doc.bindings.A.text_video.mapping = { unknown: '@reject' }
    doc.bindings.A.text_video.parameters = {
      resolution: {
        type: 'string',
        enum: ['720p'],
        default: '720p',
        definition: { enum: ['720p', '1080p'] },
      },
    }
    const restored = readConfiguration(
      parseSafe(JSON.stringify(doc)),
      doc.provider
    )
    expect(restored).toEqual(doc)
  })
})

describe('independent review regressions', () => {
  it('can turn off pure-text video while combined references remain enabled', () => {
    const doc = createSharedGroup(empty(), catalog, ['A', 'B'], 'group')
    const rich = applyModeChoice(
      doc,
      catalog,
      ['A', 'B'],
      'group',
      'mixed_ref',
      true
    )
    const result = applyModeChoice(
      rich,
      catalog,
      ['A', 'B'],
      'group',
      'text_video',
      false
    )
    expect(effectiveMode(result, 'A', 'text_video')?.enabled).toBe(false)
    expect(effectiveMode(result, 'A', 'mixed_ref')?.enabled).toBe(true)
  })
  it('editing one optional field does not freeze unedited shared ratio or mapping; clearing restores inheritance', () => {
    const doc = createSharedGroup(empty(), catalog, ['A', 'B'], 'group')
    const rules = doc.groups.group.modes.text_video.parameters
    if (!rules) throw new Error('fixture missing rules')
    rules.prompt.required = false
    doc.groups.group.modes.text_video.input = {
      prompt: 'shared',
      aspect_ratio: '16:9',
    }
    const individual = effectiveMode(doc, 'A', 'text_video')
    if (!individual) throw new Error('fixture missing')
    individual.input.prompt = 'A only'
    const next = applyIndividualFields(doc, 'A', 'text_video', individual)
    expect(next.bindings.A.text_video.input).toEqual({ prompt: 'A only' })
    expect(next.bindings.A.text_video.parameters).toEqual({})
    next.groups.group.modes.text_video.input.aspect_ratio = '9:16'
    expect(effectiveMode(next, 'A', 'text_video')?.input.aspect_ratio).toBe(
      '9:16'
    )
    expect(effectiveMode(next, 'B', 'text_video')?.input.prompt).toBe('shared')
    const clear = effectiveMode(next, 'A', 'text_video')
    if (!clear) throw new Error('fixture missing')
    delete clear.input.prompt
    const restored = applyIndividualFields(next, 'A', 'text_video', clear)
    expect(restored.bindings.A.text_video.input).toEqual({})
    expect(effectiveMode(restored, 'A', 'text_video')?.input.prompt).toBe(
      'shared'
    )
  })
})

describe('independent material configuration', () => {
  it.each(VIDEO_CAPABILITY_VIEWS)(
    'selects and cancels only the %s video capability',
    (key) => {
      const frameCatalog = structuredClone(catalog)
      frameCatalog.models.A.modes.frames = { required: [] }
      frameCatalog.models.A.capabilities = {
        firstFrame: true,
        lastFrame: true,
        multipleReferences: true,
      }
      const original = createSharedGroup(
        empty(),
        frameCatalog,
        ['A', 'B'],
        'original'
      )
      let doc = createSharedGroup(original, frameCatalog, ['A'], 'g')
      for (const mode of Object.values(doc.groups.g.modes)) {
        mode.enabled = false
      }
      for (const binding of Object.values(doc.bindings.A)) {
        binding.enabled = false
      }
      doc = applyIndependentCapability(doc, frameCatalog, ['A'], 'g', key, true)
      for (const candidate of VIDEO_CAPABILITY_VIEWS) {
        expect(capabilityEnabled(doc, ['A'], 'g', candidate)).toBe(
          candidate === key
        )
      }
      doc = applyIndependentCapability(
        doc,
        frameCatalog,
        ['A'],
        'g',
        key,
        false
      )
      for (const candidate of VIDEO_CAPABILITY_VIEWS) {
        expect(capabilityEnabled(doc, ['A'], 'g', candidate)).toBe(false)
      }
      expect(doc.bindings.B).toEqual(original.bindings.B)
    }
  )
  it('switches between frame input styles without forcing reference images or text video', () => {
    let doc = createSharedGroup(empty(), catalog, ['A'], 'g')
    doc = applyIndependentCapability(
      doc,
      catalog,
      ['A'],
      'g',
      'text_video',
      false
    )
    doc = applyIndependentCapability(doc, catalog, ['A'], 'g', 'frames', true)
    expect(capabilityEnabled(doc, ['A'], 'g', 'frames')).toBe(true)
    expect(capabilityEnabled(doc, ['A'], 'g', 'first_frame')).toBe(false)
    doc = applyIndependentCapability(
      doc,
      catalog,
      ['A'],
      'g',
      'first_frame',
      true
    )
    expect(capabilityEnabled(doc, ['A'], 'g', 'first_frame')).toBe(true)
    expect(capabilityEnabled(doc, ['A'], 'g', 'frames')).toBe(false)
    expect(capabilityEnabled(doc, ['A'], 'g', 'image_video')).toBe(false)
    expect(capabilityEnabled(doc, ['A'], 'g', 'text_video')).toBe(false)
    doc = applyIndependentCapability(
      doc,
      catalog,
      ['A'],
      'g',
      'first_frame',
      false
    )
    expect(effectiveMode(doc, 'A', 'frames')?.enabled).toBe(false)
  })
  it.each(['image first', 'text disabled first'])(
    'keeps reference images independent from text-to-video with %s',
    (order) => {
      const original = createSharedGroup(
        empty(),
        catalog,
        ['A', 'B'],
        'original'
      )
      let doc = createSharedGroup(original, catalog, ['A'], 'g')
      const choices: [string, boolean][] =
        order === 'image first'
          ? [
              ['image_video', true],
              ['text_video', false],
            ]
          : [
              ['text_video', false],
              ['image_video', true],
            ]
      for (const [key, enabled] of choices) {
        doc = applyIndependentCapability(doc, catalog, ['A'], 'g', key, enabled)
      }
      expect(effectiveMode(doc, 'A', 'image_video')?.enabled).toBe(true)
      expect(effectiveMode(doc, 'A', 'text_video')?.enabled).toBe(false)
      expect(effectiveMode(doc, 'A', 'image_video')?.parameters).toHaveProperty(
        'images'
      )
      expect(effectiveMode(doc, 'B', 'text_video')).toEqual(
        effectiveMode(original, 'B', 'text_video')
      )
      expect(doc.bindings.B).toEqual(original.bindings.B)
      const reopened = createSharedGroup(
        readConfiguration(parseSafe(JSON.stringify(doc)), doc.provider),
        catalog,
        ['A'],
        'reopened'
      )
      expect(effectiveMode(reopened, 'A', 'image_video')?.enabled).toBe(true)
      expect(effectiveMode(reopened, 'A', 'text_video')?.enabled).toBe(false)
    }
  )
  it('permits video without audio and derives combined mode only after audio is enabled', () => {
    let doc = createSharedGroup(empty(), catalog, ['A', 'B'], 'g')
    doc = applyIndependentCapability(
      doc,
      catalog,
      ['A', 'B'],
      'g',
      'video_ref',
      true
    )
    expect(effectiveMode(doc, 'A', 'video_ref')?.capabilities).toMatchObject({
      videos: true,
      audios: false,
    })
    expect(effectiveMode(doc, 'A', 'mixed_ref')?.enabled).toBe(false)
    doc = applyIndependentCapability(
      doc,
      catalog,
      ['A', 'B'],
      'g',
      'audio_ref',
      true
    )
    expect(effectiveMode(doc, 'A', 'mixed_ref')?.enabled).toBe(true)
    doc = applyIndependentCapability(
      doc,
      catalog,
      ['A', 'B'],
      'g',
      'audio_ref',
      false
    )
    expect(effectiveMode(doc, 'A', 'mixed_ref')?.enabled).toBe(false)
    expect(effectiveMode(doc, 'A', 'text_video')?.enabled).toBe(true)
    expect(effectiveMode(doc, 'A', 'video_ref')?.capabilities?.audios).toBe(
      false
    )
    const regroup = createSharedGroup(doc, catalog, ['A'], 'split')
    expect(effectiveMode(regroup, 'A', 'video_ref')?.capabilities).toEqual(
      effectiveMode(doc, 'A', 'video_ref')?.capabilities
    )
  })
  it('switches visible fields while retaining common parameters', () => {
    expect(relevantParameter('videos', 'video_ref')).toBe(true)
    expect(relevantParameter('videos', 'text_video')).toBe(false)
    expect(relevantParameter('audios', 'video_ref')).toBe(false)
    expect(relevantParameter('images', 'image_video')).toBe(true)
    expect(relevantParameter('end_image_url', 'first_frame')).toBe(false)
    expect(relevantParameter('end_image_url', 'frames')).toBe(true)
    for (const key of ['prompt', 'resolution', 'seconds']) {
      expect(relevantParameter(key, 'audio_ref')).toBe(true)
    }
  })
})
