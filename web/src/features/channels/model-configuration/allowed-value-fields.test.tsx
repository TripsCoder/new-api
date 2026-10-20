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
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { documentParameterNames } from './configuration'
import { MappingPreview } from './mapping-preview'
import { ParameterFields } from './parameter-fields'
import { parameterConfigurationIssues } from './parameter-validation'
import type { Catalog, Configuration, Mode, Parameter } from './types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (text: string) => text }),
}))
const duration: Parameter = {
  minimum: 4,
  maximum: 15,
  definition: {
    minimum: 4,
    maximum: 15,
    anyOf: [{ type: 'integer' }, { type: 'string', pattern: '^[0-9]+$' }],
    'x-channel-parameter': {
      status: 'documented',
      vendorFields: ['duration'],
      capabilities: ['base'],
    },
  },
}
function mode(parameter = duration): Mode {
  return {
    enabled: true,
    input: {},
    parameters: { seconds: structuredClone(parameter) },
    mapping: { seconds: 'seconds' },
    cost: { amount: null, confirmed: false },
  }
}
function issues(value: Mode): string[] {
  const catalog = {
    models: {
      actual: {
        parameters: { seconds: duration },
        modes: { text_video: { required: [] } },
        source: { url: 'https://docs.example.test' },
      },
    },
  } as unknown as Catalog
  const document = {
    format: 'channel-model-configuration/v1',
    provider: 'paisio_media',
    revision: 0,
    groups: { current: { name: 'current', modes: { text_video: value } } },
    bindings: { actual: { text_video: { groupId: 'current' } } },
  } as Configuration
  return parameterConfigurationIssues(document, catalog, ['actual'])
}
function Harness(props: { initial?: Mode }) {
  const [value, setValue] = useState(props.initial ?? mode())
  return (
    <>
      <ParameterFields
        mode={value}
        documentedNames={{ seconds: 'duration' }}
        onChange={setValue}
        advanced
      />
      <output data-testid='current'>{JSON.stringify(value)}</output>
    </>
  )
}
const current = () =>
  JSON.parse(screen.getByTestId('current').textContent ?? '{}') as Mode

