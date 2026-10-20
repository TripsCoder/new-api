import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  waitFor,
  render,
  screen,
  fireEvent,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
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
import { beforeEach, describe, expect, it, vi } from 'vitest'

import publicCatalog from '../../../channel-workflow-catalog.fixture.json'
import { channelSchema } from '../types'
import { createSharedGroup } from './configuration'
import {
  applyDocumentInterface,
  projectDocumentInterfaces,
} from './document-interfaces'
import { MappingPreview } from './mapping-preview'
import { ModelConfigurationDialog } from './model-configuration-dialog'
import { ParameterFields } from './parameter-fields'
import type { Catalog, Configuration } from './types'
import { ParameterComparison, FunctionChoice } from './workflow-panels'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  check: vi.fn(),
  fetch: vi.fn(),
  tryCall: vi.fn(),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (s: string) => s, i18n: { language: 'en' } }),
}))
vi.mock('./api', () => ({
  getModelConfiguration: mocks.get,
  saveModelConfiguration: mocks.save,
  checkModelConfiguration: mocks.check,
  getConfigurationAvailability: vi.fn(),
  tryModelConfiguration: mocks.tryCall,
  getRealConfigurationTask: vi.fn(),
  getRealConfigurationArtifacts: vi.fn(),
  restoreModelConfiguration: vi.fn(),
}))
vi.mock('../hooks/use-channel-model-discovery', () => ({
  useChannelModelDiscovery: () => ({
    status: 'success',
    models: ['A', 'B', 'C', 'new'],
    fetch: mocks.fetch,
  }),
}))
const source = { url: 'https://docs.example/models' }
const catalog = {
  key: 'yuxibox_media',
  name: 'fixture',
  docsURL: source.url,
  baseURL: 'https://fixture.invalid',
  documents: [],
  warnings: [],
  models: Object.fromEntries(
    ['A', 'B', 'C'].map((id) => [
      id,
      {
        id,
        kind: 'video',
        status: 'reviewed',
        parameters: {
          prompt: { type: 'string' },
          images: { type: 'array', items: { type: 'string' } },
          videos: { type: 'array', items: { type: 'string' } },
          audios: { type: 'array', items: { type: 'string' } },
          seconds: { type: 'number', default: 5 },
          resolution: { type: 'string', enum: ['720p', '1080p'] },
        },
        mapping: {},
        modes: {
          text_video: { required: [] },
          image_video: { required: [] },
          video_ref: { required: [] },
          audio_ref: { required: [] },
          mixed_ref: { required: [] },
        },
        source,
      },
    ])
  ),
} as Catalog
let baseline: Configuration
const channel = channelSchema.parse({
  id: 9001,
  type: 61,
  key: '',
  status: 1,
  name: 'fixture',
  models: 'A,B,C,old',
  created_time: 0,
  test_time: 0,
  response_time: 0,
  balance_updated_time: 0,
})
function mount(models = 'old', preview = true) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ModelConfigurationDialog
        channel={{ ...channel, models }}
        open
        onOpenChange={vi.fn()}
        preview={preview}
      />
    </QueryClientProvider>
  )
}
async function advanceToParameters() {
  await screen.findByRole('button', {
    name: 'Next: output type and functions',
  })
  await userEvent.click(
    screen.getByRole('button', { name: 'Next: output type and functions' })
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Next: documented parameters' })
  )
  await screen.findByText('Parameters for this function')
}
describe('actual channel workflow dialog', () => {
  it('lets an administrator supplement missing video fields and retains them after interface selection and reopening', async () => {
    const template = structuredClone(catalog.models.A)
    template.id = 'interface:manual'
    template.interfaceId = template.id
    delete template.parameters.videos
    delete template.modes.video_ref
    const manualCatalog = {
      ...catalog,
      interfaces: { [template.id]: template },
      models: { A: { ...template, id: 'A' } },
    }
    let current = createSharedGroup(
      {
        format: 'channel-model-configuration/v1',
        revision: 0,
        provider: catalog.key,
        groups: {},
        bindings: {},
      },
      manualCatalog,
      ['A'],
      'g'
    )
    function Fixture() {
      const [draft, setDraft] = useState(current)
      return (
        <FunctionChoice
          draft={draft}
          catalog={
            projectDocumentInterfaces(manualCatalog, ['A'], 'video', draft) ??
            manualCatalog
          }
          selected={['A']}
          groupId='g'
          kind='video'
          onKind={vi.fn()}
          onChange={(next) => {
            current = next
            setDraft(next)
          }}
        />
      )
    }
    const view = render(<Fixture />)
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Supplement missing capability: Use reference video',
      })
    )
    expect(
      screen.getByRole('button', { name: 'Apply supplement to draft' })
    ).toBeDisabled()
    await userEvent.type(
      screen.getByLabelText('Provider field name · videos'),
      'reference_videos'
    )
    await userEvent.type(
      screen.getByLabelText('Manual support evidence'),
      'Provider confirmed URL array'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Apply supplement to draft' })
    )
    expect(
      screen.getByRole('checkbox', { name: /^Use reference video/ })
    ).toBeChecked()
    const applied = applyDocumentInterface(
      current,
      manualCatalog,
      ['A'],
      'g',
      template.id
    )
    const reopened = JSON.parse(JSON.stringify(applied)) as Configuration
    expect(
      reopened.bindings.A.video_ref.protocol?.supplement?.video_ref.fields
        .videos.vendor
    ).toBe('reference_videos')
    expect(
      projectDocumentInterfaces(manualCatalog, ['A'], 'video', reopened)?.models
        .A.parameters.videos
    ).toBeDefined()
    view.unmount()
  })
  it('filters legacy generic mappings and media fields when switching the selected capability', () => {
    const mode = {
      enabled: true,
      input: {},
      parameters: {
        prompt: { type: 'string' },
        seconds: { type: 'integer' },
        images: { type: 'array' },
        videos: { type: 'array' },
        audios: { type: 'array' },
      },
      mapping: {
        prompt: 'prompt',
        seconds: 'seconds',
        images: 'images',
        videos: 'videos',
        audios: 'audios',
        seed: '@ignore',
        quality: '@ignore',
        n: '@reject',
      },
      cost: { amount: null, confirmed: false },
    }
    const before = structuredClone(mode)
    const { rerender } = render(
      <MappingPreview mode={mode} capability='text_video' onChange={vi.fn()} />
    )
    expect(
      screen.queryByRole('combobox', { name: '处理方式: seed' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('combobox', { name: '处理方式: quality' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('combobox', { name: '处理方式: images' })
    ).not.toBeInTheDocument()
    rerender(
      <MappingPreview mode={mode} capability='image_video' onChange={vi.fn()} />
    )
    expect(
      screen.getByRole('combobox', { name: '处理方式: images' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('combobox', { name: '处理方式: videos' })
    ).not.toBeInTheDocument()
    rerender(
      <MappingPreview mode={mode} capability='mixed_ref' onChange={vi.fn()} />
    )
    expect(
      screen.getByRole('combobox', { name: '处理方式: videos' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('combobox', { name: '处理方式: audios' })
    ).toBeInTheDocument()
    expect(mode).toEqual(before)
  })

  it('compares different documented duration aliases in one row without changing their stored keys', () => {
    const reference = {
      ...catalog,
      models: {
        ...catalog.models,
        A: {
          ...catalog.models.A,
          parameters: { seconds: { type: 'integer', default: 5 } },
        },
        B: {
          ...catalog.models.B,
          parameters: { duration: { type: 'integer', default: 8 } },
        },
      },
    }
    const document = createSharedGroup(
      {
        format: 'channel-model-configuration/v1',
        provider: catalog.key,
        revision: 0,
        groups: {},
        bindings: {},
      },
      reference,
      ['A', 'B'],
      'g'
    )
    render(
      <ParameterComparison
        draft={document}
        baseline={document}
        models={['A', 'B']}
        modeKey='text_video'
      />
    )
    expect(screen.getAllByText('时长')).toHaveLength(1)
    expect(screen.getByText('当前默认：5')).toBeInTheDocument()
    expect(screen.getByText('当前默认：8')).toBeInTheDocument()
    expect(document.bindings.A.text_video.input).toHaveProperty('seconds', 5)
    expect(document.bindings.B.text_video.input).toHaveProperty('duration', 8)
  })

  it('shows inherited required fields read-only and one editable duration policy including ignore', async () => {
    const initial = {
      enabled: true,
      input: {},
      parameters: {
        prompt: { type: 'string', required: true },
        seconds: { type: 'integer' },
      },
      mapping: {
        prompt: 'prompt',
        seconds: 'seconds',
        duration: 'seconds',
        duration_seconds: 'seconds',
      },
      cost: { amount: null, confirmed: false },
    }
    function Editor() {
      const [mode, setMode] = useState(initial)
      return (
        <>
          <ParameterFields
            mode={mode}
            onChange={(next) => setMode(next as typeof initial)}
          />
          <MappingPreview
            documentedNames={{ seconds: 'duration' }}
            mode={mode}
            onChange={(next) => setMode(next as typeof initial)}
          />
          <output data-testid='policies'>{JSON.stringify(mode.mapping)}</output>
        </>
      )
    }
    render(<Editor />)
    expect(
      within(screen.getByRole('table')).getAllByText('duration')
    ).toHaveLength(2)
    expect(
      within(screen.getByRole('table')).queryByText('seconds')
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('required-parameter-prompt')).toHaveTextContent(
      'Required by the document'
    )
    expect(
      screen.queryByRole('textbox', { name: 'Prompt' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('combobox', { name: '处理方式: prompt' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('combobox', { name: '处理方式: duration' })
    ).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('combobox', { name: '处理方式: seconds' })
    )
    await userEvent.click(screen.getByRole('option', { name: '明确忽略' }))
    expect(
      JSON.parse(screen.getByTestId('policies').textContent ?? '{}')
    ).toMatchObject({
      seconds: '@ignore',
      duration: '@ignore',
      duration_seconds: '@ignore',
      prompt: 'prompt',
    })
  })
  beforeEach(() => {
    baseline = createSharedGroup(
      {
        format: 'channel-model-configuration/v1',
        provider: 'yuxibox_media',
        revision: 1,
        groups: {},
        bindings: {},
      },
      catalog,
      ['A', 'B', 'C'],
      'original'
    )
    mocks.get.mockResolvedValue({
      pluginVersion: '2.0.1',
      configuration: baseline,
      catalog,
      versions: [],
    })
    mocks.save.mockImplementation(async (_id, doc) => ({
      ...doc,
      revision: 2,
    }))
    mocks.tryCall.mockResolvedValue({
      taskId: 'isolated-fake-test',
      status: 'SUBMITTED',
    })
    mocks.check.mockResolvedValue({
      kind: 'input_check',
      actualCall: false,
      request: {},
      message: 'fixture',
    })
  })
  it('loads interface fields for actual IDs immediately and keeps them available in individual settings', async () => {
    const entry = structuredClone(catalog.models.A)
    entry.id = 'interface:fixture'
    entry.title = 'Document request fields'
    entry.path = '/v1/videos'
    entry.parameters.prompt.required = true
    mocks.get.mockResolvedValueOnce({
      pluginVersion: '2.1.0',
      configuration: {
        format: 'channel-model-configuration/v1',
        provider: catalog.key,
        revision: 0,
        groups: {},
        bindings: {},
      },
      catalog: { ...catalog, models: {}, interfaces: { [entry.id]: entry } },
      versions: [],
    })
    mount()
    await userEvent.click(await screen.findByRole('checkbox', { name: 'new' }))
    await advanceToParameters()
    expect(
      screen.getByRole('combobox', { name: 'new: Documented interface' })
    ).toBeVisible()
    const fields = screen.getByTestId('selected-capability-parameters')
    expect(
      within(fields).getAllByRole('checkbox', {
        name: /^Include parameter: seconds/,
      }).length
    ).toBeGreaterThan(0)
    const row = screen.getByRole('row', { name: /new.*Individual settings/ })
    await userEvent.click(
      within(row).getByRole('button', { name: 'new: Individual settings' })
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Individual model settings',
    })
    expect(
      within(dialog).getByRole('combobox', {
        name: 'new: Documented interface',
      })
    ).toBeInTheDocument()
    expect(
      within(dialog).getByRole('checkbox', {
        name: /^Include parameter: seconds/,
      })
    ).toBeInTheDocument()
  })
  it('uses one classification with shared search and selection across tabs', async () => {
    mount(channel.models)
    await screen.findByRole('tab', { name: 'Newly discovered models (1)' })
    expect(screen.getAllByRole('tablist')).toHaveLength(1)
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    const search = screen.getByRole('textbox', { name: 'Search models...' })
    expect(
      screen.getAllByRole('textbox', { name: 'Search models...' })
    ).toHaveLength(1)
    await userEvent.click(screen.getByRole('checkbox', { name: 'new' }))
    await userEvent.click(screen.getByRole('tab', { name: 'Configured (3)' }))
    for (const name of ['A', 'B', 'C']) {
      expect(screen.getByRole('checkbox', { name })).toBeChecked()
    }
    await userEvent.click(screen.getByRole('checkbox', { name: 'A' }))
    await userEvent.type(search, 'new')
    expect(
      screen.queryByRole('checkbox', { name: 'B' })
    ).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('tab', { name: 'Newly discovered models (1)' })
    )
    expect(search).toHaveValue('new')
    expect(screen.getByRole('checkbox', { name: 'new' })).toBeChecked()
    await userEvent.click(screen.getByRole('tab', { name: 'Removed (1)' }))
    expect(
      screen.queryByRole('checkbox', { name: /Keep model: old/ })
    ).not.toBeInTheDocument()
    await userEvent.clear(search)
    expect(
      screen.getByRole('checkbox', { name: /Keep model: old/ })
    ).toBeChecked()
    await userEvent.click(screen.getByRole('tab', { name: 'Configured (3)' }))
    expect(screen.getByRole('checkbox', { name: 'A' })).not.toBeChecked()
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('shows only selected newly discovered models on the right across all three tabs and search', async () => {
    mount(channel.models)
    await screen.findByRole('tab', { name: 'Newly discovered models (1)' })
    const scope = screen.getByRole('complementary', {
      name: 'Actual affected models',
    })
    expect(
      within(scope).queryByRole('button', { name: 'new: Individual settings' })
    ).not.toBeInTheDocument()
    expect(
      within(scope).queryByRole('button', { name: 'old: Individual settings' })
    ).not.toBeInTheDocument()
    for (const name of ['A', 'B', 'C']) {
      expect(
        within(scope).queryByRole('button', {
          name: `${name}: Individual settings`,
        })
      ).not.toBeInTheDocument()
    }
    await userEvent.click(screen.getByRole('checkbox', { name: 'new' }))
    expect(
      within(scope).getByRole('button', { name: 'new: Individual settings' })
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Configured (3)' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'A' }))
    expect(
      within(scope).queryByRole('button', { name: 'A: Individual settings' })
    ).not.toBeInTheDocument()
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Search models...' }),
      'B'
    )
    expect(
      within(scope).getByRole('button', { name: 'new: Individual settings' })
    ).toBeInTheDocument()
    expect(
      within(scope).queryByRole('button', { name: 'C: Individual settings' })
    ).not.toBeInTheDocument()
    expect(within(scope).getByRole('heading')).toHaveTextContent('Selected · 1')
    expect(
      within(scope).getByText('new', { selector: 'p' })
    ).toBeInTheDocument()
    await userEvent.clear(
      screen.getByRole('textbox', { name: 'Search models...' })
    )
    await userEvent.click(screen.getByRole('tab', { name: 'Removed (1)' }))
    expect(
      screen.getByRole('checkbox', { name: /Keep model: old/ })
    ).toBeChecked()
    expect(
      within(scope).queryByRole('button', { name: 'old: Individual settings' })
    ).not.toBeInTheDocument()
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('clears the right-hand models when new selections are empty even while configured models remain selected', async () => {
    mount(channel.models)
    const added = await screen.findByRole('checkbox', { name: 'new' })
    await userEvent.click(added)
    await userEvent.click(added)
    await userEvent.click(
      await screen.findByRole('tab', { name: 'Configured (3)' })
    )
    for (const name of ['A', 'B', 'C']) {
      expect(screen.getByRole('checkbox', { name })).toBeChecked()
    }
    const scope = screen.getByRole('complementary', {
      name: 'Actual affected models',
    })
    expect(within(scope).queryAllByRole('button')).toHaveLength(0)
    expect(within(scope).getByRole('heading')).toHaveTextContent('Selected · 0')
  })
  it('removes edited but deselected models from every right-hand summary and action', async () => {
    mount('old')
    await userEvent.click(
      await screen.findByRole('button', { name: 'A: Individual settings' })
    )
    const modal = screen.getByRole('dialog', {
      name: 'Individual model settings',
    })
    await userEvent.type(
      within(modal).getByRole('textbox', { name: /Prompt/ }),
      'pending A edit'
    )
    await userEvent.click(
      within(modal).getByRole('button', { name: 'Apply individual settings' })
    )
    await userEvent.click(
      screen.getByRole('tab', { name: 'Newly discovered models (4)' })
    )
    await userEvent.click(screen.getByRole('checkbox', { name: 'A' }))
    const scope = screen.getByRole('complementary', {
      name: 'Actual affected models',
    })
    expect(
      within(scope).queryByText('A', { exact: true })
    ).not.toBeInTheDocument()
    expect(within(scope).getByText('B, C', { exact: true })).toBeInTheDocument()
    expect(within(scope).getByRole('heading')).toHaveTextContent('Selected · 2')
    expect(
      within(scope).queryByRole('button', { name: 'A: Individual settings' })
    ).not.toBeInTheDocument()
    for (const name of ['B', 'C']) {
      await userEvent.click(screen.getByRole('checkbox', { name }))
    }
    expect(within(scope).getByRole('heading')).toHaveTextContent('Selected · 0')
    expect(within(scope).getByText('No models selected')).toBeInTheDocument()
    expect(within(scope).queryAllByRole('button')).toHaveLength(0)
    expect(
      within(scope).queryByText('A', { exact: true })
    ).not.toBeInTheDocument()
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('uses only this batch of new selections through functions, parameters, prices, review and saving', async () => {
    baseline.bindings.old = structuredClone(baseline.bindings.C)
    const previous = structuredClone(baseline)
    mount('C,old')
    await userEvent.click(
      await screen.findByRole('tab', { name: 'Removed (1)' })
    )
    await userEvent.click(
      screen.getByRole('checkbox', { name: /Keep model: old/ })
    )
    await advanceToParameters()
    expect(
      screen.getByRole('heading', {
        name: 'Shared settings for selected models · 2',
      })
    ).toBeVisible()
    const parameters = screen.getByTestId('selected-capability-parameters')
    expect(
      within(parameters).queryByText('C', { exact: true })
    ).not.toBeInTheDocument()
    expect(
      within(parameters).queryByText('old', { exact: true })
    ).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: model prices' })
    )
    await userEvent.click(
      screen.getByText('Advanced: provider cost evidence, units and formulas')
    )
    expect(
      screen.getByRole('spinbutton', { name: 'A: Provider unit cost' })
    ).toBeVisible()
    expect(
      screen.getByRole('spinbutton', { name: 'B: Provider unit cost' })
    ).toBeVisible()
    expect(
      screen.queryByRole('spinbutton', { name: 'C: Provider unit cost' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('spinbutton', { name: 'old: Provider unit cost' })
    ).not.toBeInTheDocument()
    fireEvent.change(
      screen.getByRole('spinbutton', { name: 'A: Provider unit cost' }),
      {
        target: { value: '1.25' },
      }
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: check and save' })
    )
    const review = screen.getByTestId('model-save-review')
    expect(
      within(review).queryByText('C', { exact: true })
    ).not.toBeInTheDocument()
    expect(
      within(review).queryByText('old', { exact: true })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('checkbox', {
        name: 'I reviewed the changes and will save only this channel configuration',
      })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('checkbox', {
        name: 'Also add enabled bound models to this channel routing; keep every existing model',
      })
    ).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Save and apply to this channel' })
    )
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    expect(mocks.save.mock.calls[0][2]).toEqual(['A', 'B'])
    expect(mocks.save.mock.calls[0][3]).toEqual(['old'])
    const saved = mocks.save.mock.calls[0][1] as Configuration
    expect(saved.bindings.C).toEqual(previous.bindings.C)
    expect(saved.bindings.old).toEqual(previous.bindings.old)
    expect(saved.groups.original).toEqual(previous.groups.original)
    expect(saved.bindings.A.text_video.groupId).not.toBe('original')
    expect(saved.bindings.B.text_video.groupId).toBe(
      saved.bindings.A.text_video.groupId
    )
  })
  it('tests only the saved current batch with its enabled modes and preserves JSON per target', async () => {
    baseline.bindings.old = structuredClone(baseline.bindings.C)
    for (const mode of Object.values(baseline.groups.original.modes)) {
      mode.enabled = true
    }
    for (const binding of Object.values(baseline.bindings.A)) {
      binding.enabled = true
    }
    for (const [key, binding] of Object.entries(baseline.bindings.B)) {
      binding.enabled = key === 'video_ref'
    }
    mocks.save.mockImplementation(async (_id, doc: Configuration) => {
      const saved = { ...doc, revision: 2 }
      mocks.get.mockResolvedValue({
        pluginVersion: '2.0.1',
        configuration: saved,
        catalog,
        versions: [],
        channelModels: 'A,B,C,old',
      })
      return saved
    })
    mount('C,old', false)
    await advanceToParameters()
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: model prices' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: check and save' })
    )
    await userEvent.click(screen.getByText('Real generation test'))
    const panel = screen.getByText('Real generation test').closest('details')
    if (!panel) throw new Error('Real test panel is missing')
    const run = within(panel).getByRole('button', {
      name: 'Run one real call',
    })
    expect(run).toBeDisabled()
    await userEvent.click(
      screen.getByRole('button', { name: 'Save and apply to this channel' })
    )
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    const modelSelect = within(panel).getByRole('combobox', {
      name: 'Saved model for this test',
    })
    await userEvent.click(modelSelect)
    expect(screen.getByRole('option', { name: 'A' })).toBeVisible()
    expect(screen.getByRole('option', { name: 'B' })).toBeVisible()
    expect(screen.queryByRole('option', { name: 'C' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('option', { name: 'old' })
    ).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('option', { name: 'A' }))
    const modeSelect = within(panel).getByRole('combobox', {
      name: 'Enabled mode for this test',
    })
    await userEvent.click(modeSelect)
    await userEvent.click(
      screen.getByRole('option', { name: 'Use a reference image' })
    )
    const json = within(panel).getByRole('textbox', {
      name: 'Real call input JSON',
    }) as HTMLTextAreaElement
    expect(JSON.parse(json.value)).toHaveProperty('images')
    fireEvent.change(json, {
      target: {
        value: JSON.stringify({
          model: 'A',
          prompt: 'A image draft',
          images: ['https://media.example/image.png'],
        }),
      },
    })
    await userEvent.click(modeSelect)
    await userEvent.click(screen.getByRole('option', { name: 'Text to video' }))
    expect(JSON.parse(json.value)).not.toHaveProperty('images')
    await userEvent.click(modeSelect)
    await userEvent.click(
      screen.getByRole('option', { name: 'Use a reference image' })
    )
    expect(JSON.parse(json.value).prompt).toBe('A image draft')
    await userEvent.click(modelSelect)
    await userEvent.click(screen.getByRole('option', { name: 'B' }))
    expect(JSON.parse(json.value).model).toBe('B')
    expect(modeSelect).toHaveTextContent('Use reference video')
    await userEvent.click(modeSelect)
    expect(
      screen.queryByRole('option', { name: 'Text to video' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('option', { name: 'Use a reference image' })
    ).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('option', { name: 'Use reference video' })
    )
    fireEvent.change(json, {
      target: {
        value: JSON.stringify({
          model: 'B',
          prompt: 'B video',
          videos: ['https://media.example/video.mp4'],
        }),
      },
    })
    fireEvent.change(within(panel).getByRole('spinbutton'), {
      target: { value: '2' },
    })
    await userEvent.click(
      within(panel).getByRole('checkbox', {
        name: 'I accept that the provider account cost may be unknown',
      })
    )
    const charge = within(panel).getByRole('checkbox', {
      name: 'Charge my wallet for one real call on this channel',
    })
    await userEvent.click(charge)
    expect(run).toBeEnabled()
    fireEvent.change(json, {
      target: {
        value: JSON.stringify({
          model: 'B',
          prompt: 'B updated',
          videos: ['https://media.example/video.mp4'],
        }),
      },
    })
    await waitFor(() => expect(charge).not.toBeChecked())
    expect(run).toBeDisabled()
    expect(mocks.tryCall).not.toHaveBeenCalled()
    await userEvent.click(charge)
    await userEvent.click(run)
    await waitFor(() => expect(mocks.tryCall).toHaveBeenCalledTimes(1))
    expect(mocks.tryCall).toHaveBeenCalledWith(
      9001,
      2,
      'B',
      'video_ref',
      expect.objectContaining({
        prompt: 'B updated',
        videos: ['https://media.example/video.mp4'],
      }),
      2,
      true
    )
    await userEvent.click(modelSelect)
    await userEvent.click(screen.getByRole('option', { name: 'A' }))
    expect(charge).not.toBeChecked()
    expect(mocks.tryCall).toHaveBeenCalledTimes(1)
    expect(mocks.check).not.toHaveBeenCalled()
  })
  it('does not start a new-model batch when only configured or missing models are selected', async () => {
    baseline.bindings.old = structuredClone(baseline.bindings.A)
    mount(channel.models)
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Next: output type and functions',
      })
    )
    expect(
      screen.getByText('Select models to configure together')
    ).toBeVisible()
    expect(
      screen.queryByText('Choose output type, then supported functions')
    ).not.toBeInTheDocument()
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('reviews and saves explicit removals without starting a new-model parameter batch', async () => {
    baseline.bindings.old = structuredClone(baseline.bindings.A)
    const previous = structuredClone(baseline)
    mount(channel.models)
    await userEvent.click(
      await screen.findByRole('tab', { name: 'Removed (1)' })
    )
    await userEvent.click(
      screen.getByRole('checkbox', { name: /Keep model: old/ })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: check and save' })
    )
    expect(
      screen.getByRole('heading', { name: 'Review changes before saving' })
    ).toBeVisible()
    expect(
      screen.getByText('Models removed from this channel after saving')
    ).toBeVisible()
    expect(
      screen.queryByText('Parameters for this function')
    ).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Save and apply to this channel' })
    )
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    expect(mocks.save.mock.calls[0][1]).toEqual(previous)
    expect(mocks.save.mock.calls[0][2]).toEqual([])
    expect(mocks.save.mock.calls[0][3]).toEqual(['old'])
  })
  it('allows a selected new model to choose a document preset in individual settings before it has any bindings', async () => {
    mount()
    await userEvent.click(await screen.findByRole('checkbox', { name: 'new' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'new: Individual settings' })
    )
    const modal = screen.getByRole('dialog', {
      name: 'Individual model settings',
    })
    await userEvent.click(
      within(modal).getByRole('combobox', {
        name: 'new: Documented interface',
      })
    )
    await userEvent.click(await screen.findByRole('option', { name: 'A' }))
    expect(within(modal).getByRole('textbox', { name: /Prompt/ })).toBeVisible()
    expect(
      within(modal).getByRole('combobox', { name: /^Resolution/ })
    ).toBeVisible()
    await userEvent.click(within(modal).getByRole('button', { name: 'Cancel' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'new: Individual settings' })
    )
    expect(
      screen.getByRole('dialog', { name: 'Individual model settings' })
    ).not.toHaveTextContent('Document default')
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('loads visible document presets into empty public and individual parameter forms without auto-confirming unknown models', async () => {
    baseline.groups = {
      pending: {
        name: 'pending',
        modes: {
          text_video: {
            enabled: true,
            input: {},
            parameters: {},
            mapping: {},
            cost: { amount: null, confirmed: false },
          },
        },
      },
    }
    baseline.bindings = {
      new: { text_video: { groupId: 'pending' } },
      'new-two': { text_video: { groupId: 'pending' } },
    }
    mount()
    await advanceToParameters()
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Document parameter preset' })
    )
    await userEvent.click(await screen.findByRole('option', { name: 'A' }))
    const publicParameters = screen.getByTestId(
      'selected-capability-parameters'
    )
    const prompt = within(publicParameters).getByRole('textbox', {
      name: /Prompt/,
    })
    await userEvent.type(prompt, 'current public value')
    expect(
      within(publicParameters).getByRole('combobox', { name: 'Resolution' })
    ).toBeVisible()
    expect(
      screen.getAllByText(
        'Document rules loaded; real availability is not verified'
      )
    ).toHaveLength(1)
    await userEvent.click(
      screen.getByRole('button', { name: 'new: Individual settings' })
    )
    const modal = screen.getByRole('dialog', {
      name: 'Individual model settings',
    })
    expect(within(modal).getByRole('textbox', { name: /Prompt/ })).toHaveValue(
      'current public value'
    )
    expect(
      within(modal).getByRole('combobox', { name: /^Resolution/ })
    ).toBeVisible()
    expect(
      within(modal).getByRole('checkbox', {
        name: /I checked this interface applies/,
      })
    ).not.toBeChecked()
    expect(
      within(modal).getByRole('button', { name: 'Restore document rules' })
    ).toBeVisible()
    await userEvent.click(within(modal).getByRole('button', { name: 'Cancel' }))
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('shows the actual absent difference, defaults to keeping it, and previews explicit removal', async () => {
    mount()
    await userEvent.click(
      await screen.findByRole('tab', { name: 'Removed (1)' })
    )
    const keep = await screen.findByRole('checkbox', {
      name: /Keep model: old|^old$/,
    })
    expect(keep).toBeChecked()
    await userEvent.click(keep)
    expect(
      screen.getByText(/Will be removed only after saving/)
    ).toHaveTextContent('old')
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('bulk keeps or removes only visible missing models and preserves hidden choices', async () => {
    mocks.get.mockResolvedValue({
      pluginVersion: '2.0.1',
      configuration: baseline,
      catalog,
      versions: [],
      channelModels: 'A,B,C,old,other',
    })
    mount()
    await userEvent.click(
      await screen.findByRole('tab', { name: 'Removed (2)' })
    )
    const all = screen.getByRole('checkbox', {
      name: 'Select all (filtered) · Keep model',
    })
    const old = screen.getByRole('checkbox', { name: /Keep model: old/ })
    expect(all).toBeChecked()
    await userEvent.click(old)
    expect(all).toBePartiallyChecked()
    await userEvent.click(all)
    expect(old).toBeChecked()
    await userEvent.click(all)
    expect(old).not.toBeChecked()
    const search = screen.getByRole('textbox', { name: 'Search models...' })
    await userEvent.type(search, 'old')
    await userEvent.click(
      screen.getByRole('checkbox', {
        name: 'Select all (filtered) · Keep model',
      })
    )
    expect(
      screen.getByRole('checkbox', { name: /Keep model: old/ })
    ).toBeChecked()
    await userEvent.clear(search)
    expect(
      screen.getByRole('checkbox', { name: /Keep model: other/ })
    ).not.toBeChecked()
    expect(
      screen.getByRole('checkbox', {
        name: 'Select all (filtered) · Keep model',
      })
    ).toBePartiallyChecked()
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('allows pending capabilities, offers their interface editor and lists gaps at review with unique material columns', async () => {
    const pendingCatalog = {
      ...catalog,
      models: Object.fromEntries(
        Object.entries(catalog.models).map(([name, model]) => [
          name,
          {
            ...model,
            modes: { text_video: { required: [] } },
          },
        ])
      ),
    }
    mocks.get.mockResolvedValue({
      pluginVersion: '2.0.1',
      configuration: baseline,
      catalog: pendingCatalog,
      versions: [],
    })
    mount()
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Next: output type and functions',
      })
    )
    const reference = screen.getByRole('checkbox', {
      name: /^Use reference video/,
    })
    expect(reference).not.toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(reference)
    expect(reference).toBeChecked()
    const headers = screen.getAllByRole('columnheader')
    for (const name of [
      'Use a reference image',
      'Use reference video',
      'Use reference audio',
    ]) {
      expect(
        headers.filter((header) => header.textContent === name)
      ).toHaveLength(1)
    }
    for (const name of [
      'Reference images',
      'Reference videos',
      'Reference audio',
    ]) {
      expect(
        headers.filter((header) => header.textContent === name)
      ).toHaveLength(0)
    }
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: documented parameters' })
    )
    // Text-to-video remains the first active function; select the pending mode.
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Input capability' })
    )
    await userEvent.click(
      await screen.findByRole('option', { name: 'Use reference video' })
    )
    await userEvent.click(
      screen.getByText('Choose a documented interface for unconfirmed models')
    )
    expect(
      screen.getByRole('combobox', { name: 'A: Documented interface' })
    ).toBeVisible()
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: model prices' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: check and save' })
    )
    const gaps = screen
      .getAllByRole('alert')
      .find((alert) => alert.textContent?.includes('Interface settings needed'))
    expect(gaps).toBeDefined()
    expect(gaps).toHaveTextContent(
      'A · Use reference video: Choose a documented interface'
    )
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('does not skip two stages on a rapid double click and allows changing output type without clearing the draft', async () => {
    mount()
    const next = await screen.findByRole('button', {
      name: 'Next: output type and functions',
    })
    await userEvent.dblClick(next)
    expect(
      screen.getByText('Choose output type, then supported functions')
    ).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Image' }))
    expect(
      screen.getByRole('checkbox', { name: /^Image to image/ })
    ).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Video' }))
    expect(
      screen.getByRole('checkbox', { name: /^Text to video/ })
    ).toBeChecked()
  })
  it('retains invalid JSON, prevents Back, and uses exactly the applied draft for preview', async () => {
    mount()
    await advanceToParameters()
    await userEvent.click(
      screen.getByText('Advanced: complete parameters, JSON and file import')
    )
    const json = screen.getByRole('textbox', {
      name: 'Shared request parameter JSON',
    })
    fireEvent.change(json, { target: { value: '{bad' } })
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText('Parameters for this function')).toBeVisible()
    expect(json).toHaveValue('{bad')
  })
  it('keeps per-model prices independent and preview prevents real generation', async () => {
    mount()
    await advanceToParameters()
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: model prices' })
    )
    const a = screen.getByRole('spinbutton', { name: 'A: Provider unit cost' })
    fireEvent.change(a, { target: { value: '1.25' } })
    expect(
      screen.getByRole('spinbutton', { name: 'B: Provider unit cost' })
    ).toHaveValue(null)
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: check and save' })
    )
    await userEvent.click(screen.getByText('Real generation test'))
    expect(
      screen.getByRole('button', { name: 'Run one real call' })
    ).toBeDisabled()
  })
  it('uses one model price across optional inputs without a per-mode price selector', async () => {
    for (const mode of Object.values(baseline.groups.original.modes)) {
      mode.enabled = true
    }
    for (const bindings of Object.values(baseline.bindings)) {
      for (const binding of Object.values(bindings)) binding.enabled = true
    }
    mount()
    await advanceToParameters()
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: model prices' })
    )
    expect(
      screen.queryByRole('combobox', { name: 'Selling price scope' })
    ).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('combobox', { name: 'A: Billing method' })
    )
    await userEvent.click(
      await screen.findByRole('option', { name: 'Per request' })
    )
    fireEvent.change(
      screen.getByRole('spinbutton', { name: 'A: Billing amount (USD)' }),
      { target: { value: '2' } }
    )
    expect(
      screen.getByRole('spinbutton', { name: 'A: Billing amount (USD)' })
    ).toHaveValue(2)
    fireEvent.change(
      screen.getByRole('spinbutton', { name: 'A: Billing amount (USD)' }),
      { target: { value: '3' } }
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: check and save' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Save and apply to this channel' })
    )
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    const saved = mocks.save.mock.calls[0][1] as Configuration
    expect(saved.bindings.A.text_video.billing?.expression).toBe(
      '3 * u("request_count")'
    )
    expect(saved.bindings.A.image_video.billing?.expression).toBe(
      '3 * u("request_count")'
    )
    expect(saved.bindings.A.video_ref.billing?.expression).toBe(
      '3 * u("request_count")'
    )
    expect(saved.bindings.B.text_video.billing).toBeUndefined()
  })
  it('saves only the allowed video resolution rates and blocks an incomplete price', async () => {
    mount()
    await advanceToParameters()
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: model prices' })
    )
    await userEvent.click(
      screen.getByRole('combobox', { name: 'A: Billing method' })
    )
    await userEvent.click(
      await screen.findByRole('option', { name: 'Per second' })
    )
    await userEvent.click(screen.getByLabelText('A: Price by video resolution'))
    expect(
      screen.queryByRole('spinbutton', { name: 'A: Billing amount (USD)' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('spinbutton', { name: 'A: 480p Billing amount (USD)' })
    ).not.toBeInTheDocument()
    fireEvent.change(
      screen.getByRole('spinbutton', { name: 'A: 720p Billing amount (USD)' }),
      { target: { value: '0.2' } }
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: check and save' })
    )
    expect(
      screen.getByRole('spinbutton', { name: 'A: 1080p Billing amount (USD)' })
    ).toBeVisible()
    fireEvent.change(
      screen.getByRole('spinbutton', { name: 'A: 1080p Billing amount (USD)' }),
      { target: { value: '0.3' } }
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: check and save' })
    )
    expect(screen.getByText(/720p: 0.2 USD · 1080p: 0.3 USD/)).toBeVisible()
    expect(
      screen.queryByText(/other or unspecified resolutions:/)
    ).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Save and apply to this channel' })
    )
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    const saved = mocks.save.mock.calls[0][1] as Configuration
    expect(saved.bindings.A.text_video.billing?.expression).not.toContain(
      '480p'
    )
    expect(saved.bindings.A.text_video.billing?.expression).toContain(
      'tier("720p", 0.2 * u("seconds"))'
    )
    expect(saved.bindings.A.text_video.billing?.expression).toMatch(/ : nil$/)
    expect(saved.bindings.B.text_video.billing).toBeUndefined()
  })
  it('sets customer units and amounts, blocks incomplete edits and keeps bulk exceptions', async () => {
    baseline.bindings.C.text_video.billing = {
      expression: 'u("seconds") > 5 ? 12 : 5',
      currency: 'USD',
      confirmed: true,
    }
    mount()
    await advanceToParameters()
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: model prices' })
    )
    await userEvent.click(
      screen.getByRole('combobox', { name: 'A: Billing method' })
    )
    await userEvent.click(
      await screen.findByRole('option', { name: 'Per second' })
    )
    const amount = screen.getByRole('spinbutton', {
      name: 'A: Billing amount (USD)',
    })
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: check and save' })
    )
    expect(
      screen.getByRole('heading', {
        name: 'Set customer billing method and unit price',
      })
    ).toBeVisible()
    fireEvent.change(amount, { target: { value: '0.2' } })
    await userEvent.click(
      screen.getByRole('combobox', { name: 'A: Billing method' })
    )
    await userEvent.click(
      await screen.findByRole('option', { name: 'Per request' })
    )
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Default billing method' })
    )
    await userEvent.click(
      await screen.findByRole('option', { name: 'Per second' })
    )
    fireEvent.change(
      screen.getByRole('spinbutton', { name: 'Default billing amount (USD)' }),
      { target: { value: '0.5' } }
    )
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Fill only models without individual pricing',
      })
    )
    expect(amount).toHaveValue(0.2)
    expect(
      screen.getByRole('spinbutton', { name: 'B: Billing amount (USD)' })
    ).toHaveValue(0.5)
    expect(screen.getByText('Advanced pricing preserved')).toBeVisible()
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: check and save' })
    )
    expect(screen.getByText(/计费方法：按次；计费金额：0.2 USD/)).toBeVisible()
    await userEvent.click(
      screen.getByRole('button', { name: 'Save and apply to this channel' })
    )
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    const saved = mocks.save.mock.calls[0][1]
    expect(saved.bindings.A.text_video.billing.expression).toBe(
      '0.2 * u("request_count")'
    )
    expect(saved.bindings.B.text_video.billing.expression).toBe(
      '0.5 * u("seconds")'
    )
    expect(saved.bindings.C.text_video.billing.expression).toBe(
      'u("seconds") > 5 ? 12 : 5'
    )
    expect(saved.groups.original.modes.text_video.cost).toEqual(
      baseline.groups.original.modes.text_video.cost
    )
  })
  it('shows a recoverable load error and retries the same channel', async () => {
    mocks.get.mockRejectedValueOnce(new Error('fixture unavailable'))
    mount()
    await screen.findByText('fixture unavailable')
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('Select models to configure together')
    expect(
      screen.getByRole('button', { name: 'Next: output type and functions' })
    ).toBeEnabled()
  })
  it('uses the same allowed-value draft for input preview and save; repeated Save cannot publish twice', async () => {
    mount()
    await advanceToParameters()
    await userEvent.click(
      screen.getAllByRole('checkbox', { name: /resolution: 1080p/ })[0]
    )
    expect(
      screen.getAllByRole('checkbox', { name: /resolution: 720p/ })[0]
    ).toBeChecked()
    expect(
      screen.getAllByRole('checkbox', { name: /resolution: 1080p/ })[0]
    ).not.toBeChecked()
    await userEvent.click(
      screen.getByRole('button', { name: 'Check filled values' })
    )
    expect(mocks.check).toHaveBeenCalledTimes(1)
    const checked = mocks.check.mock.calls[0][1]
    const group = Object.values(checked.groups)[0] as {
      modes: Record<string, { parameters: Record<string, { enum: string[] }> }>
    }
    expect(group.modes.text_video.parameters.resolution.enum).toEqual(['720p'])
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: model prices' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: check and save' })
    )
    await userEvent.dblClick(
      screen.getByRole('button', { name: 'Save and apply to this channel' })
    )
    expect(mocks.save).toHaveBeenCalledTimes(1)
    expect(mocks.save.mock.calls[0][1]).toEqual(checked)
    expect(mocks.save.mock.calls[0][3]).toEqual([])
  })
  it.each([0, 1])(
    'outside clicks retain the draft until close button %s is pressed',
    async (closeButton) => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })
      function Harness() {
        const [open, setOpen] = useState(true)
        return (
          <QueryClientProvider client={client}>
            <button type='button' onClick={() => setOpen(true)}>
              Reopen fixture
            </button>
            <ModelConfigurationDialog
              channel={channel}
              open={open}
              onOpenChange={setOpen}
              preview
            />
          </QueryClientProvider>
        )
      }
      render(<Harness />)
      await screen.findByText('Select models to configure together')
      await userEvent.type(
        screen.getByRole('textbox', { name: 'Search models...' }),
        'A'
      )
      const backdrop = document.querySelector(
        '[data-slot="dialog-overlay"]'
      ) as HTMLElement
      await userEvent.click(backdrop)
      expect(
        screen.getByRole('dialog', { name: 'Model and interface settings' })
      ).toBeVisible()
      expect(
        screen.getByRole('textbox', { name: 'Search models...' })
      ).toHaveValue('A')
      await userEvent.click(
        screen.getAllByRole('button', { name: /^Close$/ })[closeButton]
      )
      await waitFor(() =>
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      )
      await userEvent.click(
        screen.getByRole('button', { name: 'Reopen fixture' })
      )
      await screen.findByText('Select models to configure together')
      expect(
        screen.getByRole('textbox', { name: 'Search models...' })
      ).toHaveValue('')
      expect(mocks.save).not.toHaveBeenCalled()
    }
  )
  it('saves reference-image-only support with text-to-video deselected', async () => {
    mount('B,C,old', false)
    await screen.findByText('Select models to configure together')
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: output type and functions' })
    )
    const image = screen.getByRole('checkbox', {
      name: /^Use a reference image/,
    })
    const text = screen.getByRole('checkbox', { name: /^Text to video/ })
    await userEvent.click(image)
    expect(text).not.toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(text)
    expect(text).not.toBeChecked()
    expect(image).toBeChecked()
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: documented parameters' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: model prices' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: check and save' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Save and apply to this channel' })
    )
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    const saved = mocks.save.mock.calls[0][1] as Configuration
    expect(mocks.save.mock.calls[0][2]).toEqual(['A'])
    expect(saved.bindings.A.text_video.enabled).toBe(false)
    expect(saved.bindings.A.image_video.enabled).toBe(true)
    expect(saved.bindings.B).toEqual(baseline.bindings.B)
    expect(saved.bindings.C).toEqual(baseline.bindings.C)
  })
  it('allows cancelling text video while reference video remains selected', async () => {
    mount()
    await screen.findByRole('button', {
      name: 'Next: output type and functions',
    })
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: output type and functions' })
    )
    await userEvent.click(
      screen.getByRole('checkbox', { name: /^Use reference video/ })
    )
    const text = screen.getByRole('checkbox', { name: /^Text to video/ })
    await waitFor(() =>
      expect(
        screen.getByRole('checkbox', { name: /^Use reference video/ })
      ).toBeChecked()
    )
    expect(text).toBeChecked()
    expect(text).not.toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(text)
    expect(text).not.toBeChecked()
    expect(
      screen.getByRole('checkbox', { name: /^Use reference video/ })
    ).toBeChecked()
  })
  it('allows every video capability checkbox to be selected alone and then cancelled', async () => {
    const initial = createSharedGroup(baseline, catalog, ['A'], 'single')
    for (const mode of Object.values(initial.groups.single.modes)) {
      mode.enabled = false
    }
    for (const binding of Object.values(initial.bindings.A)) {
      binding.enabled = false
    }
    function Harness() {
      const [draft, setDraft] = useState(initial)
      return (
        <FunctionChoice
          draft={draft}
          catalog={catalog}
          selected={['A']}
          groupId='single'
          kind='video'
          onKind={vi.fn()}
          onChange={setDraft}
        />
      )
    }
    render(<Harness />)
    const names = [
      'Text to video',
      'First-frame reference',
      'Use first and last frames',
      'Use a reference image',
      'Use reference video',
      'Use reference audio',
    ]
    for (const name of names) {
      const selected = screen.getByRole('checkbox', {
        name: new RegExp(`^${name}`),
      })
      await userEvent.click(selected)
      for (const candidate of names) {
        const checkbox = screen.getByRole('checkbox', {
          name: new RegExp(`^${candidate}`),
        })
        if (candidate === name) expect(checkbox).toBeChecked()
        else expect(checkbox).not.toBeChecked()
        expect(checkbox).not.toHaveAttribute('aria-disabled', 'true')
      }
      await userEvent.click(selected)
      expect(selected).not.toBeChecked()
    }
  })
  it('opens individual settings in a separate dialog and cancels without changing the outer draft', async () => {
    mount('old')
    await advanceToParameters()
    await userEvent.click(
      screen.getByRole('button', { name: 'A: Individual settings' })
    )
    let modal = screen.getByRole('dialog', {
      name: 'Individual model settings',
    })
    const prompt = within(modal).getByRole('textbox', { name: /Prompt/ })
    await userEvent.type(prompt, 'cancelled prompt')
    await userEvent.click(within(modal).getByRole('button', { name: 'Cancel' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'A: Individual settings' })
    )
    modal = screen.getByRole('dialog', { name: 'Individual model settings' })
    expect(within(modal).getByRole('textbox', { name: /Prompt/ })).toHaveValue(
      ''
    )
    await userEvent.type(
      within(modal).getByRole('textbox', { name: /Prompt/ }),
      'A only'
    )
    await userEvent.click(within(modal).getByRole('button', { name: 'JSON' }))
    const json = within(modal).getByRole('textbox', {
      name: 'Individual overrides JSON',
    })
    expect(JSON.parse((json as HTMLTextAreaElement).value).input).toEqual({
      prompt: 'A only',
    })
    fireEvent.change(json, { target: { value: '{' } })
    await userEvent.click(
      within(modal).getByRole('button', { name: 'Apply individual settings' })
    )
    expect(within(modal).getByRole('alert')).toBeInTheDocument()
    expect(mocks.save).not.toHaveBeenCalled()
    fireEvent.change(json, {
      target: {
        value: JSON.stringify({
          input: { prompt: 'A only' },
          parameters: {},
          mapping: {},
        }),
      },
    })
    await userEvent.click(
      within(modal).getByRole('button', { name: 'Parameter list' })
    )
    expect(within(modal).getByRole('textbox', { name: /Prompt/ })).toHaveValue(
      'A only'
    )
    await userEvent.click(
      within(modal).getByRole('button', { name: 'Apply individual settings' })
    )
    expect(
      screen.queryByRole('dialog', { name: 'Individual model settings' })
    ).not.toBeInTheDocument()
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('excludes explicitly removed models from affected names and individual settings, and restores kept models', async () => {
    baseline.bindings.old = structuredClone(baseline.bindings.A)
    mount(channel.models)
    await userEvent.click(
      await screen.findByRole('tab', { name: 'Removed (1)' })
    )
    const keep = screen.getByRole('checkbox', { name: /Keep model: old/ })
    const scope = screen.getByRole('complementary', {
      name: 'Actual affected models',
    })
    expect(
      within(scope).queryByRole('button', { name: 'old: Individual settings' })
    ).not.toBeInTheDocument()
    await userEvent.click(keep)
    expect(
      within(scope).queryByRole('button', { name: 'old: Individual settings' })
    ).not.toBeInTheDocument()
    expect(within(scope).getByRole('heading')).toHaveTextContent('Selected · 0')
    expect(within(scope).queryByText(/^old$/)).not.toBeInTheDocument()
    await userEvent.click(keep)
    expect(
      within(scope).queryByRole('button', { name: 'old: Individual settings' })
    ).not.toBeInTheDocument()
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('opens the current capability with newly applied shared parameters and keeps individual edits isolated', async () => {
    baseline.groups.original.modes.audio_ref.enabled = true
    mount('old')
    await advanceToParameters()
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Input capability' })
    )
    await userEvent.click(
      await screen.findByRole('option', { name: 'Use reference audio' })
    )
    const sharedJSON = screen.getByRole('textbox', {
      name: 'Shared request parameter JSON',
    })
    fireEvent.change(sharedJSON, {
      target: {
        value: JSON.stringify({
          prompt: 'shared audio prompt',
          unified_extra: 'shared new parameter',
        }),
      },
    })
    await userEvent.click(
      screen.getByRole('button', { name: 'Check and apply JSON' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'A: Individual settings' })
    )
    let modal = screen.getByRole('dialog', {
      name: 'Individual model settings',
    })
    expect(
      within(modal).getByRole('combobox', { name: 'Input capability' })
    ).toHaveTextContent('Use reference audio')
    expect(within(modal).getByRole('textbox', { name: /Prompt/ })).toHaveValue(
      'shared audio prompt'
    )
    expect(
      within(modal).getByRole('textbox', { name: /unified_extra/ })
    ).toHaveValue('shared new parameter')
    fireEvent.change(
      within(modal).getByRole('textbox', { name: /unified_extra/ }),
      { target: { value: 'A only' } }
    )
    await userEvent.click(
      within(modal).getByRole('button', { name: 'Apply individual settings' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'B: Individual settings' })
    )
    modal = screen.getByRole('dialog', { name: 'Individual model settings' })
    expect(
      within(modal).getByRole('textbox', { name: /unified_extra/ })
    ).toHaveValue('shared new parameter')
    await userEvent.click(within(modal).getByRole('button', { name: 'Cancel' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'A: Individual settings' })
    )
    modal = screen.getByRole('dialog', { name: 'Individual model settings' })
    expect(
      within(modal).getByRole('textbox', { name: /unified_extra/ })
    ).toHaveValue('A only')
    expect(within(modal).getByRole('textbox', { name: /Prompt/ })).toHaveValue(
      'shared audio prompt'
    )
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('rejects invalid test JSON and preserves each model sample when switching', async () => {
    mount('old')
    await advanceToParameters()
    const sample = screen.getByRole('textbox', { name: '测试请求 JSON' })
    expect(JSON.parse((sample as HTMLTextAreaElement).value).model).toBe('A')
    fireEvent.change(sample, { target: { value: '{' } })
    expect(
      screen.getByRole('button', { name: 'Check filled values' })
    ).toBeDisabled()
    expect(mocks.check).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'B' }))
    expect(
      JSON.parse(
        (
          screen.getByRole('textbox', {
            name: '测试请求 JSON',
          }) as HTMLTextAreaElement
        ).value
      ).model
    ).toBe('B')
    await userEvent.click(screen.getByRole('button', { name: 'A' }))
    expect(screen.getByRole('textbox', { name: '测试请求 JSON' })).toHaveValue(
      '{'
    )
  })
  it('shows editable per-model reference-video limits when the real two Seedance schemas differ, and switches them with capability', async () => {
    const actual = publicCatalog as unknown as Catalog
    const names = Object.values(actual.models)
      .filter((model) => model.kind === 'video' && model.modes.mixed_ref)
      .slice(0, 2)
      .map((model) => model.id)
    const doc = createSharedGroup(
      {
        format: 'channel-model-configuration/v1',
        provider: actual.key,
        revision: 1,
        groups: {},
        bindings: {},
      },
      actual,
      names,
      'real-schema'
    )
    expect(
      doc.groups['real-schema'].modes.video_ref.parameters?.videos
    ).toBeUndefined()
    mocks.get.mockResolvedValueOnce({
      pluginVersion: '2.0.1',
      configuration: doc,
      catalog: actual,
      versions: [],
    })
    mount()
    await screen.findByRole('button', {
      name: 'Next: output type and functions',
    })
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: output type and functions' })
    )
    await userEvent.click(
      screen.getByRole('checkbox', { name: /^Use reference video/ })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Next: documented parameters' })
    )
    const union = screen.getByTestId('selected-capability-parameters')
    expect(
      within(union).getAllByRole('spinbutton', { name: /Reference videos/ })
    ).toHaveLength(2)
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Input capability' })
    )
    await userEvent.click(
      screen.getByRole('option', { name: 'Use reference video' })
    )
    const editor = screen.getByTestId('shared-parameter-fields')
    const limits = within(editor).getAllByRole('spinbutton', {
      name: /Reference videos/,
    })
    expect(
      limits.map((input) => Number((input as HTMLInputElement).value))
    ).toEqual([3, 10])
    fireEvent.change(limits[0], { target: { value: '2' } })
    expect(
      within(editor)
        .getAllByRole('spinbutton', { name: /Reference videos/ })
        .map((input) => Number((input as HTMLInputElement).value))
    ).toEqual([2, 10])
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Input capability' })
    )
    await userEvent.click(screen.getByRole('option', { name: 'Text to video' }))
    expect(
      within(editor).queryByRole('spinbutton', { name: /Reference videos/ })
    ).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Input capability' })
    )
    await userEvent.click(
      screen.getByRole('option', { name: 'Use reference video' })
    )
    expect(
      within(editor)
        .getAllByRole('spinbutton', { name: /Reference videos/ })
        .map((input) => Number((input as HTMLInputElement).value))
    ).toEqual([2, 10])
    const advanced = screen
      .getByText('高级：原始配置与技术差异')
      .closest('details')
    expect(advanced).not.toHaveAttribute('open')
    expect(advanced?.querySelector('pre')).not.toBeVisible()
    expect(screen.getAllByText('参考视频').length).toBeGreaterThan(0)
  })
})
