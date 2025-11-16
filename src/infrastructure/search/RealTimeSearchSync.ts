import { prisma } from '../database/prisma';
import { redis } from '../database/redis';
import pino from 'pinnt';
import { z } from 'zod';

// Types for real-time search sync
export interface SearchSession {
  id: string;
  userId: string;
  query: string;
  filters: SearchFilters;
  results: SearchResult[];
  participants: Set<string>;
  createdAt: Date;
  lastActivity: Date;
  isActive: boolean;
  metadata?: {
    sessionName?: string;
    shareUrl?: string;
    allowAnonymous?: boolean;
    maxParticipants?: number;
  };
}

export interface SearchFilters {
  query: string;
  categories?: string[];
  authors?: string[];
  tags?: string[];
  dateRange?: {
    start: Date;
    end: Date;
  };
  minRating?: number;
  maxLength?: number;
  language?: string;
  sortBy?: 'relevance' | 'date' | 'rating' | 'popularity';
  sortOrder?: 'asc' | 'desc';
}

export interface SearchResult {
  id: string;
  title: string;
  author?: string;
  description?: string;
  url?: string;
  image?: string;
  rating?: number;
  tags: string[];
  category?: string;
  relevanceScore: number;
  metadata?: Record<string, any>;
}

export interface SearchSyncEvent {
  type: 'join' | 'leave' | 'query_change' | 'filter_change' | 'results_update' | 'result_select';
  userId: string;
  sessionId: string;
  data: any;
  timestamp: Date;
}

export interface SharedSearchInput {
  sessionId?: string;
  query: string;
  filters: Omit<SearchFilters, 'query'>;
  sessionName?: string;
  shareWith?: string[];
  allowAnonymous?: boolean;
  maxParticipants?: number;
}

export interface JoinSharedSearchInput {
  sessionId: string;
  userId: string;
  userInfo?: {
    name: string;
    avatar?: string;
  };
}

export interface SearchSyncResponse {
  session: SearchSession;
  results: SearchResult[];
  participants: Array<{
    userId: string;
    userInfo?: {
      name: string;
      avatar?: string;
    };
    joinedAt: Date;
    lastActivity: Date;
  }>;
  userRole: 'owner' | 'participant';
}

// Validation schemas
export const SharedSearchSchema = z.object({
  sessionId: z.string().optional(),
  query: z.string().min(1),
  filters: z.object({
    categories: z.array(z.string()).optional(),
    authors: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    dateRange: z.object({
      start: z.date(),
      end: z.date(),
    }).optional(),
    minRating: z.number().min(1).max(5).optional(),
    maxLength: z.number().optional(),
    language: z.string().optional(),
    sortBy: z.enum(['relevance', 'date', 'rating', 'popularity']).default('relevance'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  }),
  sessionName: z.string().optional(),
  shareWith: z.array(z.string()).uuid()).optional(),
  allowAnonymous: z.boolean().default(false),
  maxParticipants: z.number().min(2).max(50).default(10),
});

export const JoinSharedSearchSchema = z.object({
  sessionId: z.string(),
  userId: z.string().uuid(),
  userInfo: z.object({
    name: z.string(),
    avatar: z.string().optional(),
  }).optional(),
});

export class RealTimeSearchSync {
  private logger: pino.Logger;
  private sessions: Map<string, SearchSession> = new Map();
  private readonly SESSION_TTL = 3600; // 1 hour
  private readonly MAX_RESULTS = 50;
  private readonly BATCH_SIZE = 10;

  constructor() {
    this.logger = pino({
      level: process.env.LOG_LEVEL || 'info',
      transport: process.env.NODE_ENV === 'development' ? {
        target: 'pino-pretty',
        options: { colorize: true }
      } : undefined
    });

    // Clean up expired sessions periodically
    setInterval(() => {
      this.cleanupExpiredSessions();
    }, 300000); // Every 5 minutes
  }