describe('business allowed values and documented names', () => {
  it('stores only 5 or 10 as choices, keeping one optional default separate and rejecting units', async () => {
    render(<Harness />)
    await userEvent.click(
      screen.getByRole('combobox', { name: 'duration: Allowed value rule' })
    )
    await userEvent.click(
      screen.getByRole('option', { name: 'Fixed choices only' })
    )
    const choices = screen.getByRole('textbox', {
      name: 'duration: Fixed choices (comma separated)',
    })
    await userEvent.type(choices, '5,10')
    expect(current().parameters?.seconds.enum).toEqual([5, '5', 10, '10'])
    expect(current().input).toEqual({})
    fireEvent.change(
      screen.getByRole('spinbutton', { name: /Video duration/ }),
      { target: { value: '5' } }
    )
    expect(current().input.seconds).toBe(5)
    expect(issues(current())).toEqual([])
    fireEvent.change(choices, { target: { value: '5s,10' } })
    expect(
      issues(current()).some((value) =>
        value.includes('Fixed choices must be numbers')
      )
    ).toBe(true)
  })
  it('stores inclusive numeric bounds instead of a range string, and rejects widening or reversed bounds', async () => {
    render(<Harness />)
    await userEvent.click(
      screen.getByRole('combobox', { name: 'duration: Allowed value rule' })
    )
    await userEvent.click(screen.getByRole('option', { name: 'Numeric range' }))
    const maximum = screen.getByRole('spinbutton', {
      name: 'duration: Maximum allowed value',
    })
    fireEvent.change(maximum, { target: { value: '10' } })
    expect(current().parameters?.seconds).toMatchObject({
      minimum: 4,
      maximum: 10,
    })
    expect(current().parameters?.seconds.enum).toEqual(
      Array.from({ length: 7 }, (_, index) => index + 4).flatMap((value) => [
        value,
        String(value),
      ])
    )
    expect(current().parameters?.seconds.enum).not.toContain(11)
    expect(current().parameters?.seconds.enum).not.toContain('11')
    expect(current().input.seconds).toBeUndefined()
    fireEvent.change(maximum, { target: { value: '30' } })
    expect(
      issues(current()).some((value) => value.includes('Maximum exceeds'))
    ).toBe(true)
    fireEvent.change(maximum, { target: { value: '3' } })
    expect(
      issues(current()).some((value) => value.includes('Minimum cannot exceed'))
    ).toBe(true)
    const invalid = mode()
    invalid.input.seconds = '4~10'
    expect(
      issues(invalid).some((value) =>
        value.includes('Default must be one number')
      )
    ).toBe(true)
  })
  it('keeps ratio choices as separate strings and does not turn them into a default', async () => {
    const initial = {
      ...mode(),
      parameters: {
        aspect_ratio: {
          type: 'string',
          definition: {
            'x-channel-parameter': {
              status: 'documented',
              vendorFields: ['aspect_ratio'],
            },
          },
        },
      },
      mapping: { aspect_ratio: 'aspect_ratio' },
    }
    render(<Harness initial={initial} />)
    await userEvent.click(
      screen.getByRole('combobox', { name: 'aspect_ratio: Allowed value rule' })
    )
    await userEvent.click(
      screen.getByRole('option', { name: 'Fixed choices only' })
    )
    await userEvent.type(
      screen.getByRole('textbox', {
        name: 'aspect_ratio: Fixed choices (comma separated)',
      }),
      '1:1,16:9'
    )
    expect(current().parameters?.aspect_ratio.enum).toEqual(['1:1', '16:9'])
    expect(current().input).toEqual({})
    expect(
      screen.queryByRole('option', { name: 'Numeric range' })
    ).not.toBeInTheDocument()
  })
  it('preserves documented enum selection instead of offering arbitrary additions', () => {
    render(
      <Harness
        initial={{
          ...mode(),
          parameters: {
            aspect_ratio: {
              type: 'string',
              enum: ['1:1', '16:9'],
              definition: { enum: ['1:1', '16:9'] },
            },
          },
        }}
      />
    )
    expect(
      screen.getByRole('checkbox', { name: /^aspect_ratio: 1:1/ })
    ).toBeChecked()
    expect(
      screen.getByRole('combobox', { name: 'aspect_ratio: Allowed value rule' })
    ).toBeInTheDocument()
  })
  it('uses vendor metadata for duration while explicitly labeling the internal seconds mapping', async () => {
    const names = documentParameterNames({
      parameters: { seconds: duration },
    } as never)
    expect(names).toEqual({ seconds: 'duration' })
    render(
      <MappingPreview
        mode={mode()}
        documentedNames={names}
        onChange={vi.fn()}
      />
    )
    await userEvent.click(
      screen.getByText('Advanced: plugin input mapping and handling policies')
    )
    expect(
      screen.getAllByText('duration', { selector: 'code' }).length
    ).toBeGreaterThan(0)
    expect(
      screen.getByRole('textbox', {
        name: 'Plugin input field (internal): seconds',
      })
    ).toHaveValue('seconds')
    expect(
      screen.queryByRole('textbox', { name: '上游字段: seconds' })
    ).not.toBeInTheDocument()
  })
  it('offers unlimited values without filling ranges and restores documented choices', async () => {
    render(<Harness />)
    await userEvent.click(
      screen.getByRole('combobox', { name: 'duration: Allowed value rule' })
    )
    await userEvent.click(
      screen.getByRole('option', { name: 'No value restrictions' })
    )
    expect(
      current().parameters?.seconds.definition?.['x-business-allowed-values']
    ).toBe('unlimited')
    expect(current().parameters?.seconds.enum).toBeUndefined()
    expect(current().parameters?.seconds.maximum).toBeUndefined()
    fireEvent.change(
      screen.getByRole('spinbutton', { name: /Video duration/ }),
      { target: { value: '77' } }
    )
    expect(issues(current())).toEqual([])
    await userEvent.click(
      screen.getByRole('combobox', { name: 'duration: Allowed value rule' })
    )
    await userEvent.click(
      screen.getByRole('option', { name: 'Use documented limits' })
    )
    expect(current().parameters?.seconds.maximum).toBe(15)
    expect(
      issues(current()).some((value) =>
        value.includes('Default must be one number')
      )
    ).toBe(true)
  })
  it('lets explicit document enums use unlimited and restores the original enum without offering invented fixed choices', async () => {
    render(
      <Harness
        initial={{
          ...mode(),
          parameters: {
            aspect_ratio: {
              type: 'string',
              enum: ['1:1', '16:9'],
              definition: { enum: ['1:1', '16:9'] },
            },
          },
        }}
      />
    )
    const select = () =>
      screen.getByRole('combobox', { name: 'aspect_ratio: Allowed value rule' })
    await userEvent.click(select())
    expect(
      screen.queryByRole('option', { name: 'Fixed choices only' })
    ).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('option', { name: 'No value restrictions' })
    )
    expect(
      screen.queryByRole('checkbox', { name: /aspect_ratio: 1:1/ })
    ).not.toBeInTheDocument()
    expect(current().parameters?.aspect_ratio.enum).toBeUndefined()
    await userEvent.click(select())
    await userEvent.click(
      screen.getByRole('option', { name: 'Use documented limits' })
    )
    expect(current().parameters?.aspect_ratio.enum).toEqual(['1:1', '16:9'])
  })
})
