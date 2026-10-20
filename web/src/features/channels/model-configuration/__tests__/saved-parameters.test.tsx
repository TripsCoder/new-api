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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { channelSchema } from '../../types'
import { ModelConfigurationDialog } from '../model-configuration-dialog'
import { SavedModelParametersDialog } from '../saved-model-parameters-dialog'
import type { ConfigurationResponse } from '../types'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  check: vi.fn(),
  call: vi.fn(),
}))
vi.mock('../api', () => ({
  getModelConfiguration: mocks.get,
  saveModelConfiguration: mocks.save,
  checkModelConfiguration: mocks.check,
  tryModelConfiguration: mocks.call,
  getConfigurationAvailability: vi.fn(),
  getRealConfigurationTask: vi.fn(),
  getRealConfigurationArtifacts: vi.fn(),
  restoreModelConfiguration: vi.fn(),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key.replaceAll(/{{(\w+)}}/g, (_, name: string) =>
        String(values?.[name] ?? name)
      ),
    i18n: { language: 'en' },
  }),
}))
vi.mock('../../hooks/use-channel-model-discovery', () => ({
  useChannelModelDiscovery: () => ({
    status: 'success',
    models: ['A', 'B', 'new-model'],
    fetch: vi.fn(),
  }),
}))

const channel = channelSchema.parse({
  id: 12,
  type: 61,
  name: 'fixture',
  key: '',
  models: 'A,B',
  status: 1,
  group: 'default',
  setting: '{"task_plugin_key":"lxmone_media"}',
  created_time: 0,
  test_time: 0,
  response_time: 0,
  balance_updated_time: 0,
})
let response: ConfigurationResponse
let client: QueryClient
const close = vi.fn()
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.clearAllMocks()
  response = {
    channelModels: 'A,B',
    versions: [],
    catalog: {
      key: 'lxmone_media',
      name: 'fixture',
      baseURL: 'https://fixture.invalid',
      docsURL: 'https://docs.invalid',
      documents: [],
      warnings: [],
      models: {},
    },
    configuration: {
      format: 'channel-model-configuration/v1',
      revision: 8,
      provider: 'lxmone_media',
      groups: {
        g: {
          name: 'shared',
          modes: {
            text_video: {
              enabled: true,
              input: { resolution: '720p', seed: 0, generate_audio: false },
              parameters: {
                resolution: {
                  type: 'string',
                  enum: ['720p', '1080p'],
                  required: false,
                },
                seed: { type: 'integer', default: 9 },
                generate_audio: { type: 'boolean' },
                seconds: {
                  type: 'integer',
                  definition: { documentedDefault: 5 },
                },
              },
              mapping: { resolution: 'output_resolution' },
              cost: { amount: null, confirmed: false },
              capabilities: { images: false, videos: false, audios: false },
            },
            video_ref: {
              enabled: false,
              input: {},
              parameters: {
                videos: { type: 'array', definition: { maxItems: 3 } },
              },
              cost: { amount: null, confirmed: false },
            },
          },
        },
      },
      bindings: {
        A: {
          text_video: { groupId: 'g', input: { resolution: '1080p' } },
          video_ref: { groupId: 'g' },
        },
      },
    },
  }
  mocks.get
    .mockReset()
    .mockImplementation(async () => structuredClone(response))
})
afterEach(() => client.clear())
function mountPreview(model = 'A') {
  return render(
    <QueryClientProvider client={client}>
      <SavedModelParametersDialog
        channelId={12}
        model={model}
        onClose={close}
      />
    </QueryClientProvider>
  )
}

