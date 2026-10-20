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
import type { Configuration, Mode } from './types'
import { effectiveMode, IMAGE_MODES, VIDEO_MODES } from './workflow'

// Candidates are the current batch intersected with the saved revision. Neither
// the global catalog nor unsaved capability edits can authorize a paid test.
export function savedTestChoices(
  document: Configuration | null,
  batch: string[]
): { model: string; modes: string[] }[] {
  if (!document || document.revision <= 0) return []
  return [...new Set(batch)].flatMap((model) => {
    const modes = [...IMAGE_MODES, ...VIDEO_MODES].filter(
      (mode) => effectiveMode(document, model, mode)?.enabled
    )
    return modes.length ? [{ model, modes }] : []
  })
}

export function realTestExample(
  model: string,
  mode: string,
  definition?: Mode
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    model,
    prompt: '请在这里填写测试提示词',
  }
  const base = 'https://replace-with-your-public-url.invalid/'
  if (mode === 'edit_image' || mode === 'image_video') {
    input.images = [`${base}reference.png`]
  }
  if (mode === 'frames') {
    if (definition?.capabilities?.firstFrame !== false) {
      input.start_image_url = `${base}first.png`
    }
    if (definition?.capabilities?.lastFrame !== false) {
      input.end_image_url = `${base}last.png`
    }
  }
  if (mode === 'video_ref' || mode === 'mixed_ref') {
    input.videos = [`${base}reference.mp4`]
  }
  if (mode === 'audio_ref' || mode === 'mixed_ref') {
    input.audios = [`${base}reference.mp3`]
  }
  return input
}
