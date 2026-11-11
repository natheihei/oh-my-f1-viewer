/** The stable install id sign-in needs. pi keeps the credentials themselves: see agent.ts. */
import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** OpenAI's login asks for a stable id for this installation. */
export function installId(): string {
  const file = path.join(app.getPath('userData'), 'f1a-install-id');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim().replace(/^urn:uuid:/, '');
    if (existing) return existing;
  } catch {
    // First run.
  }
  const id = randomUUID();
  fs.writeFileSync(file, id, { mode: 0o600 });
  return id;
}
