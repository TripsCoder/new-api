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
export type Source = {
  url: string
  sha256?: string
  readAt?: string
  scope?: string
  status?: string
}
export type Parameter = {
  type?: string
  required?: boolean
  default?: unknown
  enum?: unknown[]
  minimum?: number
  maximum?: number
  description?: string
  definition?: Record<string, unknown>
  source?: Source
}
export type Cost = {
  amount: number | null
  unit?: string
  currency?: string
  confirmed: boolean
  expression?: string
  source?: Source
}
export type Billing = {
  expression: string
  currency: 'USD'
  confirmed: boolean
}
export type InputCapabilities = {
  images: boolean
  videos: boolean
  audios: boolean
  firstFrame?: boolean
  lastFrame?: boolean
}
export type Mode = {
  strictMapping?: boolean
  capabilities?: InputCapabilities
  protocol?: ProtocolBinding
  billing?: Billing
  enabled: boolean
  input: Record<string, unknown>
  parameters?: Record<string, Parameter>
  mapping?: Record<string, string>
  cost: Cost
  source?: Source
}
export type Group = { name: string; modes: Record<string, Mode> }
export type Binding = {
  capabilities?: InputCapabilities
  pricing?: import('./simple-pricing').PricingRule
  protocol?: ProtocolBinding
  billing?: Billing
  groupId: string
  parameters?: Record<string, Parameter>
  cost?: Cost
  enabled?: boolean
  input?: Record<string, unknown>
  mapping?: Record<string, string>
}
export type CapabilitySupplement = {
  note: string
  fields: Record<
    string,
    { vendor: string; shape: 'url' | 'urls' | 'objects'; maxItems: number }
  >
}
export type ProtocolBinding = {
  templateModel: string
  confirmed: boolean
  supplement?: Record<string, CapabilitySupplement>
}
export type Configuration = {
  format: 'channel-model-configuration/v1'
  revision: number
  provider: string
  groups: Record<string, Group>
  bindings: Record<string, Record<string, Binding>>
  sources?: Source[]
}
export type DocumentReference = {
  id: string
  title: string
  method: string
  path: string
  schema: Record<string, unknown>
  description: string
  source: Source
  components?: Record<string, unknown>
}
export type CatalogModel = {
  modelRules?: Record<string, Partial<CatalogModel>>
  interfaceId?: string
  title?: string
  path?: string
  documentedParameters?: Record<string, Record<string, unknown>>
  billingUnit?: string
  capabilities?: {
    firstFrame: boolean
    lastFrame: boolean
    multipleReferences: boolean
  }
  id: string
  kind: string
  status: string
  parameters: Record<string, Record<string, unknown>>
  mapping?: Record<string, string>
  modes: Record<string, { required: string[] }>
  source: Source
  warnings?: string[]
  liveStatus?: string
  priceConfirmed?: boolean
  priceEvidence?: Record<string, unknown>
}
export type Catalog = {
  interfaces?: Record<string, CatalogModel>
  key: string
  name: string
  baseURL: string
  docsURL: string
  marketURL?: string
  models: Record<string, CatalogModel>
  documents: DocumentReference[]
  warnings: string[]
}
export type ConfigurationVersion = {
  channelId: number
  revision: number
  createdAt: number
  actorId: number
}
export type ConfigurationResponse = {
  channelModels?: string
  pluginVersion?: string
  configuration: Configuration
  versions: ConfigurationVersion[]
  catalog: Catalog
}
export type CheckResult = {
  resolvedInput?: Record<string, unknown>
  defaultsAdded?: Record<string, unknown>
  ignoredFields?: string[]
  actualMode?: string
  kind: 'input_check'
  actualCall: false
  message: string
  request: Record<string, unknown>
}
export const MODE_LABELS: Record<string, string> = {
  text_image: 'Text to image',
  edit_image: 'Image to image',
  text_video: 'Text to video',
  image_video: 'Use a reference image',
  frames: 'Use first and last frames',
  video_ref: 'Use reference video',
  audio_ref: 'Use reference audio',
  mixed_ref: 'Combined supplied references',
  first_frame: 'First-frame reference',
  unadapted: 'Interface settings needed',
}
