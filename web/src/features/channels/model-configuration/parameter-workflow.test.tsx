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

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { createSharedGroup, modeFromDocument } from './configuration'
import { projectDocumentInterfaces } from './document-interfaces'
import { IndividualModelDialog } from './individual-model-dialog'
import { ParameterFields } from './parameter-fields'
import { applyParameterScope, selectedParameterMode } from './parameter-scope'
import { parameterConfigurationIssues } from './parameter-validation'
import type { Catalog, Configuration, Mode } from './types'
import { applyIndividualFields, effectiveMode } from './workflow'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (value: string) => value }),
}))
const source = { url: 'https://docs.example.test/video' }
const rule = (capabilities: string[], extra = {}) => ({
  type: 'string',
  definition: {
    'x-channel-parameter': {
      status: 'documented',
      capabilities,
      vendorFields: ['vendor_field'],
      requiredIn: [],
      schema: {},
    },
  },
  ...extra,
})
const catalog = {
  key: 'paisio_media',
  name: 'fixture',
  baseURL: '',
  docsURL: source.url,
  documents: [],
  warnings: [],
  models: Object.fromEntries(
    ['A', 'B'].map((id) => [
      id,
      {
        id,
        kind: 'video',
        status: 'documented',
        source,
        parameters: {
          prompt: rule(['base'], { required: true }),
          unusual_name: rule(['video_ref']),
          images: rule(['image_video']),
          resolution: rule(['base'], { enum: ['720p', '1080p'] }),
        },
        modes: {
          text_video: { required: [] },
          image_video: { required: [] },
          video_ref: { required: [] },
        },
      },
    ])
  ),
} as Catalog
function document(): Configuration {
  const result = createSharedGroup(
    {
      format: 'channel-model-configuration/v1',
      revision: 0,
      provider: catalog.key,
      groups: {},
      bindings: {},
    },
    catalog,
    ['A', 'B'],
    'g'
  )
  for (const value of Object.values(result.groups.g.modes)) value.enabled = true
  for (const modes of Object.values(result.bindings)) {
    for (const binding of Object.values(modes)) binding.enabled = true
  }
  return result
}