  /**
   * Create a new shared search session
   */
  async createSharedSearch(input: SharedSearchInput): Promise<SearchSyncResponse> {
    try {
      const validatedInput = SharedSearchSchema.parse(input);
      const sessionId = input.sessionId || this.generateSessionId();

      // Check if session exists and user has access
      if (this.sessions.has(sessionId)) {
        const existing = this.sessions.get(sessionId)!;
        if (!existing.isActive) {
          throw new Error('Session has expired');
        }
        return this.joinSharedSearch({
          sessionId,
          userId: validatedInput.shareWith?.[0] || 'anonymous',
        });
      }

      // Perform initial search
      const results = await this.performSearch(validatedInput.query, {
        ...validatedInput.filters,
        query: validatedInput.query,
      });

      // Create session
      const session: SearchSession = {
        id: sessionId,
        userId: validatedInput.shareWith?.[0] || 'owner',
        query: validatedInput.query,
        filters: {
          ...validatedInput.filters,
          query: validatedInput.query,
        },
        results,
        participants: new Set(validatedInput.shareWith || []),
        createdAt: new Date(),
        lastActivity: new Date(),
        isActive: true,
        metadata: {
          sessionName: validatedInput.sessionName,
          allowAnonymous: validatedInput.allowAnonymous,
          maxParticipants: validatedInput.maxParticipants,
        },
      };

      // Store session
      this.sessions.set(sessionId, session);
      await this.cacheSession(session);

      // Add owner as participant
      session.participants.add(session.userId);

      this.logger.info('Shared search session created', {
        sessionId,
        userId: session.userId,
        query: session.query,
        resultsCount: results.length,
      });

      return {
        session,
        results,
        participants: [{
          userId: session.userId,
          userInfo: { name: 'Session Owner' },
          joinedAt: session.createdAt,
          lastActivity: session.lastActivity,
        }],
        userRole: 'owner',
      };

    } catch (error) {
      this.logger.error('Failed to create shared search', { input, error });
      throw error;
    }
  }

  /**
   * Join an existing shared search session
   */
  async joinSharedSearch(input: JoinSharedSearchInput): Promise<SearchSyncResponse> {
    try {
      const validatedInput = JoinSharedSearchSchema.parse(input);
      const session = this.sessions.get(validatedInput.sessionId);

      if (!session) {
        throw new Error('Session not found');
      }

      if (!session.isActive) {
        throw new Error('Session has expired');
      }

      // Check if session is full
      if (session.participants.size >= (session.metadata?.maxParticipants || 10)) {
        throw new Error('Session is full');
      }

      // Add user to session
      session.participants.add(validatedInput.userId);
      session.lastActivity = new Date();

      // Update cache
      await this.cacheSession(session);

      // Broadcast join event
      await this.broadcastToSession(session.id, {
        type: 'join',
        userId: validatedInput.userId,
        sessionId: session.id,
        data: {
          userInfo: validatedInput.userInfo,
          timestamp: new Date(),
        },
      });

      this.logger.info('User joined shared search', {
        sessionId: session.id,
        userId: validatedInput.userId,
        totalParticipants: session.participants.size,
      });

      return {
        session,
        results: session.results,
        participants: Array.from(session.participants).map(userId => ({
          userId,
          userInfo: userId === session.userId ? { name: 'Session Owner' } : validatedInput.userInfo,
          joinedAt: session.createdAt,
          lastActivity: session.lastActivity,
        })),
        userRole: userId === session.userId ? 'owner' : 'participant',
      };

    } catch (error) {
      this.logger.error('Failed to join shared search', { input, error });
      throw error;
    }
  }

  /**
   * Update search query in a shared session
   */
  async updateSearchQuery(sessionId: string, userId: string, newQuery: string): Promise<void> {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }

      if (!session.participants.has(userId)) {
        throw new Error('User not authorized for this session');
      }

      // Update session
      session.query = newQuery;
      session.lastActivity = new Date();

      // Perform new search
      const newResults = await this.performSearch(newQuery, session.filters);
      session.results = newResults;

      // Cache updated session
      await this.cacheSession(session);

      // Broadcast update to all participants
      await this.broadcastToSession(sessionId, {
        type: 'query_change',
        userId,
        sessionId,
        data: {
          query: newQuery,
          resultsCount: newResults.length,
          results: newResults.slice(0, 10), // Send preview only
          timestamp: new Date(),
        },
      });

