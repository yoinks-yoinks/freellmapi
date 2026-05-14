import './env.js';
import { createApp } from './app.js';
import { initDb, getDb } from './db/index.js';
import { startHealthChecker } from './services/health.js';
import { getProvider } from './providers/index.js';
import { decrypt } from './lib/crypto.js';
import { OpenAICompatProvider } from './providers/openai-compat.js';

const PORT = process.env.PORT ?? 3001;

/**
 * On first boot (or after image update), if NVIDIA has only 1 model in the
 * DB (the stale seeded row), fetch the live model list and upsert everything.
 * Errors are non-fatal — the server continues without a fresh model list.
 */
async function syncNvidiaModelsIfNeeded(): Promise<void> {
  try {
    const db = getDb();
    const { cnt } = db.prepare(
      `SELECT COUNT(*) AS cnt FROM models WHERE platform = 'nvidia'`,
    ).get() as { cnt: number };
    if (cnt > 1) return; // already synced or manually populated

    const keyRow = db.prepare(
      `SELECT encrypted_key, iv, auth_tag
       FROM api_keys
       WHERE platform = 'nvidia' AND enabled = 1
       ORDER BY id DESC LIMIT 1`,
    ).get() as { encrypted_key: string; iv: string; auth_tag: string } | undefined;
    if (!keyRow) return; // no NVIDIA key configured

    const provider = getProvider('nvidia');
    if (!(provider instanceof OpenAICompatProvider)) return;

    const apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
    console.log('[startup] NVIDIA key found, syncing model list\u2026');

    const modelIds = await provider.listModels(apiKey);
    if (modelIds.length === 0) return;

    const upsert = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
      VALUES (?, ?, ?, 50, 50, '', 1)
      ON CONFLICT(platform, model_id) DO UPDATE SET enabled = 1
    `);
    for (const modelId of modelIds) {
      upsert.run('nvidia', modelId, modelId);
    }

    // Disable models not returned by the live API (e.g. the stale seeded row).
    const placeholders = modelIds.map(() => '?').join(',');
    db.prepare(
      `UPDATE models SET enabled = 0 WHERE platform = 'nvidia' AND model_id NOT IN (${placeholders})`,
    ).run(...modelIds);

    console.log(`[startup] NVIDIA sync complete \u2014 ${modelIds.length} models upserted`);
  } catch (err) {
    console.warn('[startup] NVIDIA model sync failed (non-fatal):', err);
  }
}

async function main() {
  initDb();
  const app = createApp();

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    console.log(`Proxy endpoint: http://0.0.0.0:${PORT}/v1/chat/completions`);
    startHealthChecker();
  });

  await syncNvidiaModelsIfNeeded();
}

main().catch(console.error);
