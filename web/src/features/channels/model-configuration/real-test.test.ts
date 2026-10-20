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

import { savedTestChoices, realTestExample } from './real-test'
import type { Configuration, Mode } from './types'

const mode = (enabled = true): Mode => ({
  enabled,
  input: {},
  cost: { amount: null, confirmed: false },
})
function fixture(): Configuration {
  return {
    format: 'channel-model-configuration/v1',
    provider: 'paisio_media',
    revision: 4,
    groups: {
      g: {
        name: 'shared',
        modes: {
          text_video: mode(),
          image_video: mode(),
          video_ref: mode(),
          frames: mode(false),
        },
      },
    },
    bindings: {
      A: {
        text_video: { groupId: 'g' },
        image_video: { groupId: 'g' },
        frames: { groupId: 'g' },
      },
      B: {
        text_video: { groupId: 'g', enabled: false },
        video_ref: { groupId: 'g' },
      },
      old: { text_video: { groupId: 'g' } },
    },
  }
}
describe('saved real-test scope', () => {
  it('uses only the saved batch and its effective enabled modes', () => {
    const saved = fixture()
    expect(savedTestChoices(saved, ['A', 'B', 'unsaved', 'A'])).toEqual([
      { model: 'A', modes: ['text_video', 'image_video'] },
      { model: 'B', modes: ['video_ref'] },
    ])
    expect(savedTestChoices({ ...saved, revision: 0 }, ['A'])).toEqual([])
    expect(savedTestChoices(saved, [])).toEqual([])
  })
  it('creates material examples for the chosen mode without carrying other modes', () => {
    expect(realTestExample('A', 'text_video')).not.toHaveProperty('images')
    expect(realTestExample('A', 'image_video')).toHaveProperty('images')
    expect(realTestExample('B', 'video_ref')).toHaveProperty('videos')
    expect(realTestExample('B', 'video_ref')).not.toHaveProperty('audios')
    expect(realTestExample('B', 'mixed_ref')).toHaveProperty('audios')
    expect(realTestExample('B', 'mixed_ref')).toHaveProperty('videos')
    expect(realTestExample('A', 'edit_image')).toHaveProperty('images')
  })
  it('uses explicit frame controls and respects the saved last-frame capability', () => {
    const example = realTestExample('A', 'frames', {
      ...mode(),
      capabilities: {
        images: false,
        videos: false,
        audios: false,
        firstFrame: true,
        lastFrame: false,
      },
    })
    expect(example).toHaveProperty('start_image_url')
    expect(example).not.toHaveProperty('end_image_url')
    expect(example).not.toHaveProperty('images')
  })
})
