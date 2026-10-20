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
import type { Row } from '@tanstack/react-table'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import {
  ChannelsProvider,
  useChannels,
} from '../../components/channels-provider'
import { DataTableRowActions } from '../../components/data-table-row-actions'
import { channelSchema, type Channel } from '../../types'
import { SavedModelPricesDialog } from '../saved-model-prices-dialog'
import { applyCustomerPrice } from '../simple-pricing'
import type { Configuration, ConfigurationResponse, Mode } from '../types'

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }))
vi.mock('../api', () => ({
  getModelConfiguration: mocks.get,
  saveModelConfiguration: mocks.save,
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
const mode: Mode = {
  enabled: true,
  input: {},
  parameters: {
    resolution: { type: 'string', enum: ['480p', '720p', '1080p'] },
    seconds: { type: 'integer' },
  },
  mapping: { seconds: 'seconds', resolution: 'resolution' },
  cost: { amount: 2, currency: 'CNY', unit: 'second', confirmed: true },
}
let persisted: Configuration
let client: QueryClient
const originalAuth = useAuthStore.getState().auth
const close = vi.fn()
function response(): ConfigurationResponse {
  return {
    configuration: structuredClone(persisted),
    channelModels: 'A,B',
    versions: [],
    catalog: {
      key: 'lxmone_media',
      name: 'fixture',
      baseURL: 'https://fixture.invalid',
      docsURL: 'https://docs.invalid',
      documents: [],
      warnings: [],
      models: Object.fromEntries(
        ['A', 'B'].map((id) => [
          id,
          {
            id,
            kind: 'video',
            status: 'reviewed',
            parameters: {},
            modes: {},
            source: { url: 'https://docs.invalid' },
          },
        ])
      ),
    },
  }
}
function mount() {
  return render(
    <QueryClientProvider client={client}>
      <SavedModelPricesDialog channel={channel} onClose={close} />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  close.mockClear()
  persisted = {
    format: 'channel-model-configuration/v1',
    provider: 'lxmone_media',
    revision: 14,
    groups: {
      g: {
        name: 'shared',
        modes: {
          text_video: structuredClone(mode),
          video_ref: structuredClone(mode),
        },
      },
    },
    bindings: {
      A: { text_video: { groupId: 'g' }, video_ref: { groupId: 'g' } },
      B: { text_video: { groupId: 'g' } },
      removed: { text_video: { groupId: 'g' } },
    },
  }
  persisted = applyCustomerPrice(
    persisted,
    'A',
    'text_video',
    {
      unit: 'seconds',
      value: '0.5',
      resolutions: { '480p': '0.1', '720p': '0.2', '1080p': '0.3' },
    },
    true
  )
  mocks.get.mockReset().mockImplementation(async () => response())
  mocks.save
    .mockReset()
    .mockImplementation(async (_id, draft: Configuration) => {
      persisted = { ...structuredClone(draft), revision: draft.revision + 1 }
      return persisted
    })
})
afterEach(() => {
  useAuthStore.setState({ auth: originalAuth })
  client.clear()
})
function SelectedDialog() {
  const state = useChannels()
  return (
    <output>
      {state.open === 'saved-model-prices' ? state.currentRow?.name : ''}
    </output>
  )
}
describe('editing saved channel prices', () => {
  it.each([
    ['missing resolution', {}],
    ['fixed resolution', { resolution: { enum: ['720p'] } }],
    [
      'fixed output tier in several orientations',
      { size: { enum: ['1280x720', '720x1280', '720x720'] } },
    ],
  ])(
    'hides resolution pricing for %s and preserves saved prices',
    async (_name, parameters) => {
      persisted.groups.g.modes.text_video.parameters =
        structuredClone(parameters)
      persisted.groups.g.modes.video_ref.parameters =
        structuredClone(parameters)
      const before = structuredClone(persisted)
      mount()
      await screen.findByRole('spinbutton', { name: 'A: Billing amount (USD)' })
      expect(
        screen.queryByRole('checkbox', { name: 'A: Price by video resolution' })
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('spinbutton', {
          name: 'A: 480p Billing amount (USD)',
        })
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('spinbutton', {
          name: 'A: 1080p Billing amount (USD)',
        })
      ).not.toBeInTheDocument()
      expect(mocks.save).not.toHaveBeenCalled()
      expect(persisted).toEqual(before)
    }
  )
  it('uses individual allowed resolutions and excludes unsupported tiers when saving', async () => {
    for (const key of ['text_video', 'video_ref']) {
      persisted.bindings.A[key].parameters = {
        resolution: { type: 'string', enum: ['720p', '1080p'] },
      }
    }
    const before = structuredClone(persisted)
    mount()
    const price = await screen.findByRole('spinbutton', {
      name: 'A: 720p Billing amount (USD)',
    })
    expect(
      screen.getByRole('spinbutton', { name: 'A: 1080p Billing amount (USD)' })
    ).toHaveValue(0.3)
    expect(
      screen.queryByRole('spinbutton', { name: 'A: 480p Billing amount (USD)' })
    ).not.toBeInTheDocument()
    fireEvent.change(price, { target: { value: '0.25' } })
    await userEvent.click(screen.getByRole('button', { name: 'Save prices' }))
    await waitFor(() => expect(close).toHaveBeenCalled())
    expect(persisted.bindings.A.text_video.billing?.expression).not.toContain(
      '480p'
    )
    expect(persisted.bindings.A.text_video.billing?.expression).toContain(
      'tier("720p", 0.25 * u("seconds"))'
    )
    expect(persisted.groups).toEqual(before.groups)
    expect(persisted.bindings.B).toEqual(before.bindings.B)
  })
  it('opens the saved-price editor from the selected channel menu', async () => {
    useAuthStore.setState({
      auth: {
        ...originalAuth,
        user: { id: 1, username: 'root', role: ROLE.SUPER_ADMIN },
      },
    })
    render(
      <QueryClientProvider client={client}>
        <ChannelsProvider>
          <DataTableRowActions row={{ original: channel } as Row<Channel>} />
          <SelectedDialog />
        </ChannelsProvider>
      </QueryClientProvider>
    )
    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Edit saved model prices' })
    )
    expect(screen.getByRole('status')).toHaveTextContent('fixture')
  })
  it('does not submit twice or close while a price save is pending', async () => {
    let finish: ((value: Configuration) => void) | undefined
    mocks.save.mockImplementationOnce(
      () =>
        new Promise<Configuration>((resolve) => {
          finish = resolve
        })
    )
    mount()
    const price = await screen.findByRole('spinbutton', {
      name: 'A: 720p Billing amount (USD)',
    })
    fireEvent.change(price, { target: { value: '0.4' } })
    await userEvent.dblClick(
      screen.getByRole('button', { name: 'Save prices' })
    )
    expect(mocks.save).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(close).not.toHaveBeenCalled()
    finish?.(persisted)
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
  })
  it('loads existing resolution prices, saves only price overrides and reopens with the saved rate', async () => {
    const before = structuredClone(persisted)
    const view = mount()
    const price = await screen.findByRole('spinbutton', {
      name: 'A: 720p Billing amount (USD)',
    })
    expect(price).toHaveValue(0.2)
    expect(
      screen.queryByText('Advanced: provider cost evidence, units and formulas')
    ).not.toBeInTheDocument()
    fireEvent.change(price, { target: { value: '0.25' } })
    await userEvent.click(screen.getByRole('button', { name: 'Save prices' }))
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(mocks.save).toHaveBeenCalledWith(
      12,
      expect.objectContaining({ revision: 14 }),
      [],
      [],
      'A,B'
    )
    expect(persisted.bindings.A.text_video.billing?.expression).toContain(
      'tier("720p", 0.25 * u("seconds"))'
    )
    expect(persisted.bindings.A.video_ref.billing).toEqual(
      persisted.bindings.A.text_video.billing
    )
    expect(persisted.groups).toEqual(before.groups)
    expect(persisted.bindings.B).toEqual(before.bindings.B)
    expect(persisted.bindings.removed).toEqual(before.bindings.removed)
    view.unmount()
    mount()
    expect(
      await screen.findByRole('spinbutton', {
        name: 'A: 720p Billing amount (USD)',
      })
    ).toHaveValue(0.25)
  })
  it('lets a user modify one generation mode while retaining other modes and unrouted history', async () => {
    const before = structuredClone(persisted)
    mount()
    await screen.findByRole('spinbutton', {
      name: 'A: 720p Billing amount (USD)',
    })
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Generation mode being edited' })
    )
    await userEvent.click(
      await screen.findByRole('option', { name: 'Use reference video' })
    )
    fireEvent.change(
      screen.getByRole('spinbutton', { name: 'A: 720p Billing amount (USD)' }),
      { target: { value: '0' } }
    )
    await userEvent.click(screen.getByRole('combobox', { name: 'Model' }))
    expect(
      screen.queryByRole('option', { name: 'removed' })
    ).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await userEvent.click(screen.getByRole('button', { name: 'Save prices' }))
    await waitFor(() => expect(close).toHaveBeenCalled())
    expect(persisted.bindings.A.text_video).toEqual(
      before.bindings.A.text_video
    )
    expect(persisted.bindings.A.video_ref.billing?.expression).toContain(
      'tier("720p", 0 * u("seconds"))'
    )
  })
  it('keeps blank and negative edits unsaved and cancels without writing', async () => {
    mount()
    const price = await screen.findByRole('spinbutton', {
      name: 'A: 720p Billing amount (USD)',
    })
    for (const value of ['', '-1']) {
      fireEvent.change(price, { target: { value } })
      expect(screen.getByRole('button', { name: 'Save prices' })).toBeDisabled()
    }
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(close).toHaveBeenCalledTimes(1)
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('retains edits after a revision conflict and reloads explicitly before using the newer revision', async () => {
    mocks.save.mockRejectedValueOnce(
      new Error('Channel model configuration changed; reload before saving')
    )
    mount()
    const price = await screen.findByRole('spinbutton', {
      name: 'A: 720p Billing amount (USD)',
    })
    fireEvent.change(price, { target: { value: '0.8' } })
    await userEvent.click(screen.getByRole('button', { name: 'Save prices' }))
    await screen.findByText(
      'Channel model configuration changed; reload before saving'
    )
    expect(price).toHaveValue(0.8)
    expect(close).not.toHaveBeenCalled()
    persisted = applyCustomerPrice(
      persisted,
      'A',
      'text_video',
      { unit: 'seconds', value: '0.9' },
      true
    )
    persisted.revision = 15
    await userEvent.click(
      screen.getByRole('button', { name: 'Reload pricing' })
    )
    await waitFor(() =>
      expect(
        screen.queryByRole('spinbutton', {
          name: 'A: 720p Billing amount (USD)',
        })
      ).not.toBeInTheDocument()
    )
    fireEvent.change(
      screen.getByRole('spinbutton', { name: 'A: Billing amount (USD)' }),
      { target: { value: '1' } }
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save prices' }))
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(mocks.save.mock.calls[1][1].revision).toBe(15)
  })
  it('retries a failed load and shows an empty state when there are no saved bindings', async () => {
    mocks.get.mockRejectedValueOnce(new Error('fixture unavailable'))
    persisted.bindings = {}
    mount()
    await screen.findByText('fixture unavailable')
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('No saved model configuration to price')
    expect(screen.getByRole('button', { name: 'Save prices' })).toBeDisabled()
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
