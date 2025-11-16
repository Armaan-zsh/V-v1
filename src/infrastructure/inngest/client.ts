import { Inngest } from 'inngest';
import { env } from '../../shared/config/env';

// Initialize Inngest client
export const inngest = new Inngest({
  name: 'vow',
  env: process.env.NODE_ENV,
});

// Inngest configuration
export const inngestConfig = {
  // Base URL for webhooks (for local development)
  baseUrl: process.env.INNGEST_BASE_URL || 'http://localhost:8288',
  
  // Event name prefixes for organization
  eventPrefix: 'item.',
  
  // Function concurrency settings
  concurrency: 5,
  
  // Retry configuration
  retry: {
    attempts: 3,
    delay: 1000, // 1 second
  },
};

// Event types for type safety
export interface ItemEvents {
  'item.created': {
    data: {
      itemId: string;
      userId: string;
      type: 'book' | 'paper' | 'article';
      title: string;
    };
  };
  
  'item.updated': {
    data: {
      itemId: string;
      changes: Partial<{
        title: string;
        author: string;
        notes: string;
        tags: string[];
      }>;
    };
  };
  
  'item.embedding.generate': {
    data: {
      itemId: string;
      text: string;
      type: 'item' | 'query' | 'user';
      retryCount?: number;
    };
  };
  
  'item.summary.generate': {
    data: {
      itemId: string;
      url?: string;
      type: 'book' | 'paper' | 'article';
      retryCount?: number;
    };
  };
  
  'user.profile.update': {
    data: {
      userId: string;
      changes: Partial<{
        name: string;
        bio: string;
        interests: string[];
      }>;
    };
  };
  
  'recommendation.update': {
    data: {
      userId: string;
      forceRecalculation?: boolean;
    };
  };
  
  'search.query': {
    data: {
      queryId: string;
      userId?: string;
      query: string;
      filters?: any;
    };
  };
  
  'cost.monitor': {
    data: {
      service: string;
      userId?: string;
      cost: number;
      metadata?: Record<string, any>;
    };
  };
}

// Helper functions for event emission
export const emitEvents = {
  itemCreated: async (data: ItemEvents['item.created']['data']) => {
    await inngest.send({
      name: 'item.created',
      data,
    });
  },
  
  itemUpdated: async (data: ItemEvents['item.updated']['data']) => {
    await inngest.send({
      name: 'item.updated',
      data,
    });
  },
  
  generateEmbedding: async (data: ItemEvents['item.embedding.generate']['data']) => {
    await inngest.send({
      name: 'item.embedding.generate',
      data,
    });
  },
  
  generateSummary: async (data: ItemEvents['item.summary.generate']['data']) => {
    await inngest.send({
      name: 'item.summary.generate',
      data,
    });
  },
  
  profileUpdated: async (data: ItemEvents['user.profile.update']['data']) => {
    await inngest.send({
      name: 'user.profile.update',
      data,
    });
  },
  
  updateRecommendations: async (data: ItemEvents['recommendation.update']['data']) => {
    await inngest.send({
      name: 'recommendation.update',
      data,
    });
  },
  
  logSearch: async (data: ItemEvents['search.query']['data']) => {
    await inngest.send({
      name: 'search.query',
      data,
    });
  },
  
  trackCost: async (data: ItemEvents['cost.monitor']['data']) => {
    await inngest.send({
      name: 'cost.monitor',
      data,
    });
  },
};

// Middleware for request tracking
export const withRequestTracking = <T>(
  fn: (req: Request) => Promise<T>
) => {
  return async (req: Request): Promise<T> => {
    const startTime = Date.now();
    const userAgent = req.headers.get('user-agent') || 'unknown';
    const ip = req.headers.get('x-forwarded-for') || 
               req.headers.get('x-real-ip') || 
               'unknown';
    
    try {
      const result = await fn(req);
      
      // Log successful request
      await emitEvents.trackCost({
        service: 'inngest',
        metadata: {
          duration: Date.now() - startTime,
          userAgent,
          ip,
          success: true,
        },
      });
      
      return result;
    } catch (error) {
      // Log failed request
      await emitEvents.trackCost({
        service: 'inngest',
        metadata: {
          duration: Date.now() - startTime,
          userAgent,
          ip,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      });
      
      throw error;
    }
  };
};

// Health check for Inngest
export async function checkInngestHealth(): Promise<{
  healthy: boolean;
  functions: Array<{
    id: string;
    name: string;
    status: 'running' | 'stopped' | 'error';
  }>;
}> {
  try {
    // In a real implementation, this would check actual Inngest status
    // For now, return a mock healthy status
    return {
      healthy: true,
      functions: [
        {
          id: 'generate-embedding',
          name: 'Generate Embedding',
          status: 'running',
        },
        {
          id: 'generate-summary',
          name: 'Generate Summary',
          status: 'running',
        },
        {
          id: 'update-recommendations',
          name: 'Update Recommendations',
          status: 'running',
        },
      ],
    };
  } catch (error) {
    return {
      healthy: false,
      functions: [],
    };
  }
}

// Utility for rate limiting
export class InngestRateLimiter {
  private static readonly WINDOW_SIZE = 60 * 1000; // 1 minute
  private static readonly MAX_EVENTS_PER_WINDOW = 100;
  
  private static windows = new Map<string, { count: number; windowStart: number }>();
  
  static async checkRateLimit(key: string): Promise<{
    allowed: boolean;
    remaining: number;
    resetTime: number;
  }> {
    const now = Date.now();
    const window = this.windows.get(key);
    
    if (!window || now - window.windowStart > this.WINDOW_SIZE) {
      // New window
      this.windows.set(key, { count: 1, windowStart: now });
      return {
        allowed: true,
        remaining: this.MAX_EVENTS_PER_WINDOW - 1,
        resetTime: now + this.WINDOW_SIZE,
      };
    }
    
    if (window.count >= this.MAX_EVENTS_PER_WINDOW) {
      // Rate limit exceeded
      return {
        allowed: false,
        remaining: 0,
        resetTime: window.windowStart + this.WINDOW_SIZE,
      };
    }
    
    // Allow request
    window.count++;
    return {
      allowed: true,
      remaining: this.MAX_EVENTS_PER_WINDOW - window.count,
      resetTime: window.windowStart + this.WINDOW_SIZE,
    };
  }
}

// Cleanup old rate limit windows
export async function cleanupRateLimitWindows(): Promise<void> {
  const now = Date.now();
  
  for (const [key, window] of InngestRateLimiter['windows'].entries()) {
    if (now - window.windowStart > InngestRateLimiter.WINDOW_SIZE) {
      InngestRateLimiter['windows'].delete(key);
    }
  }
}