describe('saved model parameter preview', () => {
  it('shows effective saved overrides, explicit zero and false, and no document default', async () => {
    const before = JSON.stringify(response)
    mountPreview()
    const dialog = await screen.findByRole('dialog', {
      name: 'Saved parameter preview',
    })
    const row = await within(dialog).findByRole('row', {
      name: /resolution.*1080p/,
    })
    expect(within(row).getByText('Individual settings')).toBeInTheDocument()
    expect(within(row).getByText('output_resolution')).toBeInTheDocument()
    const seed = within(dialog).getByRole('row', { name: /seed.*integer/ })
    expect(within(seed).getByText('0')).toBeInTheDocument()
    expect(within(seed).queryByText('9')).not.toBeInTheDocument()
    expect(
      within(dialog).getByRole('row', { name: /generate_audio.*boolean/ })
    ).toHaveTextContent('false')
    const duration = within(dialog).getByRole('row', {
      name: /seconds.*integer/,
    })
    expect(duration).toHaveTextContent('Not set')
    expect(duration).toHaveTextContent('Default value: Not set')
    expect(
      within(dialog).getByText('Disabled', { selector: '[data-slot="badge"]' })
    ).toBeInTheDocument()
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(
      within(dialog).queryByRole('button', { name: /Save|Generate/ })
    ).not.toBeInTheDocument()
    expect(JSON.stringify(response)).toBe(before)
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.check).not.toHaveBeenCalled()
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('shows no saved configuration for a routed model with no binding', async () => {
    mountPreview('B')
    expect(
      await screen.findByText('No saved parameters for this model')
    ).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('reports a broken shared binding instead of substituting another model', async () => {
    response.configuration.bindings.A.text_video.groupId = 'missing'
    mountPreview()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Shared configuration is missing'
    )
  })

  it('keeps the preview open on outside click and refreshes from the server', async () => {
    const user = userEvent.setup()
    mountPreview()
    await screen.findByRole('row', { name: /resolution.*1080p/ })
    await user.click(document.body)
    expect(close).not.toHaveBeenCalled()
    response.configuration.bindings.A.text_video.input = { resolution: '720p' }
    const refresh = screen.getByRole('button', { name: 'Refresh' })
    await waitFor(() => expect(refresh).toBeEnabled())
    await user.click(refresh)
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(
        within(screen.getByRole('row', { name: /resolution/ })).getAllByRole(
          'cell'
        )[2]
      ).toHaveTextContent('"720p"')
    )
    expect(mocks.get).toHaveBeenCalledTimes(2)
    await user.click(screen.getByText('Close', { selector: 'button' }))
    expect(close).toHaveBeenCalledOnce()
  })

  it('shows a failed read and lets the user retry without a write request', async () => {
    mocks.get.mockRejectedValueOnce(new Error('read failed'))
    mountPreview()
    expect(await screen.findByText('read failed')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(
      await screen.findByRole('row', { name: /resolution.*1080p/ })
    ).toBeInTheDocument()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('adds the action only to existing rows and preserves the parent selection and saved draft', async () => {
    const user = userEvent.setup()
    const parentSnapshot = structuredClone(response)
    parentSnapshot.configuration.bindings.A.text_video.input = {
      resolution: '720p',
    }
    mocks.get.mockResolvedValueOnce(parentSnapshot)
    render(
      <QueryClientProvider client={client}>
        <ModelConfigurationDialog channel={channel} open onOpenChange={close} />
      </QueryClientProvider>
    )
    await screen.findByRole('tab', { name: /Configured/ })
    expect(
      screen.queryByRole('button', { name: 'View parameters for new-model' })
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /Configured/ }))
    const selection = screen.getByRole('checkbox', { name: 'A' })
    expect(selection).toBeChecked()
    await user.click(
      screen.getByRole('button', { name: 'View parameters for A' })
    )
    const preview = await screen.findByRole('dialog', {
      name: 'Saved parameter preview',
    })
    expect(
      await within(preview).findByRole('row', { name: /resolution.*1080p/ })
    ).toBeInTheDocument()
    await user.click(within(preview).getByText('Close', { selector: 'button' }))
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Saved parameter preview' })
      ).not.toBeInTheDocument()
    )
    expect(selection).toBeChecked()
    expect(close).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.check).not.toHaveBeenCalled()
    expect(mocks.call).not.toHaveBeenCalled()
    expect(parentSnapshot.configuration.bindings.A.text_video.input).toEqual({
      resolution: '720p',
    })
  })
  it('compares all exact-model document fields with saved constraints without applying document defaults', async () => {
    const shared = response.configuration.groups.g.modes.text_video
    shared.protocol = { templateModel: 'video-interface', confirmed: true }
    shared.parameters ??= {}
    shared.parameters.images = { type: 'array', definition: { maxItems: 2 } }
    shared.parameters.resolution = { type: 'string', enum: ['1080p'] }
    response.catalog.interfaces = {
      'video-interface': {
        id: 'video-interface',
        kind: 'video',
        status: 'reviewed',
        source: { url: 'https://docs.invalid/video', readAt: '2026-10-19' },
        parameters: { resolution: { type: 'string', enum: ['480p'] } },
        modes: { text_video: { required: [] } },
        modelRules: {
          A: {
            parameters: {
              resolution: { type: 'string', enum: ['720p', '1080p'] },
              seconds: { type: 'integer', minimum: 5, maximum: 15, default: 5 },
              images: {
                type: 'array',
                maxItems: 9,
                items: { type: 'string', format: 'uri' },
              },
              vendor_extension: {
                type: 'boolean',
                description: 'Exact model option',
              },
            },
            documentedParameters: {
              vendor_only: { type: 'string', maxLength: 100 },
            },
          },
          B: { parameters: { wrong_model_field: { type: 'string' } } },
        },
      },
    }
    const before = JSON.stringify(response)
    mountPreview()
    const duration = await screen.findByRole('row', {
      name: /seconds.*Document default/,
    })
    const cells = within(duration).getAllByRole('cell')
    expect(cells[1]).toHaveTextContent('Minimum:5')
    expect(cells[1]).toHaveTextContent('Maximum:15')
    expect(cells[1]).toHaveTextContent('Document default:5')
    expect(cells[2]).toHaveTextContent('Default value: Not set')
    const images = screen.getByRole('row', {
      name: /images.*Maximum item count/,
    })
    expect(within(images).getAllByRole('cell')[1]).toHaveTextContent(
      'Maximum item count:9'
    )
    expect(within(images).getAllByRole('cell')[2]).toHaveTextContent(
      'Maximum item count:2'
    )
    expect(
      screen.getByRole('row', { name: /vendor_extension.*Exact model option/ })
    ).toHaveTextContent('Not configured')
    expect(
      screen.getByRole('row', { name: /vendor_only.*Maximum length/ })
    ).toBeInTheDocument()
    expect(screen.queryByText('wrong_model_field')).not.toBeInTheDocument()
    expect(screen.queryByText('480p')).not.toBeInTheDocument()
    expect(JSON.stringify(response)).toBe(before)
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('shows saved resolution tiers without inventing a base price or evaluating an advanced expression', async () => {
    response.configuration.groups.g.modes.text_video.billing = {
      expression:
        'u("resolution") == "720p" ? tier("720p", 0.21 * u("seconds")) : u("resolution") == "1080p" ? tier("1080p", 0.27 * u("seconds")) : nil',
      currency: 'USD',
      confirmed: true,
    }
    response.configuration.groups.g.modes.text_video.cost = {
      amount: 0,
      currency: 'CNY',
      unit: 'request_count',
      confirmed: true,
    }
    response.configuration.groups.g.modes.video_ref.billing = {
      expression: 'tier("custom", u("seconds") * 0.123456789)',
      currency: 'USD',
      confirmed: false,
    }
    const before = JSON.stringify(response)
    mountPreview()
    const prices = await screen.findByRole('region', {
      name: 'Saved model prices',
    })
    await within(prices).findByText(/720p:/)
    expect(prices).toHaveTextContent('$0.21 / Per second')
    expect(prices).toHaveTextContent('$0.27 / Per second')
    expect(within(prices).queryByText(/Base price:/)).not.toBeInTheDocument()
    expect(prices).toHaveTextContent('Custom pricing expression')
    expect(prices).toHaveTextContent('0.123456789')
    expect(prices).toHaveTextContent('Pending confirmation')
    expect(prices).toHaveTextContent('CN¥0.00 / Per request')
    expect(JSON.stringify(response)).toBe(before)
    expect(mocks.check).not.toHaveBeenCalled()
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('does not substitute documentation from an unrelated interface or infer unsupported fields', async () => {
    response.configuration.groups.g.modes.text_video.protocol = {
      templateModel: 'missing',
      confirmed: false,
    }
    response.catalog.interfaces = {
      other: {
        id: 'other',
        kind: 'video',
        status: 'reviewed',
        source: { url: 'https://docs.invalid' },
        parameters: { unrelated: { type: 'string' } },
        modes: { text_video: { required: [] } },
      },
    }
    mountPreview()
    await screen.findAllByText('No documentation matches the saved interface')
    expect(screen.queryByText('unrelated')).not.toBeInTheDocument()
    expect(
      screen.getAllByText('Not stated in documentation').length
    ).toBeGreaterThan(0)
    expect(
      screen.getByText('Interface applicability is not confirmed')
    ).toBeInTheDocument()
  })
})
