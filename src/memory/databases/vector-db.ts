/**
 * Vector database abstraction interface
 */

export interface SearchResult {
  id: string;
  score: number;
  metadata: Record<string, any>;
  content?: string;
}

export interface VectorDB {
  /**
   * Connect to the vector database
   */
  connect(): Promise<void>;

  /**
   * Index a new vector with metadata
   * @param embedding Vector embedding
   * @param metadata Associated metadata
   * @returns Document ID
   */
  index(embedding: number[], metadata: any): Promise<string>;

  /**
   * Search for similar vectors
   * @param embedding Query vector
   * @param limit Maximum results to return
   * @param filter Optional metadata filter
   * @returns Search results sorted by similarity
   */
  search(
    embedding: number[], 
    limit: number,
    filter?: Record<string, any>
  ): Promise<SearchResult[]>;

  /**
   * Update metadata for a document
   * @param id Document ID
   * @param metadata New metadata
   */
  updateMetadata(id: string, metadata: any): Promise<void>;

  /**
   * Delete a document
   * @param id Document ID
   */
  delete(id: string): Promise<void>;

  /**
   * Close database connection
   */
  close(): Promise<void>;
}