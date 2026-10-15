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
import {
  createServerError,
  getServerErrorMessage,
  getServerErrorSources,
} from '@/lib/server-error-message'

import type { FetchModelsResponse, UpstreamModelDiscovery } from '../types'

export function normalizeModelDiscoveryResponse(
  response: FetchModelsResponse,
  requiresEvidence: boolean
): FetchModelsResponse {
  if (!response.success) {
    throw createServerError(response, 'Failed to fetch models')
  }
  // Native channels historically treat an omitted successful list as empty.
  if (!requiresEvidence && response.data === undefined && !response.discovery) {
    return { ...response, data: [] }
  }
  if (
    !Array.isArray(response.data) ||
    (requiresEvidence && response.discovery?.source !== 'upstream') ||
    (response.discovery && !Array.isArray(response.discovery.models))
  ) {
    throw new Error(
      'Verified upstream model discovery is unavailable; configure models manually'
    )
  }
  return response
}

export function discoverySelectableModels(
  models: string[],
  existingModels: string[],
  discovery?: UpstreamModelDiscovery
): string[] {
  if (!discovery) return models
  const allowed = new Set(existingModels)
  for (const model of discovery.models) if (model.adapted) allowed.add(model.id)
  return models.filter((model) => allowed.has(model))
}

export function modelDiscoveryErrorMessage(
  error: unknown,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const translate = (message: string): string => {
    const status = /^Upstream model discovery returned HTTP (\d{3})$/.exec(
      message
    )
    if (status) {
      return t('Upstream model discovery returned HTTP {{status}}', {
        status: status[1],
      })
    }
    return t(message, { skipInterpolation: true })
  }
  for (const source of getServerErrorSources(error)) {
    const params = source.message_params
    if (
      source.message_key === 'Failed to fetch models: {{error}}' &&
      params &&
      typeof params === 'object' &&
      'error' in params &&
      typeof params.error === 'string'
    ) {
      return t('Failed to fetch models: {{error}}', {
        error: translate(params.error),
      })
    }
  }
  return translate(getServerErrorMessage(error, t('Failed to fetch models')))
}
