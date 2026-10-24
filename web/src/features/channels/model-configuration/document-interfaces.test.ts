import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createSharedGroup } from './configuration'
import {
  applyDocumentInterface,
  projectDocumentInterfaces,
} from './document-interfaces'
import type { Catalog, Configuration } from './types'
import { effectiveMode } from './workflow'

const root = path.resolve('..')
const catalogs = JSON.parse(
  readFileSync(path.join(root, 'pkg/modelconfig/catalog.json'), 'utf8')
).providers as Record<string, Catalog>
const empty = (provider: string): Configuration => ({
  format: 'channel-model-configuration/v1',
  revision: 0,
  provider,
  groups: {},
  bindings: {},
})

describe('document interfaces and actual model IDs', () => {
  it('matches backend save fixtures to actual UI-generated model and prompt rules', () => {
    const fixtures: Record<string, Configuration> = {}
    for (const [provider, model] of [
      ['aotian_video', '特价seedance-2.5-720p'],
      ['fenglang_video', 'seedance-2.5'],
    ]) {
      const catalog = JSON.parse(
        readFileSync(
          path.join(root, 'pkg/modelconfig', `${provider}.catalog.json`),
          'utf8'
        )
      ) as Catalog
      const projected = projectDocumentInterfaces(
        catalog,
        [model],
        'video'
      ) as Catalog
      const document = createSharedGroup(
        empty(provider),
        projected,
        [model],
        'actual-ui'
      )
      const group = document.groups['actual-ui']
      const mode = group.modes.audio_ref
      const binding = document.bindings[model].audio_ref
      mode.enabled = true
      binding.enabled = true
      if (!binding.protocol) {
        throw new Error('Missing projected interface binding')
      }
      binding.protocol = { ...binding.protocol, confirmed: true }
      group.modes = { audio_ref: mode }
      document.bindings[model] = { audio_ref: binding }
      expect(mode.parameters?.model).toMatchObject({
        required: false,
        definition: { serverGenerated: true },
      })
      expect(mode.parameters?.prompt?.required).toBe(true)
      fixtures[provider] = document
    }
    const fixturePath = path.join(
      root,
      'controller/testdata/reviewed_video_ui_documents.json'
    )
    if (process.env.UPDATE_REVIEWED_VIDEO_UI_FIXTURES === '1') {
      writeFileSync(fixturePath, `${JSON.stringify(fixtures, null, 2)}\n`)
    }
    expect(fixtures).toEqual(JSON.parse(readFileSync(fixturePath, 'utf8')))
  })
  it('projects Fenglang exact rules without inventing account models, prices or defaults', () => {
    const provider = JSON.parse(
      readFileSync(
        path.join(root, 'pkg/modelconfig/fenglang_video.catalog.json'),
        'utf8'
      )
    ) as Catalog
    expect(provider.models).toEqual({})
    const projected = projectDocumentInterfaces(
      provider,
      ['seedance-2.5', 'minimax-video-h3', 'actual-new-model'],
      'video'
    ) as Catalog
    expect(Object.keys(projected.models)).toEqual([
      'seedance-2.5',
      'minimax-video-h3',
      'actual-new-model',
    ])
    expect(projected.models['seedance-2.5'].parameters.seconds).toMatchObject({
      minimum: 4,
      maximum: 30,
    })
    expect(
      projected.models['seedance-2.5'].parameters.images.definition
    ).toHaveProperty('maxItems', 30)
    expect(
      projected.models['seedance-2.5'].parameters.start_image_url.definition
    ).toMatchObject({
      'x-channel-parameter': { vendorFields: ['input_reference'] },
    })
    expect(projected.models['minimax-video-h3'].parameters).not.toHaveProperty(
      'generate_audio'
    )
    expect(
      projected.models['actual-new-model'].parameters.seconds
    ).toMatchObject({ minimum: 1, maximum: 3600 })
    expect(
      projected.models['actual-new-model'].parameters.resolution.enum
    ).toBeUndefined()
    const document = createSharedGroup(
      empty(provider.key),
      projected,
      ['seedance-2.5'],
      'selected'
    )
    const mode = effectiveMode(document, 'seedance-2.5', 'text_video')
    expect(mode?.input).toEqual({})
    expect(mode?.protocol?.confirmed).toBe(false)
    expect(mode?.parameters?.generate_audio).toBeDefined()
    expect(mode?.parameters).not.toHaveProperty('start_image_url')
    expect(Object.keys(document.bindings)).toEqual(['seedance-2.5'])
  })
  it('projects the AoTian interface onto selected IDs without duration or model defaults', () => {
    const provider = JSON.parse(
      readFileSync(
        path.join(root, 'pkg/modelconfig/aotian_video.catalog.json'),
        'utf8'
      )
    ) as Catalog
    expect(provider.models).toEqual({})
    const projected = projectDocumentInterfaces(
      provider,
      ['account-video-id'],
      'video'
    ) as Catalog
    const document = createSharedGroup(
      empty(provider.key),
      projected,
      ['account-video-id'],
      'selected'
    )
    const mode = effectiveMode(document, 'account-video-id', 'text_video')
    expect(mode?.input).toEqual({})
    expect(mode?.parameters?.prompt?.required).toBe(true)
    expect(
      mode?.parameters?.aspect_ratio?.definition?.['x-channel-parameter']
    ).toMatchObject({ vendorFields: ['size'] })
    expect(mode?.parameters?.resolution?.enum).toBeUndefined()
    expect(mode?.protocol?.confirmed).toBe(false)
    expect(mode?.parameters).not.toHaveProperty('start_image_url')
  })
  it('recognizes all ten exact YuxiBox video IDs and preserves saved interface choices', () => {
    const source = catalogs.yuxibox_media
    const entries = Object.values(source.interfaces ?? {}).filter(
      (entry) => entry.kind === 'video'
    )
    const names = entries.flatMap((entry) =>
      Object.keys(entry.modelRules ?? {})
    )
    expect(names).toHaveLength(10)
    const projected = projectDocumentInterfaces(
      source,
      names,
      'video'
    ) as Catalog
    for (const entry of entries) {
      for (const name of Object.keys(entry.modelRules ?? {})) {
        expect(projected.models[name].interfaceId).toBe(entry.id)
        expect(
          projected.models[name].parameters.images.definition
        ).toHaveProperty('maxItems')
        if (
          name.startsWith('seedance-2.5') ||
          name === 'seedance2.5-yx-count'
        ) {
          expect(projected.models[name].parameters).toHaveProperty('videos')
          expect(projected.models[name].parameters).toHaveProperty('audios')
        }
      }
    }
    const name = 'seedance-2.5（YX）'
    const document = empty('yuxibox_media')
    document.bindings[name] = {
      text_video: {
        groupId: 'saved',
        protocol: { templateModel: entries[0].id, confirmed: true },
      },
    }
    const preserved = projectDocumentInterfaces(
      source,
      [name],
      'video',
      document
    ) as Catalog
    expect(preserved.models[name].interfaceId).toBe(entries[0].id)
  })
  it('initializes every provider/category from request fields without a matching example model', () => {
    for (const provider of Object.values(catalogs)) {
      for (const kind of ['image', 'video'] as const) {
        if (
          !Object.values(provider.interfaces ?? {}).some(
            (entry) => entry.kind === kind
          )
        ) {
          continue
        }
        const catalog = projectDocumentInterfaces(
          provider,
          ['fetched-A', 'fetched-B'],
          kind
        ) as Catalog
        expect(Object.keys(catalog.models)).toEqual(['fetched-A', 'fetched-B'])
        const document = createSharedGroup(
          empty(provider.key),
          catalog,
          ['fetched-A', 'fetched-B'],
          'g'
        )
        const base = kind === 'image' ? 'text_image' : 'text_video'
        const mode = effectiveMode(document, 'fetched-A', base)
        if (provider.key === 'lxmone_media') {
          expect(
            mode?.parameters?.prompt?.definition?.['x-channel-parameter']
          ).toHaveProperty('requiredStatus', 'manual-verification-required')
        } else {
          expect(mode?.parameters?.prompt?.required, provider.key).toBe(true)
        }
        expect(mode?.protocol?.templateModel).toMatch(/^interface:/)
        expect(mode?.input).toEqual({})
        if (kind === 'video') {
          expect(mode?.parameters).not.toHaveProperty('quality')
        }
      }
    }
  })
  it('does not let an old example-name profile select the compatibility endpoint or duration limits', () => {
    const catalog = projectDocumentInterfaces(
      catalogs.paisio_media,
      ['video-pro-720p'],
      'video'
    ) as Catalog
    expect(catalog.models['video-pro-720p'].path).toBe('/v1/videos')
    expect(catalog.models['video-pro-720p'].parameters.seconds.minimum).toBe(1)
    expect(catalog.models['video-pro-720p'].parameters).not.toHaveProperty(
      'duration'
    )
    expect(catalog.models['video-pro-720p'].parameters).not.toHaveProperty(
      'seed'
    )
  })
  it('applies explicitly documented per-model constraints only to the matching actual ID', () => {
    const catalog = projectDocumentInterfaces(
      catalogs.xcmapi_media,
      ['dola-seedance-2.0-900', 'fetched-unknown'],
      'video'
    ) as Catalog
    expect(
      catalog.models['dola-seedance-2.0-900'].parameters.resolution.enum
    ).toEqual(['720p'])
    expect(
      catalog.models['dola-seedance-2.0-900'].parameters
    ).not.toHaveProperty('videos')
    expect(
      catalog.models['fetched-unknown'].parameters.resolution.enum
    ).toBeUndefined()
  })
  it('switches endpoint rules without retaining foreign optional fields or changing prices', () => {
    const provider = catalogs.paisio_media
    const catalog = projectDocumentInterfaces(
      provider,
      ['fetched-A', 'fetched-B'],
      'video'
    ) as Catalog
    const document = createSharedGroup(
      empty(provider.key),
      catalog,
      ['fetched-A', 'fetched-B'],
      'g'
    )
    document.groups.g.modes.text_video.input = {
      aspect_ratio: '16:9',
      seed: 123,
    }
    document.bindings['fetched-A'].text_video.pricing = {
      method: 'direct_price',
      value: 4,
    }
    const selected = Object.values(provider.interfaces ?? {}).find(
      (entry) => entry.path === '/v1/contents/generations/tasks'
    )
    if (!selected) {
      throw new Error('Missing documented compatibility interface')
    }
    const next = applyDocumentInterface(
      document,
      catalog,
      ['fetched-A', 'fetched-B'],
      'g',
      selected.id
    )
    expect(effectiveMode(next, 'fetched-A', 'text_video')?.input).toEqual({
      aspect_ratio: '16:9',
    })
    expect(
      effectiveMode(next, 'fetched-A', 'text_video')?.parameters
    ).not.toHaveProperty('start_image_url')
    expect(next.bindings['fetched-A'].text_video.pricing).toEqual(
      document.bindings['fetched-A'].text_video.pricing
    )
    expect(
      effectiveMode(next, 'fetched-A', 'text_video')?.protocol?.confirmed
    ).toBe(false)
  })
  it('builds initialization only from explicit real selections and matches the formal UI fields', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'interface-initialization-')
    )
    const cleanupDirectory = path.resolve(directory)
    if (
      !cleanupDirectory.startsWith(
        `${path.resolve(tmpdir())}${path.sep}interface-initialization-`
      )
    ) {
      throw new Error('Unexpected temporary directory')
    }
    try {
      const selection = Object.fromEntries(
        Object.entries(catalogs).map(([key, catalog]) => {
          const entry = Object.values(catalog.interfaces ?? {}).find(
            (entry) => entry.kind === 'video'
          )
          if (!entry) {
            throw new Error('Missing documented video interface')
          }
          return [
            key,
            [
              {
                id: 'actual-fetched-only',
                kind: 'video',
                interfaceId: entry.id,
                discoverySource: 'upstream-fetch',
                confirmed: true,
              },
            ],
          ]
        })
      )
      const input = path.join(directory, 'input.json'),
        output = path.join(directory, 'output.json')
      writeFileSync(input, JSON.stringify(selection))
      execFileSync('node', [
        path.join(
          root,
          'plugin-sources/media-providers/six-v2/build-initial-configurations.mjs'
        ),
        '--models-file',
        input,
        '--output',
        output,
      ])
      const drafts = JSON.parse(readFileSync(output, 'utf8'))
        .configurations as Record<string, Configuration>
      for (const [provider, document] of Object.entries(drafts)) {
        expect(Object.keys(document.bindings)).toEqual(['actual-fetched-only'])
        const projected = projectDocumentInterfaces(
          catalogs[provider],
          ['actual-fetched-only'],
          'video'
        ) as Catalog
        const ui = createSharedGroup(
          empty(provider),
          projected,
          ['actual-fetched-only'],
          'g'
        )
        expect(
          Object.keys(
            effectiveMode(document, 'actual-fetched-only', 'text_video')
              ?.parameters ?? {}
          ).sort()
        ).toEqual(
          Object.keys(
            effectiveMode(ui, 'actual-fetched-only', 'text_video')
              ?.parameters ?? {}
          ).sort()
        )
      }
    } finally {
      rmSync(cleanupDirectory, { recursive: true, force: true })
    }
  })
})
