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
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ParameterFields } from '../parameter-fields'
import type { Mode } from '../types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

function Harness() {
  const [value, setValue] = useState<Mode>({
    enabled: true,
    input: {},
    parameters: { generate_audio: { type: 'boolean' } },
    mapping: { generate_audio: 'vendor_audio' },
    cost: { amount: null, confirmed: false },
  })
  return (
    <>
      <ParameterFields
        mode={value}
        onChange={setValue}
        advanced
        allowExclusion
      />
      <output data-testid='configuration'>{JSON.stringify(value)}</output>
    </>
  )
}
const saved = () =>
  JSON.parse(screen.getByTestId('configuration').textContent ?? '{}') as Mode

describe('parameter delivery and boolean defaults', () => {
  it('distinguishes unset, true and false and clears the default without disabling the field', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const control = screen.getByRole('combobox', {
      name: 'generate_audio: Default value',
    })
    expect(control).toHaveTextContent('Not specified')
    expect(saved().input).not.toHaveProperty('generate_audio')
    await user.click(control)
    await user.click(screen.getByRole('option', { name: 'True' }))
    expect(saved().input.generate_audio).toBe(true)
    await user.click(
      screen.getByRole('button', { name: 'Clear default value' })
    )
    expect(control).toHaveTextContent('Not specified')
    expect(saved().input).not.toHaveProperty('generate_audio')
    await user.click(control)
    await user.click(screen.getByRole('option', { name: 'False' }))
    expect(saved().input.generate_audio).toBe(false)
    await user.click(control)
    await user.click(screen.getByRole('option', { name: 'Not specified' }))
    expect(saved().input).not.toHaveProperty('generate_audio')
    expect(
      screen.getByRole('checkbox', {
        name: /^Include parameter: generate_audio/,
      })
    ).toBeChecked()
  })

  it('explicitly selects upstream-only delivery and preserves false, then ignores both directions', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(
      screen.getByRole('combobox', { name: 'generate_audio: Default value' })
    )
    await user.click(screen.getByRole('option', { name: 'False' }))
    await user.click(screen.getByText('Advanced parameter delivery'))
    const delivery = screen.getByRole('combobox', {
      name: 'generate_audio: Parameter delivery',
    })
    expect(delivery).toHaveTextContent('Both directions: caller value first')
    await user.click(delivery)
    await user.click(
      screen.getByRole('option', { name: 'Upstream only: configured default' })
    )
    expect(saved().parameters?.generate_audio).toMatchObject({
      inputPolicy: 'upstream_default',
    })
    expect(saved().input.generate_audio).toBe(false)
    expect(saved().mapping?.generate_audio).toBe('vendor_audio')
    expect(delivery).toHaveTextContent('Upstream only: configured default')
    await user.click(delivery)
    await user.click(
      screen.getByRole('option', { name: 'Ignore both directions' })
    )
    expect(saved().mapping?.generate_audio).toBe('@ignore')
    expect(delivery).toHaveTextContent('Ignore both directions')
    expect(saved().parameters?.generate_audio).not.toHaveProperty('inputPolicy')
    expect(
      screen.getByRole('checkbox', {
        name: /^Include parameter: generate_audio/,
      })
    ).not.toBeChecked()
  })
})
