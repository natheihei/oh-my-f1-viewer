/**
 * Encrypted-at-rest storage for the account token and cookies, using Electron's `safeStorage`
 * (DPAPI on Windows, Keychain on macOS, libsecret on Linux). Falls back to plain text only when the
 * OS cannot provide encryption. Files written by older versions (plain JSON) are still readable and
 * are upgraded the next time they are written. `safeStorage` is injected so this stays testable.
 */

const fs = require('fs');
const path = require('path');

const FORMAT = 'f1ov-safestorage-v1';

function createSecureStore(safeStorage) {
  const available = async () => {
    try {
      return !!safeStorage && (await safeStorage.isAsyncEncryptionAvailable());
    } catch (_) {
      return false;
    }
  };

  // Encrypting is async, so two writes to one file could otherwise finish out of order and leave the
  // older text on disk. Writes and removals of each file run one after another, in call order.
  const queues = new Map();
  const enqueue = (filePath, task) => {
    const run = (queues.get(filePath) || Promise.resolve()).then(task);
    const tail = run.catch(() => {});
    queues.set(filePath, tail);
    tail.then(() => {
      if (queues.get(filePath) === tail) queues.delete(filePath);
    });
    return run;
  };

  return {
    isEncryptionAvailable: available,

    /** Atomically writes `text`, encrypted when possible. Rejects on I/O errors. */
    writeText(filePath, text) {
      return enqueue(filePath, async () => {
        const body = (await available())
          ? JSON.stringify({ format: FORMAT, data: (await safeStorage.encryptStringAsync(String(text))).toString('base64') })
          : String(text);
        const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
        fs.writeFileSync(tmp, body, 'utf8');
        fs.renameSync(tmp, filePath);
      });
    },

    /** Deletes the file if it exists, after any write to it that is still in flight. */
    remove(filePath) {
      return enqueue(filePath, () => {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      });
    },

    /**
     * @returns {Promise<{text:string, encrypted:boolean, shouldReEncrypt?:boolean}|null>} null when the
     * file is missing or cannot be decrypted (e.g. copied from another machine/user); `encrypted:false`
     * marks a legacy plain file, and `shouldReEncrypt` a file whose key the OS has since rotated.
     */
    async readText(filePath) {
      let raw;
      try {
        if (!fs.existsSync(filePath)) return null;
        raw = fs.readFileSync(filePath, 'utf8');
      } catch (_) {
        return null;
      }
      let envelope = null;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.format === FORMAT) envelope = parsed;
      } catch (_) {}
      if (!envelope) return { text: raw, encrypted: false };
      try {
        if (!(await available()) || typeof envelope.data !== 'string') return null;
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(envelope.data, 'base64'));
        return { text: result, encrypted: true, shouldReEncrypt: !!shouldReEncrypt };
      } catch (_) {
        return null;
      }
    },
  };
}

module.exports = { createSecureStore, FORMAT };