      this.logger.debug('Search query updated in session', {
        sessionId,
        userId,
        query: newQuery,
        resultsCount: newResults.length,
      });

    } catch (error) {
      this.logger.error('Failed to update search query', { sessionId, userId, newQuery, error });
      throw error;
    }
  }

  /**
   * Update search filters in a shared session
   */
  async updateSearchFilters(sessionId: string, userId: string, newFilters: Partial<SearchFilters>): Promise<void> {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }

      if (!session.participants.has(userId)) {
        throw new Error('User not authorized for this session');
      }

      // Update filters
      session.filters = { ...session.filters, ...newFilters };
      session.lastActivity = new Date();

      // Perform filtered search
      const filteredResults = await this.performSearch(session.query, session.filters);
      session.results = filteredResults;

      // Cache updated session
      await this.cacheSession(session);

      // Broadcast update to all participants
      await this.broadcastToSession(sessionId, {
        type: 'filter_change',
        userId,
        sessionId,
        data: {
          filters: newFilters,
          resultsCount: filteredResults.length,
          timestamp: new Date(),
        },
      });

      this.logger.debug('Search filters updated in session', {
        sessionId,
        userId,
        filters: newFilters,
        resultsCount: filteredResults.length,
      });

    } catch (error) {
      this.logger.error('Failed to update search filters', { sessionId, userId, newFilters, error });
      throw error;
    }
  }

  /**
   * Select a search result in a shared session
   */
  async selectResult(sessionId: string, userId: string, resultId: string): Promise<void> {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }

      if (!session.participants.has(userId)) {
        throw new Error('User not authorized for this session');
      }

      const result = session.results.find(r => r.id === resultId);
      if (!result) {
        throw new Error('Result not found');
      }

      // Broadcast result selection
      await this.broadcastToSession(sessionId, {
        type: 'result_select',
        userId,
        sessionId,
        data: {
          resultId,
          result,
          timestamp: new Date(),
        },
      });

      this.logger.debug('Result selected in shared search', {
        sessionId,
        userId,
        resultId,
        resultTitle: result.title,
      });

    } catch (error) {
      this.logger.error('Failed to select result', { sessionId, userId, resultId, error });
      throw error;
    }
  }

  /**
   * Leave a shared search session
   */
  async leaveSession(sessionId: string, userId: string): Promise<void> {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) {
        return; // Session already doesn't exist
      }

      // Remove user from session
      session.participants.delete(userId);
      session.lastActivity = new Date();

      // If session is now empty, mark as inactive
      if (session.participants.size === 0) {
        session.isActive = false;
      } else {
        // Cache updated session
        await this.cacheSession(session);
      }

      // Broadcast leave event
      await this.broadcastToSession(sessionId, {
        type: 'leave',
        userId,
        sessionId,
        data: {
          timestamp: new Date(),
          remainingParticipants: session.participants.size,
        },
      });

      this.logger.info('User left shared search', {
        sessionId,
        userId,
        remainingParticipants: session.participants.size,
      });

    } catch (error) {
      this.logger.error('Failed to leave session', { sessionId, userId, error });
      throw error;
    }
  }

  /**
   * Get shared search session details
   */
  async getSession(sessionId: string): Promise<SearchSession | null> {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * List all active sessions for a user
   */
  async getUserSessions(userId: string): Promise<SearchSession[]> {
    const userSessions: SearchSession[] = [];

    for (const session of this.sessions.values()) {
      if (session.participants.has(userId) && session.isActive) {
        userSessions.push(session);
      }
    }

    return userSessions.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
  }

  /**
   * Perform search with given query and filters
   */
  private async performSearch(query: string, filters: SearchFilters): Promise<SearchResult[]> {
    try {
      // Use semantic search if available, fallback to keyword search
      let results: SearchResult[] = [];

      try {
        // Try semantic search first
        const semanticResults = await this.performSemanticSearch(query, filters);
        results = semanticResults;
      } catch (error) {
        // Fallback to keyword search
        this.logger.warn('Semantic search failed, using keyword search', { error });
        results = await this.performKeywordSearch(query, filters);
      }

      // Apply additional filtering
      results = this.applyFilters(results, filters);

      // Sort results
      results = this.sortResults(results, filters.sortBy, filters.sortOrder);

      // Limit results
      return results.slice(0, this.MAX_RESULTS);

    } catch (error) {
      this.logger.error('Search failed', { query, filters, error });
      throw error;
    }
  }

  /**
   * Perform semantic search using AI embeddings
   */
  private async performSemanticSearch(query: string, filters: SearchFilters): Promise<SearchResult[]> {
    try {
      // This would integrate with the semantic search service
      // For now, we'll implement a basic version
      const searchResults = await prisma.item.findMany({
        where: {
          AND: [
            // Basic text search as fallback
            {
              OR: [
                { title: { contains: query, mode: 'insensitive' } },
                { description: { contains: query, mode: 'insensitive' } },
                { author: { contains: query, mode: 'insensitive' } },
              ],
            },
            // Apply filters
            ...(filters.categories ? [{ category: { in: filters.categories } }] : []),
            ...(filters.minRating ? [{ rating: { gte: filters.minRating } }] : []),
            ...(filters.dateRange ? [{
              createdAt: {
                gte: filters.dateRange.start,
                lte: filters.dateRange.end,
              },
            }] : []),
          ],
        },
        include: {
          tags: true,
        },
        take: this.MAX_RESULTS,
      });

      return searchResults.map(item => ({
        id: item.id,
        title: item.title,
        author: item.author || undefined,
        description: item.description || undefined,
        url: item.url || undefined,
        image: item.image || undefined,
        rating: item.rating || undefined,
        tags: item.tags.map(t => t.name),
        category: item.category || undefined,
        relevanceScore: this.calculateRelevanceScore(query, item),
        metadata: {
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        },
      }));

    } catch (error) {
      this.logger.error('Semantic search failed', { query, error });
      throw error;
    }
  }

  /**
   * Perform keyword-based search
   */
  private async performKeywordSearch(query: string, filters: SearchFilters): Promise<SearchResult[]> {
    // This is a basic implementation - in production you'd use
    // proper full-text search with PostgreSQL or Elasticsearch
    const searchTerms = query.toLowerCase().split(' ');
    
    const items = await prisma.item.findMany({
      where: {
        OR: searchTerms.map(term => ({
          OR: [
            { title: { contains: term, mode: 'insensitive' } },
            { description: { contains: term, mode: 'insensitive' } },
            { author: { contains: term, mode: 'insensitive' } },
          ],
        })),
      },
      include: {
        tags: true,
      },
      take: this.MAX_RESULTS,
    });

    return items.map(item => ({
      id: item.id,
      title: item.title,
      author: item.author || undefined,
      description: item.description || undefined,
      url: item.url || undefined,
      image: item.image || undefined,
      rating: item.rating || undefined,
      tags: item.tags.map(t => t.name),
      category: item.category || undefined,
      relevanceScore: this.calculateRelevanceScore(query, item),
      metadata: {
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      },
    }));
  }

  /**
   * Apply additional filters to search results
   */
  private applyFilters(results: SearchResult[], filters: SearchFilters): SearchResult[] {
    let filtered = results;

    // Filter by tags
    if (filters.tags && filters.tags.length > 0) {
      filtered = filtered.filter(result =>
        filters.tags!.some(tag => result.tags.includes(tag))
      );
    }

    // Filter by authors
    if (filters.authors && filters.authors.length > 0) {
      filtered = filtered.filter(result =>
        result.author && filters.authors!.includes(result.author)
      );
    }

    // Filter by categories
    if (filters.categories && filters.categories.length > 0) {
      filtered = filtered.filter(result =>
        result.category && filters.categories!.includes(result.category)
      );
    }

    // Filter by minimum rating
    if (filters.minRating) {
      filtered = filtered.filter(result =>
        result.rating && result.rating >= filters.minRating!
      );
    }

    return filtered;
  }

  /**
   * Sort search results
   */
  private sortResults(
    results: SearchResult[],
    sortBy: 'relevance' | 'date' | 'rating' | 'popularity' = 'relevance',
    sortOrder: 'asc' | 'desc' = 'desc'
  ): SearchResult[] {
    return results.sort((a, b) => {
      let comparison = 0;

      switch (sortBy) {
        case 'relevance':
          comparison = b.relevanceScore - a.relevanceScore;
          break;
        case 'date':
          const dateA = new Date(a.metadata?.createdAt || 0).getTime();
          const dateB = new Date(b.metadata?.createdAt || 0).getTime();
          comparison = dateB - dateA;
          break;
        case 'rating':
          comparison = (b.rating || 0) - (a.rating || 0);
          break;
        case 'popularity':
          // Use engagement metadata if available
          const engagementA = (a.metadata?.engagement?.likes || 0) + (a.metadata?.engagement?.views || 0);
          const engagementB = (b.metadata?.engagement?.likes || 0) + (b.metadata?.engagement?.views || 0);
          comparison = engagementB - engagementA;
          break;
      }

      return sortOrder === 'asc' ? -comparison : comparison;
    });
  }

  /**
   * Calculate relevance score for search results
   */
  private calculateRelevanceScore(query: string, item: any): number {
    const queryLower = query.toLowerCase();
    const titleScore = this.calculateTextSimilarity(queryLower, item.title.toLowerCase());
    const descriptionScore = item.description 
      ? this.calculateTextSimilarity(queryLower, item.description.toLowerCase()) * 0.7 
      : 0;
    const authorScore = item.author 
      ? this.calculateTextSimilarity(queryLower, item.author.toLowerCase()) * 0.8 
      : 0;

    return (titleScore + descriptionScore + authorScore) / (1 + 0.7 + 0.8);
  }

  /**
   * Calculate text similarity (simple implementation)
   */
  private calculateTextSimilarity(text1: string, text2: string): number {
    const words1 = text1.split(/\s+/);
    const words2 = text2.split(/\s+/);
    
    let matches = 0;
    for (const word1 of words1) {
      for (const word2 of words2) {
        if (word1 === word2) {
          matches++;
          break;
        }
        // Partial match bonus
        if (word1.length > 3 && word2.length > 3 && 
            (word1.includes(word2) || word2.includes(word1))) {
          matches += 0.5;
        }
      }
    }

    return matches / Math.max(words1.length, words2.length);
  }

  /**
   * Cache session data
   */
  private async cacheSession(session: SearchSession): Promise<void> {
    try {
      const cacheKey = `search_session:${session.id}`;
      const serialized = JSON.stringify({
        ...session,
        participants: Array.from(session.participants),
      });
      
      await redis.setex(cacheKey, this.SESSION_TTL, serialized);
    } catch (error) {
      this.logger.error('Failed to cache session', { sessionId: session.id, error });
    }
  }

  /**
   * Broadcast event to all session participants
   */
  private async broadcastToSession(sessionId: string, event: SearchSyncEvent): Promise<void> {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) return;

      // This would integrate with the WebSocket server
      // For now, we'll log the broadcast
      this.logger.debug('Broadcasting search sync event', {
        sessionId,
        eventType: event.type,
        userId: event.userId,
        participants: session.participants.size,
      });

      // In a real implementation:
      // 1. Get WebSocket connections for all participants
      // 2. Send event to each connection
      // 3. Handle offline participants with push notifications

    } catch (error) {
      this.logger.error('Failed to broadcast to session', { sessionId, event, error });
    }
  }

  /**
   * Clean up expired sessions
   */
  private cleanupExpiredSessions(): void {
    const now = new Date();
    const expiredSessions: string[] = [];

    for (const [sessionId, session] of this.sessions) {
      const timeSinceActivity = now.getTime() - session.lastActivity.getTime();
      
      if (timeSinceActivity > this.SESSION_TTL * 1000) {
        expiredSessions.push(sessionId);
      }
    }

    for (const sessionId of expiredSessions) {
      this.sessions.delete(sessionId);
      redis.del(`search_session:${sessionId}`);
      
      this.logger.info('Cleaned up expired search session', { sessionId });
    }
  }

  /**
   * Generate unique session ID
   */
  private generateSessionId(): string {
    return `search_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get search sync statistics
   */
  getSyncStats(): {
    activeSessions: number;
    totalParticipants: number;
    averageSessionSize: number;
    popularQueries: Array<{ query: string; count: number }>;
  } {
    const activeSessions = Array.from(this.sessions.values()).filter(s => s.isActive);
    const totalParticipants = activeSessions.reduce((sum, s) => sum + s.participants.size, 0);
    const averageSessionSize = activeSessions.length > 0 
      ? totalParticipants / activeSessions.length 
      : 0;

    // Get popular queries (simple implementation)
    const queryCounts = new Map<string, number>();
    for (const session of activeSessions) {
      const count = queryCounts.get(session.query) || 0;
      queryCounts.set(session.query, count + 1);
    }

    const popularQueries = Array.from(queryCounts.entries())
      .map(([query, count]) => ({ query, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      activeSessions: activeSessions.length,
      totalParticipants,
      averageSessionSize: Math.round(averageSessionSize * 100) / 100,
      popularQueries,
    };
  }
}