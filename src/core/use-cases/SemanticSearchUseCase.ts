import { IItemRepository } from '../../core/repositories/IItemRepository';
import { IUserRepository } from '../../core/repositories/IUserRepository';
import { Result } from '../../shared/types/result';
import { DomainError, ValidationError } from '../../shared/types/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { redis } from '../../infrastructure/database/redis';
import { OpenAIClient } from '../../infrastructure/ai/OpenAIClient';

export interface SearchFilters {
  type?: 'book' | 'paper' | 'article';
  status?: 'PLANNED' | 'READING' | 'COMPLETED' | 'DNF';
  author?: string;
  tags?: string[];
  rating?: number;
  userId?: string; // For filtering by specific user
  dateRange?: {
    start: Date;
    end: Date;
  };
}

export interface SearchResult {
  item: {
    id: string;
    title: string;
    author?: string;
    type: string;
    status: string;
    rating?: number;
    summary?: string;
    url?: string;
    createdAt: Date;
    user: {
      id: string;
      username: string;
      displayName?: string;
    };
  };
  score: number;
  matchType: 'vector' | 'keyword' | 'hybrid';
  explanation: string;
}

export interface SemanticSearchResult {
  results: SearchResult[];
  totalCount: number;
  hasMore: boolean;
  query: string;
  executionTime: number;
  searchId: string;
}

export class SemanticSearchUseCase {
  private readonly RRF_K = 60; // RRF constant
  private readonly MIN_CONFIDENCE_THRESHOLD = 0.1;
  private readonly SEMANTIC_WEIGHT = 0.6;
  private readonly KEYWORD_WEIGHT = 0.4;

  constructor(
    private readonly itemRepository: IItemRepository,
    private readonly userRepository: IUserRepository
  ) {}

  async search(
    query: string,
    options: {
      limit?: number;
      cursor?: string;
      filters?: SearchFilters;
      includeSemantic?: boolean;
    } = {}
  ): Promise<Result<SemanticSearchResult, DomainError>> {
    try {
      const startTime = Date.now();
      const {
        limit = 20,
        cursor,
        filters,
        includeSemantic = true,
      } = options;

      // Validate query
      if (!query || query.trim().length === 0) {
        return Result.err(new ValidationError('Query cannot be empty', 'query'));
      }

      if (query.length > 200) {
        return Result.err(new ValidationError('Query too long', 'query'));
      }

      const searchId = this.generateSearchId(query, filters);

      // Check cache first
      const cachedResults = await this.getCachedResults(searchId);
      if (cachedResults) {
        return Result.ok(cachedResults);
      }

      // Perform parallel searches
      const [keywordResults, semanticResults] = await Promise.all([
        this.performKeywordSearch(query, filters, limit),
        includeSemantic ? this.performSemanticSearch(query, filters, limit) : null,
      ]);

      // Apply RRF fusion
      const fusedResults = this.applyRRF(
        keywordResults,
        semanticResults,
        limit
      );

      // Add explanations and metadata
      const enrichedResults = fusedResults.map((result, index) => ({
        ...result,
        score: result.score * (1 - (index * 0.05)), // Position bias
        explanation: this.generateExplanation(result.matchType, query),
      }));

      const executionTime = Date.now() - startTime;

      const searchResult: SemanticSearchResult = {
        results: enrichedResults,
        totalCount: enrichedResults.length,
        hasMore: enrichedResults.length === limit,
        query,
        executionTime,
        searchId,
      };

      // Cache results (short TTL for fresh search results)
      await this.cacheResults(searchId, searchResult, 60); // 1 minute cache

      return Result.ok(searchResult);
    } catch (error) {
      console.error('Semantic search failed:', error);
      return Result.err(
        new DomainError('SEARCH_ERROR', 'Search operation failed', { error })
      );
    }
  }

