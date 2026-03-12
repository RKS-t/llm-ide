import { Indexer, CodeChunk } from './Indexer'

export class Retriever {
  private indexer: Indexer

  constructor(indexer: Indexer) {
    this.indexer = indexer
  }

  async search(query: string, topK: number = 5): Promise<CodeChunk[]> {
    const chunks = this.indexer.getChunks()
    if (chunks.length === 0) return []

    const queryEmbedding = await this.indexer.embed(query)

    const scored = chunks.map(chunk => ({
      chunk,
      score: this.cosineSimilarity(queryEmbedding, chunk.embedding ?? [])
    }))

    return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(s => s.chunk)
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || b.length === 0) return 0
    const dot = a.reduce((sum, val, i) => sum + val * (b[i] ?? 0), 0)
    const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0))
    const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0))
    return normA && normB ? dot / (normA * normB) : 0
  }
}