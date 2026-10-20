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
import { describe, expect, it } from 'vitest'

import en from '@/i18n/locales/en.json'
import fr from '@/i18n/locales/fr.json'
import ja from '@/i18n/locales/ja.json'
import ru from '@/i18n/locales/ru.json'
import vi from '@/i18n/locales/vi.json'
import tw from '@/i18n/locales/zh-TW.json'
import zh from '@/i18n/locales/zh.json'

describe('configuration translation resources', () => {
  it('places configuration, billing and real-test labels in the i18next translation namespace for all seven locales', () => {
    for (const resource of [en, zh, tw, fr, ja, ru, vi]) {
      expect(Object.keys(resource)).toEqual(['translation'])
      for (const key of [
        'Model and interface settings',
        'Restore document rules',
        'Real generation test',
        'Charge my wallet for one real call on this channel',
        'Unknown',
        'Completed',
      ]) {
        expect(resource.translation).toHaveProperty(key)
      }
    }
    expect(zh.translation['Restore document rules']).toBe('恢复文档规则')
  })
})