  private async performKeywordSearch(
    query: string,
    filters?: SearchFilters,
    limit: number = 20
  ): Promise<Array<{ id: string; score: number; type: 'keyword' }>> {
    try {
      // Build Prisma query with full-text search
      const whereClause: any = {
        AND: [],
      };

      // Add text search
      if (query.trim()) {
        whereClause.AND.push({
          OR: [
            { title: { contains: query, mode: 'insensitive' } },
            { author: { contains: query, mode: 'insensitive' } },
            { summary: { contains: query, mode: 'insensitive' } },
            { notes: { contains: query, mode: 'insensitive' } },
            { tags: { hasSome: [query] } },
          ],
        });
      }

      // Apply filters
      if (filters?.type) {
        whereClause.AND.push({ type: filters.type });
      }
      if (filters?.status) {
        whereClause.AND.push({ status: filters.status });
      }
      if (filters?.author) {
        whereClause.AND.push({ author: { contains: filters.author, mode: 'insensitive' } });
      }
      if (filters?.rating !== undefined) {
        whereClause.AND.push({ rating: { gte: filters.rating } });
      }
      if (filters?.userId) {
        whereClause.AND.push({ userId: filters.userId });
      }
      if (filters?.dateRange) {
        whereClause.AND.push({
          createdAt: {
            gte: filters.dateRange.start,
            lte: filters.dateRange.end,
          },
        });
      }

      const items = await prisma.item.findMany({
        where: whereClause,
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
            },
          },
        },
        take: limit,
        orderBy: {
          createdAt: 'desc',
        },
      });

      return items.map((item, index) => ({
        id: item.id,
        score: this.calculateKeywordScore(item, query, index),
        type: 'keyword' as const,
      }));
    } catch (error) {
      console.error('Keyword search failed:', error);
      return [];
    }
  }

  private async performSemanticSearch(
    query: string,
    filters?: SearchFilters,
    limit: number = 20
  ): Promise<Array<{ id: string; score: number; type: 'vector' }>> {
    try {
      // Generate embedding for query
      const embeddingResult = await OpenAIClient.generateEmbedding(query);
      const queryEmbedding = embeddingResult.embedding;

      // Search using cosine similarity (requires pgvector)
      const whereClause: any = {
        AND: [
          { embedding: { not: null } }, // Only items with embeddings
          { embeddingGeneratedAt: { not: null } },
        ],
      };

      // Apply basic filters
      if (filters?.type) {
        whereClause.AND.push({ type: filters.type });
      }
      if (filters?.status) {
        whereClause.AND.push({ status: filters.status });
      }
      if (filters?.userId) {
        whereClause.AND.push({ userId: filters.userId });
      }

      // Use raw SQL for vector similarity search
      const results = await prisma.$queryRaw<
        Array<{
          id: string;
          score: number;
        }>
      >`
        SELECT 
          i.id,
          (1 - (i.embedding <=> ${JSON.stringify(queryEmbedding)})) as score
        FROM "Item" i
        WHERE 
          ${whereClause.AND.length > 0 ? prisma.join(
            whereClause.AND.map((condition: any, index: number) => {
              if (condition.type) {
                return prisma.raw(`i."type" = '${condition.type}'`);
              }
              if (condition.status) {
                return prisma.raw(`i."status" = '${condition.status}'`);
              }
              if (condition.userId) {
                return prisma.raw(`i."userId" = '${condition.userId}'`);
              }
              return prisma.raw('1=1'); // Always true condition
            })
          ) : prisma.raw('1=1')}
          AND i.embedding IS NOT NULL
          AND i."embeddingGeneratedAt" IS NOT NULL
        ORDER BY i.embedding <=> ${JSON.stringify(queryEmbedding)}
        LIMIT ${limit}
      `;

      return results.map(result => ({
        id: result.id,
        score: result.score,
        type: 'vector' as const,
      }));
    } catch (error) {
      console.error('Semantic search failed:', error);
      return [];
    }
  }

  private applyRRF(
    keywordResults: Array<{ id: string; score: number; type: 'keyword' }>,
    semanticResults: Array<{ id: string; score: number; type: 'vector' }> | null,
    limit: number
  ): Array<{ id: string; score: number; matchType: 'keyword' | 'vector' | 'hybrid' }> {
    const itemScores = new Map<string, {
      keywordRank: number;
      semanticRank: number;
      keywordScore: number;
      semanticScore: number;
    }>();

    // Process keyword results
    keywordResults.forEach((result, index) => {
      const existing = itemScores.get(result.id) || {
        keywordRank: 0,
        semanticRank: Infinity,
        keywordScore: 0,
        semanticScore: 0,
      };
      itemScores.set(result.id, {
        ...existing,
        keywordRank: index + 1,
        keywordScore: result.score,
      });
    });

    // Process semantic results
    if (semanticResults) {
      semanticResults.forEach((result, index) => {
        const existing = itemScores.get(result.id) || {
          keywordRank: Infinity,
          semanticRank: 0,
          keywordScore: 0,
          semanticScore: 0,
        };
        itemScores.set(result.id, {
          ...existing,
          semanticRank: index + 1,
          semanticScore: result.score,
        });
      });
    }

    // Calculate RRF scores
    const fusedResults = Array.from(itemScores.entries())
      .map(([id, scores]) => {
        const keywordRRF = 1 / (this.RRF_K + scores.keywordRank);
        const semanticRRF = 1 / (this.RRF_K + scores.semanticRank);
        
        const fusedScore = 
          (this.KEYWORD_WEIGHT * keywordRRF) + 
          (this.SEMANTIC_WEIGHT * semanticRRF);

        const matchType: 'keyword' | 'vector' | 'hybrid' = 
          scores.keywordRank === 0 ? 'vector' :
          scores.semanticRank === Infinity ? 'keyword' : 'hybrid';

        return {
          id,
          score: fusedScore,
          matchType,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return fusedResults;
  }

  private calculateKeywordScore(item: any, query: string, position: number): number {
    let score = 1.0;
    const queryLower = query.toLowerCase();
    
    // Title match bonus
    if (item.title?.toLowerCase().includes(queryLower)) {
      score += 2.0;
    }
    
    // Author match bonus
    if (item.author?.toLowerCase().includes(queryLower)) {
      score += 1.5;
    }
    
    // Tag match bonus
    if (item.tags?.some((tag: string) => tag.toLowerCase().includes(queryLower))) {
      score += 1.0;
    }
    
    // Position penalty (later results get lower scores)
    score -= position * 0.1;
    
    return Math.max(score, 0);
  }

  private generateExplanation(matchType: 'keyword' | 'vector' | 'hybrid', query: string): string {
    switch (matchType) {
      case 'keyword':
        return `Found items matching "${query}" by title, author, or tags`;
      case 'vector':
        return `Found semantically similar items to "${query}"`;
      case 'hybrid':
        return `Found items matching "${query}" using both semantic similarity and keyword matching`;
      default:
        return 'Search results';
    }
  }

  private generateSearchId(query: string, filters?: SearchFilters): string {
    const queryHash = Buffer.from(query).toString('base64').slice(0, 16);
    const filtersHash = Buffer.from(JSON.stringify(filters || {})).toString('base64').slice(0, 8);
    return `search:${queryHash}:${filtersHash}`;
  }

  private async getCachedResults(searchId: string): Promise<SemanticSearchResult | null> {
    try {
      const cached = await redis.get(`search:${searchId}`);
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      console.error('Failed to get cached search results:', error);
      return null;
    }
  }

  private async cacheResults(
    searchId: string,
    results: SemanticSearchResult,
    ttlSeconds: number
  ): Promise<void> {
    try {
      await redis.setex(`search:${searchId}`, ttlSeconds, JSON.stringify(results));
    } catch (error) {
      console.error('Failed to cache search results:', error);
    }
  }

  // Health check for the search system
  async getHealthStatus(): Promise<{
    semanticEnabled: boolean;
    openAIHealthy: boolean;
    cacheHealthy: boolean;
    avgResponseTime: number;
  }> {
    try {
      const startTime = Date.now();
      
      // Test OpenAI connection
      const openAIStatus = OpenAIClient.getHealthStatus();
      
      // Test Redis
      await redis.ping();
      
      return {
        semanticEnabled: true,
        openAIHealthy: openAIStatus.isHealthy,
        cacheHealthy: true,
        avgResponseTime: Date.now() - startTime,
      };
    } catch (error) {
      return {
        semanticEnabled: false,
        openAIHealthy: false,
        cacheHealthy: false,
        avgResponseTime: 0,
      };
    }
  }
}