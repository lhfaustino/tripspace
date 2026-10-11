'use client';

import { type ChangeEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getCurrentMealPlanVersion, refreshCurrentUserMealPlan, uploadRoster } from '@/app/actions/roster-upload';
import { sendTodayFlightInformation } from '@/app/actions/telegram';
import { RosterUploadCard } from '@/components/features/roster/RosterUploadCard';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Dialog, Modal, ModalOverlay } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { buildGoogleCalendarEvent, GOOGLE_CALENDAR_SCOPE } from '@/lib/google-calendar';
import { createClient } from '@/lib/supabase/client';
import { CalendarPlus, RefreshCw, Send } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';

type FlightMenuRow = {
  id: string;
  date: string;
  flightNumber: string;
  origin: string;
  destination: string;
  period: string;
  crewService: string;
  paxService: string;
};

interface FlightMenuUploadWorkspaceProps {
  currentMealPlanUpdatedAt?: string | null;
  userMealPlanRefreshedAt?: string | null;
  currentUserId?: string | null;
  initialRows?: FlightMenuRow[];
}

export function FlightMenuUploadWorkspace({
  currentMealPlanUpdatedAt = null,
  userMealPlanRefreshedAt = null,
  currentUserId = null,
  initialRows = [],
}: FlightMenuUploadWorkspaceProps) {
  const router = useRouter();
  const { addToast } = useToast();
  const [rosterFiles, setRosterFiles] = useState<File[]>([]);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isRefreshingMealPlan, setIsRefreshingMealPlan] = useState(false);
  const [isSendingTelegram, setIsSendingTelegram] = useState(false);
  const [isSavingCalendar, setIsSavingCalendar] = useState(false);
  const [latestMealPlanUpdatedAt, setLatestMealPlanUpdatedAt] = useState<string | null>(currentMealPlanUpdatedAt);
  const [lastAppliedMealPlanUpdatedAt, setLastAppliedMealPlanUpdatedAt] = useState<string | null>(userMealPlanRefreshedAt);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [rows, setRows] = useState<FlightMenuRow[]>(initialRows);
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [selectedMonth, setSelectedMonth] = useState(() => getCurrentMonthIso());
  const [todayIso, setTodayIso] = useState('');
  const monthOptions = getMonthOptions(rows, selectedMonth);
  const visibleRows = selectedMonth === 'all' ? rows : rows.filter((row) => isCurrentMonth(row.date, selectedMonth));
  const visibleRowIds = visibleRows.map((row) => row.id);
  const selectedVisibleRowCount = visibleRowIds.filter((id) => selectedRowIds.includes(id)).length;
  const areAllVisibleRowsSelected = visibleRows.length > 0 && selectedVisibleRowCount === visibleRows.length;
  const areSomeVisibleRowsSelected = selectedVisibleRowCount > 0 && selectedVisibleRowCount < visibleRows.length;
  const mealPlanStorageKey = currentUserId ? `flight-menu:meal-plan-refresh:${currentUserId}` : null;
  const mealPlanToastStorageKey = currentUserId ? `flight-menu:meal-plan-toast:${currentUserId}` : null;
  const calendarPendingStorageKey = currentUserId ? `flight-menu:calendar-pending:${currentUserId}` : null;

  useEffect(() => {
    setRows(initialRows);
  }, [initialRows]);

  useEffect(() => {
    const rowIds = new Set(rows.map((row) => row.id));
    setSelectedRowIds((currentIds) => currentIds.filter((id) => rowIds.has(id)));
  }, [rows]);

  useEffect(() => {
    setLatestMealPlanUpdatedAt(currentMealPlanUpdatedAt);
  }, [currentMealPlanUpdatedAt]);

  useEffect(() => {
    setLastAppliedMealPlanUpdatedAt(userMealPlanRefreshedAt);
  }, [userMealPlanRefreshedAt]);

  useEffect(() => {
    setTodayIso(getTodayIsoDate());
  }, []);

  useEffect(() => {
    if (!mealPlanStorageKey || !mealPlanToastStorageKey || !latestMealPlanUpdatedAt) {
      return;
    }

    const lastAppliedMealPlan = lastAppliedMealPlanUpdatedAt ?? window.localStorage.getItem(mealPlanStorageKey);
    if (lastAppliedMealPlan === latestMealPlanUpdatedAt) {
      return;
    }

    const lastNotifiedMealPlan = window.sessionStorage.getItem(mealPlanToastStorageKey);
    if (lastNotifiedMealPlan === latestMealPlanUpdatedAt) {
      return;
    }

    window.sessionStorage.setItem(mealPlanToastStorageKey, latestMealPlanUpdatedAt);
    addToast({
      title: 'Novo meal plan disponivel',
      description: 'Clique em Atualizar para aplicar os novos servicos aos seus voos.',
      type: 'warning',
      duration: 0,
      dedupeKey: `meal-plan-refresh:${currentUserId}:${latestMealPlanUpdatedAt}`,
    });
  }, [addToast, currentUserId, latestMealPlanUpdatedAt, lastAppliedMealPlanUpdatedAt, mealPlanStorageKey, mealPlanToastStorageKey]);

  useEffect(() => {
    const intervalId = window.setInterval(async () => {
      const result = await getCurrentMealPlanVersion();
      if (result.success && result.mealPlanUpdatedAt) {
        setLatestMealPlanUpdatedAt(result.mealPlanUpdatedAt);
      }
    }, 60000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.get('calendarSync') !== '1' || !calendarPendingStorageKey) return;

    const pendingSelection = window.sessionStorage.getItem(calendarPendingStorageKey);
    searchParams.delete('calendarSync');
    const nextUrl = `${window.location.pathname}${searchParams.size > 0 ? `?${searchParams.toString()}` : ''}`;
    window.history.replaceState(null, '', nextUrl);

    if (!pendingSelection) {
      setMessage({ type: 'error', text: 'A seleção de voos expirou. Selecione os voos novamente.' });
      return;
    }

    window.sessionStorage.removeItem(calendarPendingStorageKey);

    try {
      const rowIds = JSON.parse(pendingSelection);
      if (!Array.isArray(rowIds) || rowIds.some((id) => typeof id !== 'string')) throw new Error('Invalid selection');
      setSelectedRowIds(rowIds);
      void saveFlightsToGoogleCalendar(rowIds, false);
    } catch {
      setMessage({ type: 'error', text: 'Não foi possível recuperar os voos selecionados.' });
    }
    // This should run once after returning from Google OAuth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendarPendingStorageKey]);

  const handleUpdate = async () => {
    if (rosterFiles.length === 0) {
      setMessage({ type: 'error', text: 'Selecione um ou mais PDFs da escala antes de atualizar.' });
      return;
    }

    setIsUpdating(true);
    setMessage(null);

    try {
      const formData = new FormData();
      rosterFiles.forEach((file) => formData.append('files', file));

      const result = await uploadRoster(formData);

      if (result.success) {
        setRows(result.rows ?? rows);
        setMessage({ type: 'success', text: result.message ?? 'Escala atualizada.' });
        const mealPlanVersion = await getCurrentMealPlanVersion();
        if (mealPlanStorageKey && mealPlanVersion.success && mealPlanVersion.mealPlanUpdatedAt) {
          window.localStorage.setItem(mealPlanStorageKey, mealPlanVersion.mealPlanUpdatedAt);
          setLastAppliedMealPlanUpdatedAt(mealPlanVersion.mealPlanUpdatedAt);
          if (mealPlanToastStorageKey) {
            window.sessionStorage.setItem(mealPlanToastStorageKey, mealPlanVersion.mealPlanUpdatedAt);
          }
          setLatestMealPlanUpdatedAt(mealPlanVersion.mealPlanUpdatedAt);
        }
        setIsUploadOpen(false);
        setRosterFiles([]);
        router.refresh();
      } else {
        setMessage({ type: 'error', text: result.error ?? 'Não foi possível atualizar a escala.' });
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Não foi possível atualizar a escala.',
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleSendTodayInformation = async () => {
    if (selectedRowIds.length === 0) {
      setMessage({ type: 'error', text: 'Selecione ao menos um voo para enviar.' });
      return;
    }

    setIsSendingTelegram(true);
    setMessage(null);

    try {
      const result = await sendTodayFlightInformation(selectedRowIds);

      if (result.success) {
        setMessage({ type: 'success', text: result.message ?? 'Voos enviados pelo Telegram.' });
      } else {
        setMessage({ type: 'error', text: result.error ?? 'Não foi possível enviar pelo Telegram.' });
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Não foi possível enviar pelo Telegram.',
      });
    } finally {
      setIsSendingTelegram(false);
    }
  };

  const handleSaveToGoogleCalendar = () => {
    void saveFlightsToGoogleCalendar(selectedRowIds, true);
  };

  const saveFlightsToGoogleCalendar = async (rowIds: string[], allowAuthorization: boolean) => {
    if (rowIds.length === 0) {
      setMessage({ type: 'error', text: 'Selecione ao menos um voo para salvar no Google Agenda.' });
      return;
    }

    if (!navigator.onLine) {
      setMessage({
        type: 'error',
        text: 'Conecte-se à internet para salvar os voos. Depois da sincronização, eles ficam disponíveis no app Google Agenda.',
      });
      return;
    }

    setIsSavingCalendar(true);
    setMessage(null);

    try {
      const supabase = createClient();
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;

      const providerToken = data.session?.provider_token;
      if (!providerToken) {
        if (!allowAuthorization || !calendarPendingStorageKey) {
          throw new Error('A autorização do Google Agenda não foi concluída. Tente novamente.');
        }

        window.sessionStorage.setItem(calendarPendingStorageKey, JSON.stringify(rowIds));
        const { error: oauthError } = await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent('/roster-upload?calendarSync=1')}`,
            scopes: GOOGLE_CALENDAR_SCOPE,
            queryParams: { access_type: 'offline', prompt: 'consent' },
          },
        });
        if (oauthError) throw oauthError;
        return;
      }

      const selectedFlights = rows.filter((row) => rowIds.includes(row.id));
      const invalidFlights: FlightMenuRow[] = [];
      let savedCount = 0;
      let existingCount = 0;

      for (const flight of selectedFlights) {
        const calendarEvent = await buildGoogleCalendarEvent(flight);
        if (!calendarEvent) {
          invalidFlights.push(flight);
          continue;
        }

        const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${providerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(calendarEvent),
        });

        if (response.status === 409) {
          existingCount += 1;
          continue;
        }

        if ((response.status === 401 || response.status === 403) && allowAuthorization && calendarPendingStorageKey) {
          window.sessionStorage.setItem(calendarPendingStorageKey, JSON.stringify(rowIds));
          const { error: oauthError } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: {
              redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent('/roster-upload?calendarSync=1')}`,
              scopes: GOOGLE_CALENDAR_SCOPE,
              queryParams: { access_type: 'offline', prompt: 'consent' },
            },
          });
          if (oauthError) throw oauthError;
          return;
        }

        if (!response.ok) {
          const responseBody = await response.json().catch(() => null);
          const reason = responseBody?.error?.message;
          throw new Error(reason || `O Google Agenda recusou o voo ${flight.flightNumber}.`);
        }

        savedCount += 1;
      }

      if (selectedFlights.length === 0) {
        throw new Error('Os voos selecionados não estão mais disponíveis. Atualize a página e tente novamente.');
      }

      const details = [
        savedCount > 0 ? `${savedCount} novo${savedCount === 1 ? '' : 's'}` : '',
        existingCount > 0 ? `${existingCount} já existente${existingCount === 1 ? '' : 's'}` : '',
        invalidFlights.length > 0 ? `${invalidFlights.length} sem data ou horário válido` : '',
      ].filter(Boolean);

      setMessage({
        type: invalidFlights.length === selectedFlights.length ? 'error' : 'success',
        text: `Google Agenda atualizado: ${details.join(', ')}. Os eventos poderão ser consultados offline no aplicativo.`,
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Não foi possível salvar os voos no Google Agenda.',
      });
    } finally {
      setIsSavingCalendar(false);
    }
  };

  const toggleRowSelection = (rowId: string, isSelected: boolean) => {
    setSelectedRowIds((currentIds) => {
      if (isSelected) {
        return currentIds.includes(rowId) ? currentIds : [...currentIds, rowId];
      }

      return currentIds.filter((id) => id !== rowId);
    });
  };

  const toggleAllVisibleRows = (isSelected: boolean) => {
    setSelectedRowIds((currentIds) => {
      const visibleIds = new Set(visibleRowIds);

      if (!isSelected) {
        return currentIds.filter((id) => !visibleIds.has(id));
      }

      return [...new Set([...currentIds, ...visibleRowIds])];
    });
  };

  const handleMonthChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setSelectedMonth(event.target.value);
    setSelectedRowIds([]);
  };

  const handleRefreshMealPlan = async () => {
    setIsRefreshingMealPlan(true);
    setMessage(null);

    try {
      const result = await refreshCurrentUserMealPlan();

      if (result.success) {
        setRows(result.rows ?? rows);
        setMessage({ type: 'success', text: result.message ?? 'Servicos atualizados.' });
        if (mealPlanStorageKey && result.mealPlanUpdatedAt) {
          window.localStorage.setItem(mealPlanStorageKey, result.mealPlanUpdatedAt);
          setLastAppliedMealPlanUpdatedAt(result.mealPlanUpdatedAt);
          if (mealPlanToastStorageKey) {
            window.sessionStorage.setItem(mealPlanToastStorageKey, result.mealPlanUpdatedAt);
          }
          setLatestMealPlanUpdatedAt(result.mealPlanUpdatedAt);
        }
        router.refresh();
      } else {
        setRows(result.rows ?? rows);
        setMessage({ type: 'error', text: result.error ?? 'Não foi possível atualizar os serviços.' });
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Não foi possível atualizar os serviços.',
      });
    } finally {
      setIsRefreshingMealPlan(false);
    }
  };

  return (
    <div>
      <div className="mb-6 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-end">
        {message && (
          <div
            className={`rounded-lg px-4 py-3 text-sm sm:flex-1 ${
              message.type === 'success' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'
            }`}
          >
            {message.text}
          </div>
        )}
        <Button
          variant="secondary"
          onPress={handleRefreshMealPlan}
          isDisabled={isRefreshingMealPlan}
          className="w-full sm:w-auto"
          size="lg"
          iconLeading={RefreshCw}
        >
          {isRefreshingMealPlan ? 'Atualizando...' : 'Atualizar'}
        </Button>
        <Button
          variant="secondary"
          onPress={handleSendTodayInformation}
          isDisabled={isSendingTelegram || selectedRowIds.length === 0}
          className="w-full sm:w-auto"
          size="lg"
          iconLeading={Send}
        >
          {isSendingTelegram ? 'Enviando...' : 'Enviar'}
        </Button>
        <Button
          variant="secondary"
          onPress={handleSaveToGoogleCalendar}
          isDisabled={isSavingCalendar || selectedRowIds.length === 0}
          className="w-full sm:w-auto"
          size="lg"
          iconLeading={CalendarPlus}
        >
          {isSavingCalendar ? 'Salvando...' : 'Google Agenda'}
        </Button>
        <Button
          onPress={() => {
            setMessage(null);
            setIsUploadOpen(true);
          }}
          className="w-full sm:w-auto"
          size="lg"
        >
          Enviar Escala
        </Button>
      </div>

      <ModalOverlay isOpen={isUploadOpen} onOpenChange={setIsUploadOpen} isDismissable>
        <Modal className="sm:max-w-5xl">
          <Dialog className="outline-none">
            <div className="border-b border-gray-200 px-6 py-4">
              <h2 className="text-lg font-semibold text-gray-900">Enviar Escala</h2>
              <p className="mt-1 text-sm text-gray-500">
                Envie um ou mais arquivos de escala. A planilha de alimentação fixa será aplicada automaticamente.
              </p>
            </div>

            <div className="max-h-[75vh] overflow-y-auto px-4 py-5 sm:px-6">
              <div className="grid grid-cols-1 gap-6">
                <RosterUploadCard deferUpload onFilesSelected={setRosterFiles} />
              </div>

              {message && (
                <div
                  className={`mt-4 rounded-lg px-4 py-3 text-sm ${
                    message.type === 'success' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'
                  }`}
                >
                  {message.text}
                </div>
              )}
            </div>

            <div className="flex flex-col-reverse gap-3 border-t border-gray-200 px-6 py-4 sm:flex-row sm:justify-end">
              <Button
                variant="secondary"
                onPress={() => {
                  setIsUploadOpen(false);
                  setRosterFiles([]);
                }}
                isDisabled={isUpdating}
                className="w-full sm:w-auto"
              >
                Cancelar
              </Button>
              <Button
                onPress={handleUpdate}
                isDisabled={rosterFiles.length === 0 || isUpdating}
                className="w-full sm:w-auto"
              >
                {isUpdating ? 'Enviando...' : rosterFiles.length > 1 ? 'Atualizar escalas' : 'Atualizar escala'}
              </Button>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>

      <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-col gap-4 border-b border-gray-200 px-6 py-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Serviços</h2>
            <p className="mt-1 text-sm text-gray-500">
              {getFlightTableSummary({ rows, selectedRowIds, visibleRows })}
            </p>
          </div>

          <label className="flex w-full flex-col gap-1.5 text-sm font-medium text-gray-700 sm:w-56">
            Mês
            <select
              value={selectedMonth}
              onChange={handleMonthChange}
              className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-900 shadow-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
            >
              <option value="all">Todos os meses</option>
              {monthOptions.map((month) => (
                <option key={month} value={month}>
                  {formatMonth(month)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {visibleRows.length > 0 ? (
          <Table>
            <TableHeader>
                <TableRow>
                  <TableHead className="h-9 w-10 px-3">
                    <Checkbox
                      aria-label="Selecionar todos os voos visiveis"
                      isDisabled={visibleRows.length === 0}
                      isIndeterminate={areSomeVisibleRowsSelected}
                      isSelected={areAllVisibleRowsSelected}
                      onChange={toggleAllVisibleRows}
                    />
                  </TableHead>
                  <TableHead className="h-9 px-3">Data</TableHead>
                  <TableHead className="h-9 px-3">Voo</TableHead>
                  <TableHead className="h-9 px-3">Origem</TableHead>
                  <TableHead className="h-9 px-3">Destino</TableHead>
                  <TableHead className="h-9 px-3">Período</TableHead>
                  <TableHead className="h-9 px-3">Serviço crew</TableHead>
                  <TableHead className="h-9 px-3">Serviço pax</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.map((row) => (
                <TableRow
                  key={row.id}
                  className={todayIso && isToday(row.date, todayIso) ? 'bg-blue-50 hover:bg-blue-50' : undefined}
                >
                  <TableCell className="px-3 py-2">
                    <Checkbox
                      aria-label={`Selecionar voo ${row.flightNumber}`}
                      isSelected={selectedRowIds.includes(row.id)}
                      onChange={(isSelected) => toggleRowSelection(row.id, isSelected)}
                    />
                  </TableCell>
                  <TableCell className="px-3 py-2 font-medium text-gray-900">{formatDate(row.date)}</TableCell>
                  <TableCell className="px-3 py-2">{row.flightNumber}</TableCell>
                  <TableCell className="px-3 py-2">{row.origin}</TableCell>
                  <TableCell className="px-3 py-2">{row.destination}</TableCell>
                  <TableCell className="px-3 py-2 whitespace-nowrap">{row.period}</TableCell>
                  <TableCell className="px-3 py-2">{row.crewService}</TableCell>
                  <TableCell className="px-3 py-2">{row.paxService}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="px-6 py-10 text-sm text-gray-500">
            Seus voos e respectivos serviços aparecerão aqui.
          </div>
        )}
      </div>
    </div>
  );
}

function normalizeDate(value: string) {
  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return value;

  const brazilMatch = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (brazilMatch) return `${brazilMatch[3]}-${brazilMatch[2]}-${brazilMatch[1]}`;

  return value;
}

function formatDate(value: string) {
  const normalized = normalizeDate(value);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value || '-';

  return `${match[3]}/${match[2]}/${match[1]}`;
}

function isCurrentMonth(value: string, monthIso: string) {
  const rowDate = normalizeDate(value);

  return Boolean(rowDate) && rowDate.startsWith(`${monthIso}-`);
}

function getMonthOptions(rows: FlightMenuRow[], selectedMonth: string) {
  const months = rows
    .map((row) => normalizeDate(row.date).slice(0, 7))
    .filter((month) => /^\d{4}-\d{2}$/.test(month));

  if (/^\d{4}-\d{2}$/.test(selectedMonth)) {
    months.push(selectedMonth);
  }

  return [...new Set(months)].sort((left, right) => right.localeCompare(left));
}

function formatMonth(monthIso: string) {
  const [year, month] = monthIso.split('-').map(Number);
  if (!year || !month) return monthIso;

  return new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function getFlightTableSummary({
  rows,
  selectedRowIds,
  visibleRows,
}: {
  rows: FlightMenuRow[];
  selectedRowIds: string[];
  visibleRows: FlightMenuRow[];
}) {
  if (visibleRows.length === 0) {
    return rows.length === 0
      ? 'Envie sua escala para carregar seus voos e aplicar os serviços de bordo disponíveis.'
      : 'Nenhum voo encontrado para o mês selecionado.';
  }

  return `${visibleRows.length} ${visibleRows.length === 1 ? 'voo' : 'voos'}${
    selectedRowIds.length > 0
      ? `, ${selectedRowIds.length} selecionado${selectedRowIds.length === 1 ? '' : 's'}.`
      : '.'
  }`;
}

function isToday(value: string, today: string) {
  return normalizeDate(value) === today;
}

function getTodayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function getCurrentMonthIso() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');

  return `${year}-${month}`;
}
