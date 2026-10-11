'use client';

import { useRef, useState } from 'react';
import {
  previewManualIadpImport,
  saveManualIadpImport,
  type IadpManualPreviewResult,
  type IadpPreviewItem,
} from '@/app/actions/iadp-manual-import';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { AlertTriangle, FileJson, ShieldCheck, X } from 'lucide-react';

export function IadpManualImportCard({ onSaved }: { onSaved?: (message: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<IadpManualPreviewResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState<'preview' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectFile = (selected: File | null) => {
    setFile(selected);
    setPreview(null);
    setConfirmed(false);
    setError(null);
  };

  const generatePreview = async () => {
    if (!file) return;
    setLoading('preview');
    setError(null);
    const formData = new FormData();
    formData.set('file', file);
    const result = await previewManualIadpImport(formData);
    setLoading(null);
    if (!result.success) {
      setPreview(null);
      setError(result.error ?? 'Não foi possível gerar a prévia.');
      return;
    }
    setPreview(result);
    setConfirmed(false);
  };

  const savePreview = async () => {
    if (!file || !preview?.digest || !confirmed) return;
    setLoading('save');
    setError(null);
    const formData = new FormData();
    formData.set('file', file);
    formData.set('expectedDigest', preview.digest);
    formData.set('confirmed', 'true');
    const result = await saveManualIadpImport(formData);
    setLoading(null);
    if (!result.success) {
      setError(result.error ?? 'Não foi possível salvar a escala IADP.');
      return;
    }
    setPreview(null);
    setConfirmed(false);
    setFile(null);
    if (inputRef.current) inputRef.current.value = '';
    onSaved?.('message' in result ? result.message : 'Escala IADP importada.');
  };

  return (
    <section className="rounded-xl border border-gray-200 bg-gray-50 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <FileJson className="mt-0.5 size-5 shrink-0 text-brand-600" />
        <div>
          <h3 className="font-semibold text-gray-900">Importação manual IADP</h3>
          <p className="mt-1 text-sm text-gray-600">
            Use somente um JSON anonimizado. Primeiro gere a prévia; nada é salvo sem confirmação.
          </p>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
      />

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button variant="secondary" onPress={() => inputRef.current?.click()}>
          Selecionar JSON
        </Button>
        {file && (
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-gray-200">
            <span className="truncate text-gray-700">{file.name}</span>
            <button type="button" onClick={() => selectFile(null)} aria-label="Remover JSON">
              <X className="size-4 text-gray-500" />
            </button>
          </div>
        )}
        <Button onPress={generatePreview} isDisabled={!file || loading !== null}>
          {loading === 'preview' ? 'Analisando...' : 'Gerar prévia'}
        </Button>
      </div>

      {error && (
        <div className="mt-4 flex gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {preview?.counts && (
        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <CountCard label="Inclusões" value={preview.counts.insertions} />
            <CountCard label="Alterações" value={preview.counts.updates} />
            <CountCard label="Inalterados" value={preview.counts.unchanged} />
            <CountCard label="Possíveis remoções" value={preview.counts.removalCandidates} warning />
          </div>

          <p className="text-xs text-gray-500">
            Período: {formatDateTime(preview.period?.from)} até {formatDateTime(preview.period?.to)}
          </p>

          <div className="max-h-72 space-y-4 overflow-y-auto rounded-lg border border-gray-200 bg-white p-3">
            <PreviewGroup title="Inclusões" items={preview.insertions ?? []} />
            <PreviewGroup title="Alterações" items={preview.updates ?? []} />
            <PreviewGroup title="Inalterados" items={preview.unchanged ?? []} />
            <PreviewGroup
              title="Candidatos a remoção — somente informativos"
              items={preview.removalCandidates ?? []}
              warning
            />
          </div>

          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            Nenhum registro ausente será excluído. A resposta do servidor não comprova completude da escala.
          </div>

          {!preview.snapshot?.completeAndValid && (
            <div className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
              Snapshot inválido: {preview.snapshot?.reasons.join(', ') || 'falha de validação'}
            </div>
          )}

          <Checkbox
            isSelected={confirmed}
            onChange={setConfirmed}
            isDisabled={!preview.snapshot?.completeAndValid}
            label="Confirmo a importação desta prévia"
            hint="Somente inclusões e alterações serão gravadas; candidatos a remoção serão ignorados."
          />

          <div className="flex justify-end">
            <Button
              iconLeading={ShieldCheck}
              onPress={savePreview}
              isDisabled={!confirmed || !preview.snapshot?.completeAndValid || loading !== null}
            >
              {loading === 'save' ? 'Salvando...' : 'Salvar importação IADP'}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function CountCard({ label, value, warning = false }: { label: string; value: number; warning?: boolean }) {
  return (
    <div className={`rounded-lg p-3 ${warning ? 'bg-amber-50 text-amber-900' : 'bg-white text-gray-900'}`}>
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-xs">{label}</div>
    </div>
  );
}

function PreviewGroup({ title, items, warning = false }: { title: string; items: IadpPreviewItem[]; warning?: boolean }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h4 className={`mb-2 text-xs font-semibold uppercase tracking-wide ${warning ? 'text-amber-700' : 'text-gray-500'}`}>
        {title} ({items.length})
      </h4>
      <div className="space-y-1">
        {items.map((item) => (
          <div key={item.sourceEventId} className="flex flex-wrap justify-between gap-x-4 rounded px-2 py-1.5 text-sm odd:bg-gray-50">
            <span className="font-medium text-gray-800">{item.code} · {item.route}</span>
            <span className="text-gray-500">
              {formatDateTime(item.departureTime)}
              {item.previousDepartureTime && item.previousDepartureTime !== item.departureTime
                ? ` (antes ${formatDateTime(item.previousDepartureTime)})`
                : ''}
              {item.reconcilesPdf ? ' · conciliará PDF' : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatDateTime(value?: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
}
