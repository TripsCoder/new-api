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
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

import {
  applyCandidate,
  changes,
  importCandidate,
  openAPIOperations,
  parseSafe,
} from './configuration'
import type { Mode } from './types'

export function ParameterImport(props: {
  model: string
  modeKey: string
  mode: Mode
  onApply: (mode: Mode) => void
}) {
  const { t } = useTranslation()
  const [text, setText] = useState(''),
    [operation, setOperation] = useState(''),
    [preview, setPreview] = useState<{
      baseline: string
      candidate: ReturnType<typeof importCandidate>
    } | null>(null),
    [confirmed, setConfirmed] = useState(false)
  const operations = useMemo(() => {
    try {
      return openAPIOperations(parseSafe(text))
    } catch {
      return []
    }
  }, [text])
  const rows = preview
    ? changes(
        {
          input: props.mode.input,
          parameters: props.mode.parameters,
          mapping: props.mode.mapping,
        },
        {
          input: preview.candidate.input,
          parameters: preview.candidate.parameters,
          mapping: preview.candidate.mapping,
        }
      )
    : []
  const conflicts =
    (preview?.candidate.model && preview.candidate.model !== props.model) ||
    rows.some(
      (row) =>
        row.before !== undefined &&
        row.after !== undefined &&
        typeof row.before !== typeof row.after
    )
  function read(): void {
    try {
      setPreview({
        baseline: JSON.stringify(props.mode),
        candidate: importCandidate(
          parseSafe(text),
          props.model,
          props.modeKey,
          operation
        ),
      })
      setConfirmed(false)
    } catch (error) {
      toast.error(t(error instanceof Error ? error.message : 'Import failed'))
    }
  }
  function apply(replace: boolean): void {
    if (!preview) return
    if (preview.baseline !== JSON.stringify(props.mode)) {
      toast.error(t('Settings changed; read the file again before applying'))
      return
    }
    if (conflicts && !confirmed) return
    props.onApply(applyCandidate(props.mode, preview.candidate, replace))
    setPreview(null)
    setText('')
  }
  return (
    <div className='space-y-4'>
      <Field>
        <FieldLabel>{t('Paste JSON or choose a file')}</FieldLabel>
        <Textarea
          rows={7}
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setPreview(null)
          }}
          aria-label={t('Parameters to import')}
        />
        <Input
          type='file'
          accept='.json,application/json'
          aria-label={t('Choose a JSON file')}
          onChange={async (event) => {
            const file = event.target.files?.[0]
            if (!file) return
            if (file.size > 1000000) {
              toast.error(t('JSON file exceeds 1 MB'))
              return
            }
            try {
              setText(await file.text())
              setPreview(null)
            } catch {
              toast.error(t('The selected file could not be read'))
            }
          }}
        />
      </Field>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Request examples do not define required fields or defaults. JSON Schema and OpenAPI reuse only their stated rules. Remove keys before importing.'
        )}
      </p>
      {operations.length > 0 && (
        <Select
          value={operation}
          onValueChange={(value) => {
            setOperation(String(value))
            setPreview(null)
          }}
        >
          <SelectTrigger aria-label={t('Choose an API operation')}>
            <SelectValue placeholder={t('Choose an API operation')} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {operations.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      )}
      <Button variant='outline' onClick={read}>
        {t('Read content and review changes')}
      </Button>
      {preview && (
        <div className='space-y-4'>
          <Alert>
            <AlertTitle>{t('Review this change')}</AlertTitle>
            <AlertDescription>
              {t(
                'Only the current shared configuration and generation mode will change. Other modes and channel keys will not change.'
              )}
            </AlertDescription>
          </Alert>
          {preview.candidate.warnings.map((warning) => (
            <p key={warning} className='text-sm'>
              {t(warning)}
            </p>
          ))}
          <div className='max-h-64 overflow-auto'>
            <table className='w-full text-sm'>
              <thead>
                <tr>
                  <th className='text-start'>{t('Parameter')}</th>
                  <th className='text-start'>{t('Current value')}</th>
                  <th className='text-start'>{t('Imported value')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 500).map((row) => (
                  <tr key={row.path}>
                    <td className='max-w-64 p-2 break-all'>{row.path}</td>
                    <td className='max-w-64 p-2 break-all'>
                      {JSON.stringify(row.before) ?? t('Not specified')}
                    </td>
                    <td className='max-w-64 p-2 break-all'>
                      {JSON.stringify(row.after) ?? t('Not in file')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {conflicts && (
            <Field orientation='horizontal'>
              <Checkbox
                id='confirm-import-conflicts'
                checked={confirmed}
                onCheckedChange={setConfirmed}
              />
              <FieldLabel htmlFor='confirm-import-conflicts'>
                {t('I checked the model and value type conflicts')}
              </FieldLabel>
            </Field>
          )}
          <div className='flex flex-wrap gap-2'>
            <Button
              disabled={Boolean(conflicts && !confirmed)}
              onClick={() => apply(false)}
            >
              {t('Merge and keep other parameters')}
            </Button>
            <Button
              variant='outline'
              disabled={Boolean(conflicts && !confirmed)}
              onClick={() => apply(true)}
            >
              {preview.candidate.definitionOnly
                ? t('Replace parameter rules and keep filled values')
                : t('Replace current mode parameters')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
