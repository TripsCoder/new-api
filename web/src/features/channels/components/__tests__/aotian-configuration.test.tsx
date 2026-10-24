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
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, expect, test } from 'vitest'

import { channelSchema, type Channel } from '../../types'
import { ChannelsProvider } from '../channels-provider'
import { DataTableRowActions } from '../data-table-row-actions'

const i18n = createInstance()
await i18n.init({
  lng: 'en',
  resources: { en: { translation: {} } },
  initAsync: false,
})
const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  localStorage.clear()
})

test.each([
  ['aotian_video', true],
  ['fenglang_video', true],
  ['unknown_unreviewed_plugin', false],
])(
  'channel plugin %s exposes configuration only when reviewed',
  async (key, reviewed) => {
    const channel = channelSchema.parse({
      id: 17,
      name: 'AoTian video draft',
      type: 61,
      key: '',
      status: 2,
      created_time: 0,
      test_time: 0,
      response_time: 0,
      balance_updated_time: 0,
      setting: JSON.stringify({ task_plugin_key: key }),
    })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    clients.push(client)
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={client}>
          <ChannelsProvider>
            <DataTableRowActions row={{ original: channel } as Row<Channel>} />
          </ChannelsProvider>
        </QueryClientProvider>
      </I18nextProvider>
    )
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Open menu' }))
    if (reviewed) {
      expect(
        await screen.findByRole('menuitem', {
          name: 'Model and interface settings',
        })
      ).toBeInTheDocument()
    } else {
      expect(
        screen.queryByRole('menuitem', { name: 'Model and interface settings' })
      ).not.toBeInTheDocument()
    }
  }
)
