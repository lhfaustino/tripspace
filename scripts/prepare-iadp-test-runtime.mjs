import { mkdir, writeFile } from 'node:fs/promises';

const outputDirectory = '.iadp-analysis/iadp-tests';
await mkdir(outputDirectory, { recursive: true });
await writeFile(`${outputDirectory}/package.json`, '{"type":"commonjs"}\n', 'utf8');
