/**
 * High-Performance Trie (Prefix Tree) Data Structure
 * Enables O(K) sub-millisecond file path, symbol, and slash-command auto-complete.
 */
class TrieNode {
  constructor() {
    this.children = new Map();
    this.isEndOfWord = false;
    this.metadata = null;
  }
}

export class TrieAutocomplete {
  constructor() {
    this.root = new TrieNode();
    this.itemsCount = 0;
  }

  /**
   * Inserts a key (e.g. "@server.js" or "/clear") into the Trie with metadata
   */
  insert(key, metadata = {}) {
    if (!key || typeof key !== 'string') return;
    let current = this.root;
    const lowerKey = key.toLowerCase();

    for (let i = 0; i < lowerKey.length; i++) {
      const char = lowerKey[i];
      if (!current.children.has(char)) {
        current.children.set(char, new TrieNode());
      }
      current = current.children.get(char);
    }

    if (!current.isEndOfWord) {
      this.itemsCount++;
    }
    current.isEndOfWord = true;
    current.metadata = { key, ...metadata };
  }

  /**
   * Searches for all items matching a prefix (e.g. "@serv")
   * Returns up to `limit` suggestions in O(K) time
   */
  searchPrefix(prefix, limit = 10) {
    if (!prefix || typeof prefix !== 'string') return [];
    let current = this.root;
    const lowerPrefix = prefix.toLowerCase();

    for (let i = 0; i < lowerPrefix.length; i++) {
      const char = lowerPrefix[i];
      if (!current.children.has(char)) {
        return []; // No matches found
      }
      current = current.children.get(char);
    }

    const results = [];
    this._collectAllWords(current, results, limit);
    return results;
  }

  _collectAllWords(node, results, limit) {
    if (results.length >= limit) return;
    if (node.isEndOfWord && node.metadata) {
      results.push(node.metadata);
    }

    for (const childNode of node.children.values()) {
      if (results.length >= limit) break;
      this._collectAllWords(childNode, results, limit);
    }
  }

  /**
   * Clears the Trie
   */
  clear() {
    this.root = new TrieNode();
    this.itemsCount = 0;
  }
}
