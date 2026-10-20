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
import { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { Toaster } from 'sonner'

import catalogFixture from './channel-workflow-catalog.fixture.json'
import { Button } from './components/ui/button'

import './styles/index.css'
import {
  createSharedGroup,
  clone,
} from './features/channels/model-configuration/configuration'
import { ModelConfigurationDialog } from './features/channels/model-configuration/model-configuration-dialog'
import type {
  Catalog,
  Configuration,
} from './features/channels/model-configuration/types'
import { channelSchema } from './features/channels/types'
import i18n from './i18n/config'
import { api } from './lib/api'

const catalog = catalogFixture as unknown as Catalog
const all = Object.values(catalog.models)
const rich = all.find((model) => model.modes.mixed_ref)
const names = [
  rich?.id,
  all.find((model) => model.kind === 'video' && model.id !== rich?.id)?.id,
  all.find((model) => model.kind === 'image' && Object.keys(model.modes).length)
    ?.id,
].filter((name): name is string => !!name)
const baselineNames = [...names, 'historical-not-returned']
const returned = [...names, 'new-unconfirmed-model']
let saved: Configuration = {
  format: 'channel-model-configuration/v1',
  revision: 1,
  provider: catalog.key,
  groups: {},
  bindings: {},
}
saved = createSharedGroup(saved, catalog, names, 'saved-shared')
const initial = clone(saved)
const channel = channelSchema.parse({
  id: 9001,
  type: 61,
  key: '',
  status: 1,
  name: '隔离预览 · 模拟渠道（不连接业务库）',
  created_time: 0,
  test_time: 0,
  response_time: 0,
  balance_updated_time: 0,
  models: baselineNames.join(','),
  setting: JSON.stringify({ task_plugin_key: catalog.key }),
})
api.defaults.adapter = async (config) => {
  const url = config.url ?? ''
  let data: unknown
  const payload =
    typeof config.data === 'string' ? JSON.parse(config.data) : config.data
  if (url.endsWith('/model-configuration') && config.method === 'get') {
    data = {
      success: true,
      data: {
        pluginVersion: '2.0.1',
        channelModels: channel.models,
        configuration: clone(saved),
        versions: [{ channelId: 9001, revision: 1, createdAt: 0, actorId: 0 }],
        catalog,
      },
    }
  } else if (url.endsWith('/model-configuration') && config.method === 'put') {
    if (payload.expectedRevision !== saved.revision) {
      data = {
        success: false,
        message: 'Channel model configuration changed; reload before saving',
      }
    } else {
      saved = { ...clone(payload.configuration), revision: saved.revision + 1 }
      channel.models = channel.models
        .split(',')
        .filter((name) => !payload.removeModels?.includes(name))
        .join(',')
      data = { success: true, data: saved }
    }
  } else if (url === '/api/channel/fetch_models/9001') {
    data = {
      success: true,
      data: returned,
      discovery: {
        source: 'upstream',
        checked_at: 0,
        plugin_key: catalog.key,
        source_url: 'https://fixture.invalid/models',
        models: returned.map((id) => ({
          id,
          adapted: !!catalog.models[id],
          configured: baselineNames.includes(id),
          pricing_status: 'not_checked',
        })),
      },
    }
  } else if (url.endsWith('/availability')) data = { success: true, data: {} }
  else if (url.endsWith('/model-configuration/restore')) {
    saved = { ...clone(initial), revision: saved.revision + 1 }
    data = { success: true, data: saved }
  } else if (url.endsWith('/model-configuration/check')) {
    const response = await fetch(
      'http://127.0.0.1:13123/api/channel/9001/model-configuration/check',
      {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    )
    if (!response.ok) throw new Error('隔离离线校验服务不可用，未执行校验')
    data = await response.json()
  } else {
    throw new Error(
      'Isolated preview blocks all other endpoints, including paid generation'
    )
  }
  return { data, status: 200, statusText: 'OK', headers: {}, config }
}
void i18n.changeLanguage('zhCN')
const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
export function Preview() {
  const [open, setOpen] = useState(true)
  return (
    <QueryClientProvider client={query}>
      <main className='p-6'>
        <h1 className='text-xl font-semibold'>正式组件隔离预览</h1>
        <p className='my-3 text-sm'>
          使用正式页面同一套组件与配置逻辑。渠道、返回列表、价格与检查结果均为模拟数据；保存仅留在本页内存，刷新重置。不会访问业务数据库或供应商，收费调用被阻止。
        </p>
        <Button onClick={() => setOpen(true)}>打开模型与接口配置</Button>
        <ModelConfigurationDialog
          channel={channel}
          open={open}
          onOpenChange={setOpen}
          preview
        />
        <Toaster />
      </main>
    </QueryClientProvider>
  )
}
const root = document.querySelector('#root')
if (root) {
  ReactDOM.createRoot(root).render(<Preview />)
}
