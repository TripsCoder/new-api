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
import { describe, expect, test } from 'vitest'

import {
  discoverySelectableModels,
  modelDiscoveryErrorMessage,
  normalizeModelDiscoveryResponse,
} from '../model-discovery'

describe('task plugin upstream model discovery', () => {
  test('a static catalog without upstream evidence is rejected for task plugins', () => {
    expect(() =>
      normalizeModelDiscoveryResponse({ success: true, data: ['known'] }, true)
    ).toThrow()
  })

  test('a genuine empty upstream response stays empty', () => {
    const result = normalizeModelDiscoveryResponse(
      {
        success: true,
        data: [],
        discovery: {
          source: 'upstream',
          checked_at: 1,
          plugin_key: 'media',
          source_url: 'https://example.com/docs',
          source_sha256: 'a'.repeat(64),
          models: [],
        },
      },
      true
    )
    expect(result.data).toEqual([])
  })

  test('unadapted new models are blocked while existing choices are preserved', () => {
    const discovery = {
      source: 'upstream' as const,
      checked_at: 1,
      plugin_key: 'media',
      source_url: 'https://example.com/docs',
      source_sha256: 'a'.repeat(64),
      models: [
        {
          id: 'adapted',
          adapted: true,
          configured: false,
          pricing_status: 'not_checked' as const,
        },
        {
          id: 'unknown',
          adapted: false,
          configured: false,
          pricing_status: 'not_checked' as const,
        },
        {
          id: 'existing',
          adapted: false,
          configured: true,
          pricing_status: 'not_checked' as const,
        },
      ],
    }
    expect(
      discoverySelectableModels(
        ['adapted', 'unknown', 'existing', 'missing'],
        ['existing'],
        discovery
      )
    ).toEqual(['adapted', 'existing'])
  })

  test('ordinary channels keep their existing discovery selection behavior', () => {
    expect(
      normalizeModelDiscoveryResponse({ success: true }, false).data
    ).toEqual([])
    expect(
      normalizeModelDiscoveryResponse(
        { success: true, data: ['ordinary'] },
        false
      ).data
    ).toEqual(['ordinary'])
    expect(discoverySelectableModels(['ordinary'], [])).toEqual(['ordinary'])
  })

  test('nested backend errors preserve and translate the HTTP reason', () => {
    const t = (key: string, values?: Record<string, unknown>): string => {
      if (key === 'Upstream model discovery returned HTTP {{status}}') {
        return `上游返回 HTTP ${values?.status}`
      }
      if (key === 'Failed to fetch models: {{error}}') {
        return `获取失败：${values?.error}`
      }
      return key
    }
    expect(
      modelDiscoveryErrorMessage(
        {
          message_key: 'Failed to fetch models: {{error}}',
          message_params: {
            error: 'Upstream model discovery returned HTTP 401',
          },
        },
        t
      )
    ).toBe('获取失败：上游返回 HTTP 401')
  })
})
