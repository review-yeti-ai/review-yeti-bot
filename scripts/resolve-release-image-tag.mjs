import { pathToFileURL } from 'node:url';

const releaseSubject = /^chore\(main\): release ([0-9]+\.[0-9]+\.[0-9]+)(?: \(#[1-9][0-9]*\))?$/u;

export function resolveReleaseImageTag(subject) {
  const match = String(subject || '').match(releaseSubject);
  return match ? `v${match[1]}` : '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(resolveReleaseImageTag(process.argv[2]));
}
