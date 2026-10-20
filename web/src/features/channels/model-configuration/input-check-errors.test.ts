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
import i18next from 'i18next'
import { describe, expect, test } from 'vitest'

import zh from '@/i18n/locales/zh.json'
import { requireServerSuccess } from '@/lib/server-error-message'

describe('offline input error messages', () => {
  test('reports the actual model and field in Chinese from the server envelope', async () => {
    const previous = i18next.language
    i18next.addResourceBundle('zhCN', 'translation', zh.translation, true, true)
    await i18next.changeLanguage('zhCN')
    try {
      expect(() =>
        requireServerSuccess({
          success: false,
          message_key:
            'Model {{model}} / field protocol: confirm protocol applicability before saving a manual binding',
          message_params: { model: 'unconfirmed-model' },
        })
      ).toThrow(
        '型号 unconfirmed-model / 字段 protocol（文档接口）：保存前请确认所选接口适用于此型号'
      )
      const key =
        'Model {{model}} / field {{field}}: the value does not match the configured type, choices or range'
      expect(() =>
        requireServerSuccess({
          success: false,
          message_key: key,
          message_params: { model: 'sd2.5-9-2-480p', field: 'seconds' },
        })
      ).toThrow(
        '型号 sd2.5-9-2-480p / 字段 seconds：值不符合当前配置的类型、候选值或范围'
      )
      expect(() =>
        requireServerSuccess({
          success: false,
          message_key:
            'Model {{model}} / field {{field}}: the selected document interface does not declare this field; remove it or explicitly ignore it',
          message_params: { model: 'actual-model', field: 'resolution' },
        })
      ).toThrow(
        '型号 actual-model / 字段 resolution：所选文档接口没有此字段，请移除或明确忽略'
      )
    } finally {
      await i18next.changeLanguage(previous)
    }
  })
})
