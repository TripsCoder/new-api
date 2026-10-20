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
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table'

import {
  parameterKeys,
  relevantParameter,
  requiredParameter,
  DURATION_ALIASES,
} from './configuration'
import type { Mode } from './types'

const LABELS: Record<string, string> = {
  prompt: '提示词',
  n: '生成数量',
  images: '参考图片',
  videos: '参考视频',
  audios: '参考音频',
  aspect_ratio: '画面比例',
  resolution: '分辨率',
  seconds: '时长',
  duration: '时长',
  duration_seconds: '时长',
  seed: '随机种子',
  quality: '质量',
}
export function MappingPreview(props: {
  mode: Mode
  capability?: string
  documentedNames?: Record<string, string>
  onChange: (next: Mode) => void
}) {
  const { t } = useTranslation()
  // Mapping-only policies from older generic initialization remain stored,
  // but do not establish that a parameter belongs to the selected protocol.
  const names = parameterKeys({ ...props.mode, mapping: {} }).filter(
    (key) =>
      !props.capability ||
      relevantParameter(key, props.capability, props.mode.parameters?.[key]) ||
      requiredParameter(props.mode, key)
  )
  function target(key: string) {
    return (
      props.mode.mapping?.[key] ??
      (props.mode.parameters?.[key] ? key : '@reject')
    )
  }
  function change(key: string, value: string) {
    props.onChange({
      ...props.mode,
      mapping: {
        ...props.mode.mapping,
        ...Object.fromEntries(
          (DURATION_ALIASES.includes(key) ? DURATION_ALIASES : [key]).map(
            (name) => [name, value]
          )
        ),
      },
    })
  }
  function policy(value: string) {
    if (value === '@reject') return 'reject'
    if (value === '@ignore') return 'ignore'
    return 'send'
  }
  return (
    <section className='space-y-3'>
      <h4 className='font-medium'>参数如何传给上游</h4>
      <p className='text-muted-foreground text-sm'>
        仅发送已映射且受支持的字段；没有填写的字段保持省略，明确设置的默认值除外。下方请求测试会执行实际离线转换。
      </p>
      <div className='max-h-80 overflow-auto'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>参数</TableHead>
              <TableHead>{t('Document field or handling policy')}</TableHead>
              <TableHead>未填写时</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {names.map((key) => {
              const mapped = target(key)
              let destination =
                props.documentedNames?.[key] ??
                t('Document field not confirmed')
              let omitted = '省略，不自动补值'
              if (mapped === '@reject') destination = '传入时拒绝'
              else if (mapped === '@ignore') destination = '明确忽略'
              else if (
                props.mode.input[key] !== undefined ||
                props.mode.parameters?.[key]?.default !== undefined
              ) {
                omitted = `使用明确默认值：${JSON.stringify(props.mode.input[key] ?? props.mode.parameters?.[key]?.default)}`
              }
              return (
                <TableRow key={key}>
                  <TableCell>
                    {t(LABELS[key] ?? key)}
                    <code className='text-muted-foreground ml-2 text-xs'>
                      {props.documentedNames?.[key] ?? key}
                    </code>
                  </TableCell>
                  <TableCell>{destination}</TableCell>
                  <TableCell className='max-w-64 whitespace-normal'>
                    {omitted}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      <details className='space-y-3'>
        <summary className='cursor-pointer font-medium'>
          {t('Advanced: plugin input mapping and handling policies')}
        </summary>
        <p className='text-muted-foreground text-sm'>
          {t(
            'These mappings connect client fields to plugin inputs. The installed protocol converts them to vendor fields.'
          )}
        </p>
        {names.map((key) => {
          const mapped = target(key)
          const action = policy(mapped)
          if (
            (
              props.mode.parameters?.[key]?.definition?.[
                'x-channel-parameter'
              ] as Record<string, unknown> | undefined
            )?.workflowManaged === true ||
            requiredParameter(props.mode, key) ||
            key === 'model' ||
            key === 'client_request_id'
          ) {
            return (
              <div key={key} className='grid grid-cols-3 gap-3 text-sm'>
                <span>
                  {t(LABELS[key] ?? key)}{' '}
                  <code>{props.documentedNames?.[key] ?? key}</code>
                </span>
                <span>
                  {t('Plugin input field (internal)')}: <code>{mapped}</code>
                </span>
                <span>
                  {t(
                    'Required by the document; inherited automatically and supplied by the caller at runtime'
                  )}
                </span>
              </div>
            )
          }
          return (
            <div key={key} className='grid grid-cols-3 items-center gap-3'>
              <span>
                {t(LABELS[key] ?? key)}{' '}
                <code className='text-xs'>
                  {props.documentedNames?.[key] ?? key}
                </code>
              </span>
              <Select
                value={action}
                onValueChange={(value) => {
                  if (value === 'send') change(key, key)
                  else change(key, value === 'ignore' ? '@ignore' : '@reject')
                }}
              >
                <SelectTrigger aria-label={`处理方式: ${key}`}>
                  <SelectValue>
                    {
                      {
                        send: '发送给上游',
                        ignore: '明确忽略',
                        reject: '传入时报错',
                      }[action]
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value='send'>发送给上游</SelectItem>
                    <SelectItem value='ignore'>明确忽略</SelectItem>
                    <SelectItem value='reject'>传入时报错</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              {action === 'send' ? (
                <label className='space-y-1 text-xs'>
                  <span className='text-muted-foreground'>
                    {t('Plugin input field (internal)')}
                  </span>
                  <Input
                    aria-label={`${t('Plugin input field (internal)')}: ${key}`}
                    value={mapped}
                    onChange={(event) => {
                      const value = event.target.value
                      if (!value.startsWith('@')) change(key, value)
                    }}
                  />
                </label>
              ) : (
                <span className='text-muted-foreground text-xs'>
                  明确保存此处理策略
                </span>
              )}
            </div>
          )
        })}
      </details>
    </section>
  )
}
