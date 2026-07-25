/**
 * Bounded Float32 LRU Vector Memory Cache
 * Keeps vector memory usage fixed (< 50 MB RAM) by automatically evicting least recently used chunks.
 */
export class LRUVectorCache {
  constructor(maxSizeMB = 50) {
    this.maxSizeBytes = maxSizeMB * 1024 * 1024;
    this.currentSizeBytes = 0;
    this.cache = new Map(); // key: chunkId -> { data, sizeBytes, lastAccessed }
  }

  /**
   * Adds or updates a chunk in LRU cache
   */
  set(chunkId, chunkData) {
    if (!chunkId || !chunkData) return;

    // Estimate size of Float32 array + metadata string
    const vectorBytes = chunkData.embedding ? chunkData.embedding.byteLength : 0;
    const contentBytes = chunkData.content ? chunkData.content.length * 2 : 0;
    const itemSizeBytes = vectorBytes + contentBytes + 200;

    // Evict old entries if cache will exceed max size
    while (this.currentSizeBytes + itemSizeBytes > this.maxSizeBytes && this.cache.size > 0) {
      this._evictLRU();
    }

    if (this.cache.has(chunkId)) {
      const old = this.cache.get(chunkId);
      this.currentSizeBytes -= old.sizeBytes;
    }

    this.cache.set(chunkId, {
      data: chunkData,
      sizeBytes: itemSizeBytes,
      lastAccessed: Date.now()
    });
    this.currentSizeBytes += itemSizeBytes;
  }

  /**
   * Retrieves a chunk and updates access time
   */
  get(chunkId) {
    if (!this.cache.has(chunkId)) return null;
    const entry = this.cache.get(chunkId);
    entry.lastAccessed = Date.now();
    return entry.data;
  }

  /**
   * Evicts the least recently used entry
   */
  _evictLRU() {
    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.cache.get(oldestKey);
      this.currentSizeBytes -= entry.sizeBytes;
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Returns all active chunks as array
   */
  getAll() {
    const list = [];
    for (const entry of this.cache.values()) {
      list.push(entry.data);
    }
    return list;
  }

  clear() {
    this.cache.clear();
    this.currentSizeBytes = 0;
  }

  get stats() {
    return {
      count: this.cache.size,
      sizeMB: (this.currentSizeBytes / (1024 * 1024)).toFixed(2),
      maxMB: (this.maxSizeBytes / (1024 * 1024)).toFixed(2)
    };
  }
}
