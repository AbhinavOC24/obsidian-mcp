/**
 * Local embedding model using @huggingface/transformers (WASM/pure-JS backend).
 *
 * Model: Xenova/all-MiniLM-L6-v2  (~23 MB, 384 dimensions)
 * Uses the ONNX WASM backend — no native binary required, works on Node 25+.
 * Downloaded once to TRANSFORMERS_CACHE on first use.
 *
 * If the model fails to load for any reason, all functions become no-ops and
 * semantic search is silently disabled (full-text search still works).
 */

// Lazy state
let embedder: ((text: string, options?: Record<string, unknown>) => Promise<{ data: Float32Array }>) | null = null;
let modelReady = false;
let modelFailed = false;
let loadPromise: Promise<void> | null = null;

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";

async function loadModel(): Promise<void> {
  if (modelReady || modelFailed) return;

  // Deduplicate concurrent callers
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const { pipeline, env } = await import("@huggingface/transformers");

      // Use WASM/CPU backend — no native binary needed
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
      }
      if (process.env["TRANSFORMERS_CACHE"]) {
        env.cacheDir = process.env["TRANSFORMERS_CACHE"];
      }

      console.error(`[embeddings] Loading ${MODEL_NAME} (first run downloads ~23 MB)…`);
      const pipe = await pipeline("feature-extraction", MODEL_NAME, {
        // Force WASM backend so we never try to load native onnxruntime-node
        device: "cpu",
        dtype: "fp32",
      });

      embedder = pipe as typeof embedder;
      modelReady = true;
      console.error("[embeddings] Model ready — semantic search enabled.");
    } catch (err) {
      modelFailed = true;
      console.error("[embeddings] Model load failed — semantic search disabled. FTS still works.", err);
    }
  })();

  return loadPromise;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Embed a text string → 384-dim Float32Array.
 * Throws if the model is unavailable.
 */
export async function embedText(text: string): Promise<Float32Array> {
  await loadModel();
  if (!embedder || !modelReady) {
    throw new Error("Embedding model not available");
  }
  const output = await embedder(text, { pooling: "mean", normalize: true });
  return output.data;
}

/** Serialise Float32Array → Buffer for SQLite BLOB storage. */
export function vectorToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Deserialise Buffer from SQLite → Float32Array. */
export function blobToVector(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Cosine similarity between two Float32Arrays.
 * Pure-JS fallback — used when sqlite-vec is not loaded.
 * Returns value in [-1, 1]; higher = more similar.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/** Returns true if the embedding model loaded successfully. */
export function isEmbeddingReady(): boolean {
  return modelReady;
}

/** Kick off model loading in the background during server startup. */
export function warmUpEmbeddings(): void {
  loadModel().catch(() => { /* already logged */ });
}
