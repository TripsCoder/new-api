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
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { previewDocumentRefresh } from './document-refresh'
import { DocumentRefreshPanel } from './document-refresh-panel'
import type { Catalog, Configuration } from './types'
import { effectiveMode } from './workflow'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (value: string) => value }),
}))

function fixture() {
  const reference = {
    id: 'interface:test',
    kind: 'video',
    status: 'documented',
    source: { url: 'https://supplier.example/docs' },
    parameters: {
      resolution: {
        type: 'string',
        required: true,
        enum: ['480p', '720p'],
        definition: { type: 'string', enum: ['480p', '720p'] },
      },
      seconds: { type: 'integer', minimum: 4, maximum: 15 },
    },
    mapping: { resolution: 'resolution', seconds: 'seconds' },
    modes: { text_video: { required: [] }, frames: { required: [] } },
  }
  const catalog = {
    key: 'fenglang_video',
    models: {},
    interfaces: {
      'interface:test': {
        ...reference,
        modelRules: { A: reference, B: reference },
      },
    },
  } as unknown as Catalog
  const document: Configuration = {
    format: 'channel-model-configuration/v1',
    provider: 'fenglang_video',
    revision: 19,
    groups: { shared: { name: 'Existing shared group', modes: {} } },
    bindings: {},
  }
  for (const key of ['text_video', 'frames']) {
    document.groups.shared.modes[key] = {
      enabled: key === 'text_video',
      input:
        key === 'text_video'
          ? { resolution: '1080p', watermark: false, seed: 0 }
          : {},
      parameters: {
        resolution: { type: 'string', required: true, enum: ['1080p'] },
        seconds: { type: 'integer', minimum: 1, maximum: 30 },
      },
      mapping: { resolution: 'old_resolution', seconds: 'old_seconds' },
      cost: { amount: 0.3, currency: 'USD', confirmed: true },
      billing: {
        expression: '0.3*u("seconds")',
        currency: 'USD',
        confirmed: true,
      },
    }
    for (const name of ['A', 'B']) {
      document.bindings[name] ??= {}
      document.bindings[name][key] = {
        groupId: 'shared',
        protocol: { templateModel: 'interface:test', confirmed: false },
        pricing: { method: 'direct_price', value: 2 },
        capabilities: { images: true, videos: false, audios: false },
      }
    }
  }
  return { catalog, document }
}

describe('document parameter refresh', () => {
  it('explains missing specifications for a genuinely new variant instead of silently presenting generic fields', () => {
    const { catalog, document } = fixture()
    catalog.models.newVariant = {
      ...catalog.interfaces?.['interface:test'],
      id: 'newVariant',
      interfaceId: 'interface:test',
    } as Catalog['models'][string]
    render(
      <DocumentRefreshPanel
        document={document}
        catalog={catalog}
        models={['newVariant']}
        onChange={vi.fn()}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'model-specific specifications are not documented'
    )
    expect(
      screen.queryByRole('button', {
        name: 'Preview parameter refresh from documentation',
      })
    ).not.toBeInTheDocument()
  })
  it('previews all modes without mutating saved state or changing prices and other members', () => {
    const { catalog, document } = fixture()
    const snapshot = structuredClone(document)
    const result = previewDocumentRefresh(
      document,
      catalog,
      ['A'],
      () => 'isolated'
    )
    expect(document).toEqual(snapshot)
    expect(result.document.revision).toBe(19)
    expect(result.document.groups.shared).toEqual(document.groups.shared)
    expect(result.document.bindings.B).toEqual(document.bindings.B)
    for (const mode of ['text_video', 'frames']) {
      const before = effectiveMode(document, 'A', mode)
      const after = effectiveMode(result.document, 'A', mode)
      if (!before || !after) throw new Error('Missing fixture mode')
      expect(after.parameters?.resolution.enum).toEqual(['480p', '720p'])
      expect(after.parameters?.seconds.maximum).toBe(15)
      expect(after.mapping?.seconds).toBe('seconds')
      expect(after.input).toEqual({})
      for (const field of [
        'cost',
        'billing',
        'enabled',
        'protocol',
        'capabilities',
      ] as const) {
        expect(after[field]).toEqual(before[field])
      }
      expect(result.document.bindings.A[mode].pricing).toEqual(
        document.bindings.A[mode].pricing
      )
    }
    expect(result.changes).toContainEqual(
      expect.objectContaining({
        model: 'A',
        section: 'input',
        field: 'resolution',
        before: '1080p',
        after: undefined,
      })
    )
    expect(result.changes).toContainEqual(
      expect.objectContaining({
        section: 'input',
        field: 'watermark',
        before: false,
        after: undefined,
      })
    )
  })

  it('does not fabricate rules for unknown model variants or missing interfaces', () => {
    const { catalog, document } = fixture()
    const rules = catalog.interfaces?.['interface:test'].modelRules
    if (!rules) throw new Error('Missing fixture rules')
    delete rules.A
    const result = previewDocumentRefresh(document, catalog, ['A'])
    expect(result.changes).toEqual([])
    expect(result.document).toEqual(document)
    expect(result.skipped).toHaveLength(2)
  })

  it('never changes state until preview is explicitly applied and invalidates stale previews', async () => {
    const { catalog, document } = fixture()
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(
      <DocumentRefreshPanel
        document={document}
        catalog={catalog}
        models={['A']}
        onChange={onChange}
      />
    )
    expect(
      screen.getByText(/Fetching models updates the model list/)
    ).toBeInTheDocument()
    await user.click(
      screen.getByRole('button', {
        name: 'Preview parameter refresh from documentation',
      })
    )
    expect(onChange).not.toHaveBeenCalled()
    await user.click(
      screen.getByRole('button', { name: 'Keep saved parameters' })
    )
    expect(onChange).not.toHaveBeenCalled()
    await user.click(
      screen.getByRole('button', {
        name: 'Preview parameter refresh from documentation',
      })
    )
    rerender(
      <DocumentRefreshPanel
        document={structuredClone(document)}
        catalog={catalog}
        models={['A']}
        onChange={onChange}
      />
    )
    expect(
      screen.queryByRole('button', { name: 'Apply refresh to draft' })
    ).not.toBeInTheDocument()
    await user.click(
      screen.getByRole('button', {
        name: 'Preview parameter refresh from documentation',
      })
    )
    await user.click(
      screen.getByRole('button', { name: 'Apply refresh to draft' })
    )
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(
      effectiveMode(onChange.mock.calls[0][0], 'A', 'text_video')?.parameters
        ?.resolution.enum
    ).toEqual(['480p', '720p'])
  })
})
