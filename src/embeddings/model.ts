/**
 * Embedding model — semantic search layer using @huggingface/transformers.
 *
 * Model: Xenova/all-MiniLM-L6-v2  (~23 MB, 384 dimensions)
 * Downloaded once to cache on first use.
 */

import { pipeline, env } from "@huggingface/transformers";

let embedder: any = null;
let modelReady = false;
let loadPromise: Promise<void> | null = null;

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";

async function loadModel(): Promise<void> {
  if (modelReady || loadPromise) return loadPromise ?? undefined;

  loadPromise = (async () => {
    try {
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
      }
      if (process.env["TRANSFORMERS_CACHE"]) {
        env.cacheDir = process.env["TRANSFORMERS_CACHE"];
      }

      console.error(`[embeddings] Loading ${MODEL_NAME}…`);
      
      // Force CPU execution to keep it simple and stable across architectures
      embedder = await pipeline("feature-extraction", MODEL_NAME, {
        device: "cpu",
        dtype: "fp32",
      });

      modelReady = true;
      console.error("[embeddings] Semantic search enabled.");
    } catch (err: any) {
      console.error("[embeddings] Failed to load model — semantic search disabled:", err?.message || err);
    }
  })();

  return loadPromise;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function embedText(text: string): Promise<Float32Array> {
  await loadModel();
  if (!embedder) throw new Error("Embedding model not available");
  const output = await embedder(text, { pooling: "mean", normalize: true });
  return output.data;
}

export function vectorToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function blobToVector(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

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

export function isEmbeddingReady(): boolean { return modelReady; }

export function warmUpEmbeddings(): void {
  loadModel().catch(() => { /* handled */ });
}
