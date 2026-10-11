import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const sourcePath = process.argv[2];
const destinationPath = process.argv[3] ?? '.iadp-analysis/iadp-events.anonymized.json';
const saltPath = process.argv[4] ?? '.iadp-analysis/iadp-anonymization-salt';

if (!sourcePath) {
  console.error(
    'Uso: npm run iadp:anonymize-events -- <captura.har> [fixture.json] [salt-local]'
  );
  process.exitCode = 1;
} else {
  await anonymizeEventsFixture(sourcePath, destinationPath, saltPath);
}

async function anonymizeEventsFixture(source, destination, localSaltPath) {
  const har = JSON.parse(await readFile(source, 'utf8'));
  const entries = Array.isArray(har?.log?.entries) ? har.log.entries : [];
  const eventEntries = entries.filter((entry) => {
    try {
      return new URL(entry?.request?.url).pathname.endsWith('/events') && entry?.response?.status === 200;
    } catch {
      return false;
    }
  });
  const selected = eventEntries.at(-1);
  if (!selected?.response?.content?.text) {
    throw new Error('Nenhuma resposta completa de /events com status 200 foi encontrada no HAR.');
  }

  const payload = JSON.parse(selected.response.content.text);
  if (!Array.isArray(payload?.result?.events)) {
    throw new Error('A resposta de /events nao contem result.events.');
  }

  const salt = await loadOrCreateSalt(localSaltPath);
  const fixture = createAnonymizer(salt).anonymize(payload);
  assertSourceIdentifiersReplaced(payload, fixture);
  assertSafeFixture(fixture);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  console.log(`Fixture IADP anonimizada gravada em ${destination}`);
  console.log(`Chave local reutilizada em ${localSaltPath} (o valor nao foi exibido).`);
}

async function loadOrCreateSalt(path) {
  try {
    const salt = (await readFile(path, 'utf8')).trim();
    if (salt.length < 32) throw new Error(`A chave local em ${path} e invalida.`);
    return salt;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  await mkdir(dirname(path), { recursive: true });
  const generated = randomBytes(32).toString('hex');
  try {
    await writeFile(path, `${generated}\n`, { encoding: 'utf8', flag: 'wx' });
    return generated;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return (await readFile(path, 'utf8')).trim();
  }
}

function createAnonymizer(salt) {
  function digest(category, value, length = 20) {
    return createHmac('sha256', salt)
      .update(category)
      .update('\0')
      .update(String(value))
      .digest('hex')
      .slice(0, length);
  }

  function numericToken(category, value) {
    return Number.parseInt(digest(category, value, 12), 16);
  }

  function lettersToken(category, value, width) {
    let current = BigInt(`0x${digest(category, value, 16)}`);
    let output = '';
    for (let index = 0; index < width; index += 1) {
      output = String.fromCharCode(65 + Number(current % 26n)) + output;
      current /= 26n;
    }
    return output;
  }

  function anonymize(value, key = '', path = []) {
    if (value === null || value === undefined || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map((item) => anonymize(item, '', [...path, key]));
    if (typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([childKey, childValue]) => [
          childKey,
          anonymize(childValue, childKey, [...path, key]),
        ])
      );
    }
    if (typeof value === 'number') {
      if (key === 'id') return numericToken('event-id', value);
      if (key === 'year') return value + 8;
      if (key === 'month') return value;
      return 1;
    }

    const source = String(value);
    if (source === '') return source;
    if (isTimestamp(source)) return shiftTimestampYear(source, 8);
    if (key === 'id') return `synthetic-event-${digest('event-id', source)}`;
    if (key === 'airportCode') return lettersToken('airport', source, 3);
    if (key === 'flightNumber') {
      return `G3 ${String(numericToken('flight', source) % 10_000).padStart(4, '0')}`;
    }
    if (key === 'logicalId' || key === 'logicalIdRelatedEvent' || key === 'calLink2RosterEvtId') {
      return `synthetic-logical-${digest('logical-id', source)}`;
    }
    if (key === 'aircraftTypeCode' || key === 'aircraftSubType' || key === 'acReg' || key === 'registration') {
      return `SYN${digest('aircraft', source, 8).toUpperCase()}`;
    }
    if (key === 'pairingNumber') return `SYN-P${digest('pairing', source, 10).toUpperCase()}`;
    if (key === 'groundActivityCode' || key === 'type' || key === 'originalEventType' || key === 'displayType') {
      return source;
    }
    if (key.endsWith('Uri')) return 'https://example.invalid/synthetic-asset';
    if ([...path, key].some((part) => ['description', 'fromText', 'toText', 'text'].includes(part))) {
      return `synthetic-text-${digest('text', source)}`;
    }
    return `synthetic-${key || 'value'}-${digest(`generic:${key}`, source)}`;
  }

  return { anonymize };
}

function isTimestamp(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

function shiftTimestampYear(value, years) {
  return `${Number(value.slice(0, 4)) + years}${value.slice(4)}`;
}

function assertSafeFixture(fixture) {
  const serialized = JSON.stringify(fixture);
  const forbidden = [
    /Bearer\s/i,
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
    /[^\s"@]+@[^\s"@]+\.[^\s"@]+/,
    /"(?:access_token|refresh_token|id_token|authorization|cookie|crewCode|crmId)"\s*:/i,
  ];
  if (forbidden.some((pattern) => pattern.test(serialized))) {
    throw new Error('A fixture anonimizada falhou na verificacao de dados sensiveis.');
  }
}

function assertSourceIdentifiersReplaced(source, fixture) {
  const identifierKeys = new Set(['id', 'logicalId', 'logicalIdRelatedEvent', 'calLink2RosterEvtId']);

  function visit(sourceValue, fixtureValue, key = '') {
    if (identifierKeys.has(key) && sourceValue !== null && sourceValue !== undefined) {
      if (String(sourceValue) === String(fixtureValue)) {
        throw new Error(`O identificador de origem no campo ${key} nao foi substituido.`);
      }
      return;
    }
    if (Array.isArray(sourceValue) && Array.isArray(fixtureValue)) {
      sourceValue.forEach((value, index) => visit(value, fixtureValue[index]));
      return;
    }
    if (sourceValue && typeof sourceValue === 'object' && fixtureValue) {
      Object.keys(sourceValue).forEach((childKey) => {
        visit(sourceValue[childKey], fixtureValue[childKey], childKey);
      });
    }
  }

  visit(source, fixture);
}
