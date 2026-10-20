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
import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'

import type { CheckResult, Configuration, ConfigurationResponse } from './types'

export async function getModelConfiguration(
  channelId: number
): Promise<ConfigurationResponse> {
  const response = await api.get<{
    success: boolean
    data: ConfigurationResponse
  }>(`/api/channel/${channelId}/model-configuration`)
  return requireServerSuccess(response.data).data
}
export async function saveModelConfiguration(
  channelId: number,
  configuration: Configuration,
  addModels: string[],
  removeModels: string[] = [],
  expectedModels = ''
): Promise<Configuration> {
  const response = await api.put<{ success: boolean; data: Configuration }>(
    `/api/channel/${channelId}/model-configuration`,
    {
      configuration,
      expectedRevision: configuration.revision,
      addModels,
      removeModels,
      expectedModels,
    }
  )
  return requireServerSuccess(response.data).data
}
export async function restoreModelConfiguration(
  channelId: number,
  revision: number,
  expectedRevision: number
): Promise<Configuration> {
  const response = await api.post<{ success: boolean; data: Configuration }>(
    `/api/channel/${channelId}/model-configuration/restore`,
    { revision, expectedRevision }
  )
  return requireServerSuccess(response.data).data
}
export async function checkModelConfiguration(
  channelId: number,
  configuration: Configuration,
  model: string,
  mode: string,
  input: Record<string, unknown>
): Promise<CheckResult> {
  const response = await api.post<{ success: boolean; data: CheckResult }>(
    `/api/channel/${channelId}/model-configuration/check`,
    { configuration, model, mode, input, capabilities: true }
  )
  return requireServerSuccess(response.data).data
}

export type RealCallResult = {
  kind?: 'real_call'
  actualCall?: true
  taskId: string
  status: string
  progress?: string
  estimatedUSD?: number
  providerCost?: {
    currency: string
    estimate: number | null
    actual: number | null
    status: string
  }
}
export async function tryModelConfiguration(
  channelId: number,
  revision: number,
  model: string,
  mode: string,
  input: Record<string, unknown>,
  maxEstimatedUSD: number,
  acceptUnknownProviderCost: boolean
): Promise<RealCallResult> {
  const response = await api.post<{ success: boolean; data: RealCallResult }>(
    `/api/channel/${channelId}/model-configuration/try`,
    {
      revision,
      model,
      mode,
      input,
      budget: {
        maxEstimatedUSD,
        acceptCharge: true,
        acceptUnknownProviderCost,
      },
    },
    {
      // Refresh before this potentially billable operation, never replay it
      // after a supplier's 401 or clear the signed-in user's session for it.
      singleUseAuthorization: true,
      skipErrorHandler: true,
    }
  )
  return requireServerSuccess(response.data).data
}
export async function getRealConfigurationTask(
  channelId: number,
  taskId: string
): Promise<RealCallResult> {
  const response = await api.get<{ success: boolean; data: RealCallResult }>(
    `/api/channel/${channelId}/model-configuration/try/${encodeURIComponent(taskId)}`
  )
  return requireServerSuccess(response.data).data
}
export async function getRealConfigurationArtifacts(
  taskId: string
): Promise<{ key: string; type: string; content_url: string }[]> {
  const response = await api.get<{
    success: boolean
    data: { artifacts: { key: string; type: string; content_url: string }[] }
  }>(`/api/task/${encodeURIComponent(taskId)}/artifacts`)
  return requireServerSuccess(response.data).data.artifacts
}

export type ProviderAvailability = {
  provider: string
  sourceURL?: string
  fetchedAt: number
  updatedAt: number
  status: string
  models: Record<string, string>
}
export async function getConfigurationAvailability(
  channelId: number
): Promise<ProviderAvailability> {
  const response = await api.get<{
    success: boolean
    data: ProviderAvailability
  }>(`/api/channel/${channelId}/model-configuration/availability`)
  return requireServerSuccess(response.data).data
}
