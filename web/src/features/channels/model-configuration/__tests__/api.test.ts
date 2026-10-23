import { beforeEach, expect, it, vi } from 'vitest'

import { saveModelConfiguration } from '../api'
import type { Configuration } from '../types'

const mocks = vi.hoisted(() => ({ put: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { put: mocks.put } }))

beforeEach(() => mocks.put.mockReset())

it('removing models prunes unused groups before sending while preserving the draft and remaining references', async () => {
  const configuration: Configuration = {
    format: 'channel-model-configuration/v1',
    revision: 23,
    provider: 'paisio_media',
    groups: {
      shared: { name: 'Still shared', modes: {} },
      retired: { name: 'Removed model only', modes: {} },
      unused: { name: 'Already unreferenced', modes: {} },
      disabled: { name: 'Referenced by disabled mode', modes: {} },
    },
    bindings: {
      removed: {
        text_video: { groupId: 'shared' },
        image_video: { groupId: 'retired' },
      },
      keep: { text_video: { groupId: 'shared' } },
      disabled: { text_video: { groupId: 'disabled', enabled: false } },
    },
  }
  const before = structuredClone(configuration)
  mocks.put.mockRejectedValueOnce(new Error('save failed'))

  await expect(
    saveModelConfiguration(13, configuration, [], ['removed'], 'removed,keep')
  ).rejects.toThrow('save failed')

  expect(mocks.put).toHaveBeenCalledWith(
    '/api/channel/13/model-configuration',
    {
      configuration: {
        ...configuration,
        groups: {
          shared: configuration.groups.shared,
          disabled: configuration.groups.disabled,
        },
        bindings: {
          keep: configuration.bindings.keep,
          disabled: configuration.bindings.disabled,
        },
      },
      expectedRevision: 23,
      addModels: [],
      removeModels: ['removed'],
      expectedModels: 'removed,keep',
    }
  )
  expect(configuration).toEqual(before)
})

it('ordinary saves retain unreferenced groups without an explicit model removal', async () => {
  const configuration: Configuration = {
    format: 'channel-model-configuration/v1',
    revision: 23,
    provider: 'paisio_media',
    groups: { draft: { name: 'Unfinished configuration', modes: {} } },
    bindings: {},
  }
  mocks.put.mockResolvedValueOnce({
    data: { success: true, data: configuration },
  })

  await expect(saveModelConfiguration(13, configuration, [])).resolves.toEqual(
    configuration
  )
  expect(mocks.put.mock.calls[0][1].configuration).toEqual(configuration)
})

it('removing an unused parameter group reduces the serialized save request below the existing 1 MiB limit', async () => {
  const configuration: Configuration = {
    format: 'channel-model-configuration/v1',
    revision: 23,
    provider: 'paisio_media',
    groups: {
      retired: { name: 'Old document schema', modes: {} },
      keep: { name: 'Retained document schema', modes: {} },
    },
    bindings: {
      removed: { text_video: { groupId: 'retired' } },
      keep: { text_video: { groupId: 'keep' } },
    },
    sources: [{ url: 'https://example.com/parameters' }],
  }
  for (const group of Object.values(configuration.groups)) {
    group.modes.text_video = {
      enabled: true,
      input: {},
      cost: { amount: null, confirmed: false },
      parameters: { prompt: { description: 'x'.repeat(600_000) } },
    }
  }
  const before = JSON.stringify(configuration)
  expect(new TextEncoder().encode(before).length).toBeGreaterThan(1 << 20)
  mocks.put.mockResolvedValueOnce({
    data: { success: true, data: configuration },
  })

  await saveModelConfiguration(
    13,
    configuration,
    [],
    ['removed'],
    'removed,keep'
  )

  const body = mocks.put.mock.calls[0][1]
  expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThan(
    1 << 20
  )
  expect(body.configuration.groups.keep).toEqual(configuration.groups.keep)
  expect(JSON.stringify(configuration)).toBe(before)
})
