import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

import { ModelReview } from './model-review'
import type { Configuration } from './types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
function fixture(): Configuration {
  return {
    format: 'channel-model-configuration/v1',
    provider: 'yuxibox_media',
    revision: 1,
    groups: {
      g: {
        name: 'g',
        modes: {
          video_ref: {
            enabled: true,
            input: {},
            parameters: {},
            cost: {
              amount: 0.1,
              currency: 'USD',
              unit: 'seconds',
              confirmed: false,
            },
          },
        },
      },
    },
    bindings: { A: { video_ref: { groupId: 'g' } } },
  }
}
function text() {
  return screen
    .getAllByTestId('review-readable-row')
    .map((row) => row.textContent)
    .join(' ')
}
describe('Chinese operator save review', () => {
  it('shows capability names and enabled states without technical JSON in the visible values', () => {
    const before = fixture()
    const after = structuredClone(before)
    after.bindings.A.video_ref.capabilities = {
      images: false,
      videos: true,
      audios: false,
      firstFrame: false,
      lastFrame: false,
    }
    render(<ModelReview baseline={before} draft={after} />)
    expect(text()).toContain('参考视频：已开启')
    expect(text()).toContain('参考图片：已关闭')
    expect(text()).toContain('参考音频：已关闭')
    expect(text()).not.toContain('images')
    expect(text()).not.toContain('firstFrame')
    expect(screen.getByTestId('review-raw-details')).not.toHaveAttribute('open')
    expect(
      screen.getByTestId('review-raw-details').querySelector('pre')
    ).not.toBeVisible()
  })
  it('summarizes simple markup with method, value and final unit price', () => {
    const before = fixture()
    const after = structuredClone(before)
    after.bindings.A.video_ref.pricing = { method: 'fixed_markup', value: 0.01 }
    after.bindings.A.video_ref.billing = {
      expression: '0.11 * u("seconds")',
      currency: 'USD',
      confirmed: true,
    }
    render(<ModelReview baseline={before} draft={after} />)
    expect(text()).toContain('加价方式：固定加价')
    expect(text()).toContain('数值：0.01 USD / 秒')
    expect(text()).toContain('最终单位价格：0.11 USD / 秒')
    expect(text()).not.toContain('expression')
    expect(text()).not.toContain('confirmed')
  })
  it('labels changed advanced prices without exposing formula syntax in normal values', () => {
    const before = fixture()
    before.bindings.A.video_ref.billing = {
      expression: 'u("seconds") > 5 ? 10 : 4',
      currency: 'USD',
      confirmed: true,
    }
    const after = structuredClone(before)
    after.bindings.A.video_ref.billing = {
      expression: 'u("seconds") > 5 ? 12 : 5',
      currency: 'USD',
      confirmed: true,
    }
    render(<ModelReview baseline={before} draft={after} />)
    expect(text()).toContain('原高级定价')
    expect(text()).toContain('已修改高级定价')
    expect(text()).not.toContain('u(')
  })
  it('uses readable limits and puts unknown nested objects only in advanced details', () => {
    const before = fixture()
    const after = structuredClone(before)
    after.bindings.A.video_ref.parameters = {
      videos: { type: 'array', required: false, definition: { maxItems: 2 } },
    }
    after.bindings.A.video_ref.input = {
      unknown_vendor_field: { nested_flag: true },
    }
    render(<ModelReview baseline={before} draft={after} />)
    expect(text()).toContain('最多素材数：2')
    expect(text()).toContain('可不填写')
    expect(text()).toContain('已设置，详见高级详情')
    expect(text()).not.toContain('nested_flag')
    expect(text()).not.toContain('unknown_vendor_field')
  })
  it('states that the original advanced price is preserved when only capabilities change', () => {
    const before = fixture()
    before.bindings.A.video_ref.billing = {
      expression: 'u("seconds") > 5 ? 10 : 4',
      currency: 'USD',
      confirmed: true,
    }
    const after = structuredClone(before)
    after.bindings.A.video_ref.capabilities = {
      images: false,
      videos: true,
      audios: false,
    }
    render(<ModelReview baseline={before} draft={after} />)
    expect(text()).toContain('保留原高级定价')
    expect(text()).not.toContain('u(')
  })
})
