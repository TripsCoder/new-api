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
import type { CheckResult } from './types'

const names: Record<string, string> = {
  prompt: '提示词',
  images: '参考图片',
  videos: '参考视频',
  audios: '参考音频',
  seconds: '时长',
  duration: '时长',
  resolution: '分辨率',
  aspect_ratio: '画面比例',
  model: '模型',
  content: '请求内容',
  parameters: '请求参数',
  materials: '参考素材',
  n: '数量',
}
function readable(keys: string[]) {
  return keys.map((key) => `${names[key] ?? key}（${key}）`).join('、') || '无'
}
export function RequestCheckSummary({ result }: { result: CheckResult }) {
  const body = result.request.body
  let fields: string[] = []
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    fields = Object.keys(body)
  } else if (typeof body === 'string') {
    try {
      fields = Object.keys(JSON.parse(body))
    } catch {
      fields = ['body']
    }
  }
  return (
    <div className='space-y-2 text-sm'>
      <p>上游请求已在本地实际转换，未发送生成请求。</p>
      <p>
        <strong>最终请求字段：</strong>
        {readable(fields)}
      </p>
      <p>
        <strong>补入的明确默认值：</strong>
        {readable(Object.keys(result.defaultsAdded ?? {}))}
      </p>
      <p>
        <strong>明确忽略：</strong>
        {readable(result.ignoredFields ?? [])}
      </p>
      <p>
        <strong>未映射字段：</strong>按配置拒绝传入；发生拒绝时会显示实际原因。
      </p>
    </div>
  )
}