describe('document to parameter configuration workflow', () => {
  it('restores editable individual document rules with the actual model constraints', async () => {
    const providers = JSON.parse(
      readFileSync(path.resolve('../pkg/modelconfig/catalog.json'), 'utf8')
    ).providers as Record<string, Catalog>
    const model = 'seedance2.0-g2-o2'
    const projected = projectDocumentInterfaces(
      providers.xcmapi_media,
      [model],
      'video'
    ) as Catalog
    const draft = createSharedGroup(
      {
        format: 'channel-model-configuration/v1',
        revision: 0,
        provider: 'xcmapi_media',
        groups: {},
        bindings: {},
      },
      projected,
      [model],
      'actual'
    )
    const parameter = draft.groups.actual.modes.text_video.parameters?.seconds
    if (!parameter) {
      throw new Error('Missing documented duration field')
    }
    expect(parameter.required).toBe(false)
    expect(parameter.minimum).toBe(4)
    expect(parameter.maximum).toBe(15)
    parameter.minimum = 5
    parameter.maximum = 10
    let applied: Configuration | undefined
    render(
      <IndividualModelDialog
        model={model}
        document={draft}
        catalog={projected}
        initialModeKey='text_video'
        onCancel={vi.fn()}
        onApply={(next) => {
          applied = next
        }}
      />
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Restore document rules' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Apply individual settings' })
    )
    expect(applied).toBeDefined()
    if (!applied) {
      throw new Error('No applied individual draft')
    }
    expect(
      effectiveMode(applied, model, 'text_video')?.parameters?.seconds.minimum
    ).toBe(4)
    expect(
      effectiveMode(applied, model, 'text_video')?.parameters?.seconds.maximum
    ).toBe(15)
  })
  it('keeps different per-function defaults explicit in the union', () => {
    const value = document()
    value.bindings.A.text_video.input = { resolution: '720p' }
    value.bindings.A.image_video.input = { resolution: '1080p' }
    expect(
      selectedParameterMode(value, 'A', 'g', 'video').parameters?.resolution
        .definition?.['x-scope-conflict']
    ).toBe(true)
    expect(effectiveMode(value, 'A', 'text_video')?.input.resolution).toBe(
      '720p'
    )
  })
  it('edits documented duration candidates while retaining numeric and string request aliases', async () => {
    const mode: Mode = {
      enabled: true,
      cost: { amount: null, confirmed: false },
      input: {},
      mapping: { seconds: 'duration' },
      parameters: {
        seconds: {
          definition: {
            'x-channel-parameter': {
              status: 'documented',
              documentedEnum: ['5', '10'],
            },
            anyOf: [{ type: 'integer' }, { type: 'string' }],
          },
        },
      },
    }
    let changed: Mode | undefined
    render(
      <ParameterFields
        mode={mode}
        onChange={(next) => {
          changed = next
        }}
      />
    )
    await userEvent.click(
      screen.getByRole('checkbox', { name: /^seconds: 5(?: |$)/ })
    )
    expect(changed?.parameters?.seconds.enum).toEqual([10, '10'])
    expect(changed?.parameters?.seconds.definition).not.toHaveProperty('enum')
  })
  it('uses explicit document membership even when a field name does not reveal its function', () => {
    expect(
      modeFromDocument(catalog.models.A, 'text_video').parameters
    ).not.toHaveProperty('unusual_name')
    expect(
      modeFromDocument(catalog.models.A, 'video_ref').parameters
    ).toHaveProperty('unusual_name')
  })
  it('shows the union and removes only the disabled function fields', () => {
    const value = document()
    expect(
      selectedParameterMode(value, 'A', 'g', 'video').parameters
    ).toHaveProperty('images')
    expect(
      selectedParameterMode(value, 'A', 'g', 'video').parameters
    ).toHaveProperty('unusual_name')
    value.groups.g.modes.video_ref.enabled = false
    const fields = selectedParameterMode(value, 'A', 'g', 'video').parameters
    expect(fields).not.toHaveProperty('unusual_name')
    expect(fields).toHaveProperty('images')
    expect(fields).toHaveProperty('resolution')
  })
  it('updates common values while preserving independent model overrides', () => {
    let value = document()
    value.bindings.A.text_video.input = { resolution: '720p' }
    const before = selectedParameterMode(value, 'B', 'g', 'video')
    value = applyParameterScope(value, ['A', 'B'], 'g', 'video', before, {
      ...before,
      input: { resolution: '1080p' },
    })
    expect(effectiveMode(value, 'A', 'text_video')?.input.resolution).toBe(
      '720p'
    )
    expect(effectiveMode(value, 'B', 'text_video')?.input.resolution).toBe(
      '1080p'
    )
  })
  it('distinguishes excluding an optional inherited field from restoring inheritance', async () => {
    let result: Configuration | undefined
    render(
      <IndividualModelDialog
        model='A'
        document={document()}
        catalog={catalog}
        initialModeKey='all'
        onCancel={vi.fn()}
        onApply={(next) => {
          result = next
        }}
      />
    )
    await userEvent.click(
      screen.getByRole('checkbox', { name: /^Include parameter: resolution/ })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Apply individual settings' })
    )
    expect(result).toBeDefined()
    if (!result) throw new Error('Missing applied configuration')
    expect(effectiveMode(result, 'A', 'text_video')?.mapping?.resolution).toBe(
      '@ignore'
    )
    expect(effectiveMode(result, 'B', 'text_video')?.mapping?.resolution).toBe(
      'resolution'
    )
    const edited = effectiveMode(result, 'A', 'text_video') as Mode
    delete edited.mapping?.resolution
    const restored = applyIndividualFields(result, 'A', 'text_video', edited)
    expect(
      effectiveMode(restored, 'A', 'text_video')?.mapping?.resolution
    ).toBe('resolution')
  })
  it('checks documented candidates and required rules without demanding runtime prompt values at save', () => {
    const value = document()
    expect(parameterConfigurationIssues(value, catalog, ['A'])).toEqual([])
    value.bindings.A.text_video.parameters = {
      resolution: rule(['base'], { enum: ['4K'] }),
    }
    expect(parameterConfigurationIssues(value, catalog, ['A'])[0]).toContain(
      'Allowed values'
    )
    value.bindings.A.text_video.mapping = { prompt: '@ignore' }
    expect(
      parameterConfigurationIssues(value, catalog, ['A']).some((message) =>
        message.includes('Required')
      )
    ).toBe(true)
  })
  it('does not initialize real model bindings from document examples', () => {
    const root = path.resolve('..')
    const plan = JSON.parse(
      readFileSync(
        path.join(
          root,
          'plugin-sources/media-providers/six-v2/initial-configurations.json'
        ),
        'utf8'
      )
    ) as { configurations: Record<string, Configuration> }
    expect(Object.keys(plan.configurations)).toHaveLength(6)
    for (const document of Object.values(plan.configurations)) {
      expect(document.bindings).toEqual({})
      expect(document.groups).toEqual({})
    }
  })
})
