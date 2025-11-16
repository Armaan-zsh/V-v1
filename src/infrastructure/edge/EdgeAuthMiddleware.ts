import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify, SignJWT } from 'jose';
import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';
import { nanoid } from 'nanoid';

// Edge-optimized auth middleware with rate limiting
export interface EdgeAuthConfig {
  redis: Redis;
  jwtSecret: string;
  allowedOrigins: string[];
  rateLimit: {
    requests: number;
    window: string; // e.g., "1h", "5m"
  };
  cacheTtl: number;
}

export interface EdgeUser {
  id: string;
  email: string;
  role: 'user' | 'admin' | 'moderator';
  permissions: string[];
  metadata: {
    deviceId?: string;
    location?: string;
    lastSeen: Date;
    preferences: Record<string, any>;
  };
}

export interface EdgeAuthResult {
  success: boolean;
  user?: EdgeUser;
  error?: string;
  rateLimitInfo?: {
    remaining: number;
    resetTime: Date;
    limit: number;
  };
}

export class EdgeAuthMiddleware {
  private redis: Redis;
  private ratelimit: Ratelimit;
  private jwtSecret: Uint8Array;
  private config: EdgeAuthConfig;

  constructor(config: EdgeAuthConfig) {
    this.redis = config.redis;
    this.config = config;
    this.ratelimit = new Ratelimit({
      redis: config.redis,
      limiter: Ratelimit.slidingWindow(config.rateLimit.requests, config.rateLimit.window),
      ephemeralCache: this.createEphemeralCache(),
      prefix: 'edge:ratelimit',
    });
    this.jwtSecret = new TextEncoder().encode(config.jwtSecret);
  }

  /**
   * Authenticate request at the edge with rate limiting
   */
  async authenticate(request: NextRequest): Promise<EdgeAuthResult> {
    try {
      // 1. Rate limiting check
      const clientIP = this.getClientIP(request);
      const rateLimitKey = `edge:ratelimit:${clientIP}`;
      const { success, limit, resetTime, remaining } = await this.ratelimit.limit(rateLimitKey);

      if (!success) {
        return {
          success: false,
          error: 'Rate limit exceeded',
          rateLimitInfo: {
            remaining,
            resetTime,
            limit
          }
        };
      }

      // 2. Get auth token
      const authHeader = request.headers.get('authorization');
      const token = this.extractToken(authHeader);

      if (!token) {
        return {
          success: false,
          error: 'No authorization token provided',
          rateLimitInfo: { remaining, resetTime, limit }
        };
      }

      // 3. Verify JWT token
      const payload = await this.verifyJWT(token);
      if (!payload) {
        return {
          success: false,
          error: 'Invalid token',
          rateLimitInfo: { remaining, resetTime, limit }
        };
      }

      // 4. Check token blacklist (for logout/invalidation)
      const isBlacklisted = await this.isTokenBlacklisted(payload.jti as string);
      if (isBlacklisted) {
        return {
          success: false,
          error: 'Token has been revoked',
          rateLimitInfo: { remaining, resetTime, limit }
        };
      }

      // 5. Load user from cache/database
      const user = await this.getUser(payload.sub as string);
      if (!user) {
        return {
          success: false,
          error: 'User not found',
          rateLimitInfo: { remaining, resetTime, limit }
        };
      }

      // 6. Update last seen
      await this.updateLastSeen(user.id);

      return {
        success: true,
        user,
        rateLimitInfo: { remaining, resetTime, limit }
      };

    } catch (error) {
      console.error('Edge auth error:', error);
      return {
        success: false,
        error: 'Authentication failed'
      };
    }
  }

  /**
   * Create signed JWT for edge distribution
   */
  async createEdgeToken(user: EdgeUser): Promise<string> {
    const jti = nanoid();
    const expiresIn = '24h';

    const token = await new SignJWT({
      sub: user.id,
      email: user.email,
      role: user.role,
      permissions: user.permissions,
      metadata: user.metadata,
      jti
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(this.jwtSecret);

    // Cache token for quick validation
    await this.cacheToken(jti, user.id, expiresIn);

    return token;
  }

  /**
   * Revoke token by blacklisting it
   */
  async revokeToken(jti: string, reason: string = 'manual_logout'): Promise<void> {
    // Add to blacklist cache
    await this.redis.setex(`edge:token:blacklist:${jti}`, 86400, reason); // 24h TTL
  }

  /**
   * Create CSRF token for edge protection
   */
  async createCSRFToken(userId: string): Promise<string> {
    const csrfToken = nanoid(32);
    const expiresAt = Date.now() + (60 * 60 * 1000); // 1 hour

    await this.redis.setex(
      `edge:csrf:${userId}:${csrfToken}`,
      3600,
      expiresAt.toString()
    );

    return csrfToken;
  }

  /**
   * Validate CSRF token
   */
  async validateCSRFToken(userId: string, token: string): Promise<boolean> {
    const key = `edge:csrf:${userId}:${token}`;
    const value = await this.redis.get(key);

    if (!value) return false;

    const expiresAt = parseInt(value as string);
    if (Date.now() > expiresAt) {
      // Clean up expired token
      await this.redis.del(key);
      return false;
    }

    return true;
  }

  /**
   * Check if request is from allowed origin
   */
  isOriginAllowed(request: NextRequest): boolean {
    const origin = request.headers.get('origin');
    const referer = request.headers.get('referer');

    if (origin && this.config.allowedOrigins.includes(origin)) {
      return true;
    }

    if (referer) {
      const refererOrigin = new URL(referer).origin;
      return this.config.allowedOrigins.includes(refererOrigin);
    }

    return false;
  }

  /**
   * Add security headers for edge responses
   */
  addSecurityHeaders(response: NextResponse): NextResponse {
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('X-XSS-Protection', '1; mode=block');
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    response.headers.set('Content-Security-Policy', "default-src 'self'");
    
    return response;
  }

  /**
   * Get client IP address for rate limiting
   */
  private getClientIP(request: NextRequest): string {
    return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
           request.headers.get('x-real-ip') ||
           request.ip ||
           'unknown';
  }

  /**
   * Extract JWT token from Authorization header
   */
  private extractToken(authHeader: string | null): string | null {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    return authHeader.substring(7);
  }

  /**
   * Verify JWT token
   */
  private async verifyJWT(token: string): Promise<any | null> {
    try {
      const { payload } = await jwtVerify(token, this.jwtSecret);
      return payload;
    } catch {
      return null;
    }
  }

  /**
   * Check if token is blacklisted
   */
  private async isTokenBlacklisted(jti: string): Promise<boolean> {
    const result = await this.redis.get(`edge:token:blacklist:${jti}`);
    return result !== null;
  }

  /**
   * Get user by ID (from cache or database)
   */
  private async getUser(userId: string): Promise<EdgeUser | null> {
    // Try cache first
    const cached = await this.redis.get(`edge:user:${userId}`);
    if (cached) {
      return JSON.parse(cached as string);
    }

    // TODO: Load from database
    // For now, return mock user
    return {
      id: userId,
      email: 'user@example.com',
      role: 'user',
      permissions: ['read:content', 'write:profile'],
      metadata: {
        lastSeen: new Date(),
        preferences: {}
      }
    };
  }

  /**
   * Update user's last seen timestamp
   */
  private async updateLastSeen(userId: string): Promise<void> {
    await this.redis.setex(`edge:lastseen:${userId}`, 3600, Date.now().toString());
  }

  /**
   * Cache token for quick validation
   */
  private async cacheToken(jti: string, userId: string, expiresIn: string): Promise<void> {
    const ttl = this.parseTTL(expiresIn);
    await this.redis.setex(`edge:token:${jti}`, ttl, userId);
  }

  /**
   * Parse TTL string to seconds
   */
  private parseTTL(ttl: string): number {
    const match = ttl.match(/^(\d+)([smhd])$/);
    if (!match) return 3600; // default 1 hour

    const value = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
      case 's': return value;
      case 'm': return value * 60;
      case 'h': return value * 3600;
      case 'd': return value * 86400;
      default: return 3600;
    }
  }

  /**
   * Create ephemeral cache for rate limiting
   */
  private createEphemeralCache(): Map<string, { count: number; expires: number }> {
    return new Map();
  }
}

/**
 * Edge middleware wrapper for Next.js
 */
export function createEdgeMiddleware(config: EdgeAuthConfig) {
  const auth = new EdgeAuthMiddleware(config);

  return async function middleware(request: NextRequest) {
    // 1. CORS check
    if (!auth.isOriginAllowed(request)) {
      return new NextResponse('Origin not allowed', { status: 403 });
    }

    // 2. Authenticate
    const result = await auth.authenticate(request);

    if (!result.success) {
      const response = new NextResponse(result.error, { 
        status: 401,
        headers: {
          'WWW-Authenticate': 'Bearer realm="edge-auth"'
        }
      });

      // Add rate limit info if available
      if (result.rateLimitInfo) {
        response.headers.set('X-RateLimit-Limit', result.rateLimitInfo.limit.toString());
        response.headers.set('X-RateLimit-Remaining', result.rateLimitInfo.remaining.toString());
        response.headers.set('X-RateLimit-Reset', result.rateLimitInfo.resetTime.toISOString());
      }

      return auth.addSecurityHeaders(response);
    }

    // 3. Add user context to request
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-user-id', result.user!.id);
    requestHeaders.set('x-user-role', result.user!.role);
    requestHeaders.set('x-user-permissions', JSON.stringify(result.user!.permissions));

    // 4. Continue with authenticated request
    const response = NextResponse.next({
      request: {
        headers: requestHeaders
      }
    });

    // 5. Add rate limit headers
    if (result.rateLimitInfo) {
      response.headers.set('X-RateLimit-Limit', result.rateLimitInfo.limit.toString());
      response.headers.set('X-RateLimit-Remaining', result.rateLimitInfo.remaining.toString());
      response.headers.set('X-RateLimit-Reset', result.rateLimitInfo.resetTime.toISOString());
    }

    return auth.addSecurityHeaders(response);
  };
}

// Export configuration helper
export function createEdgeConfig(redis: Redis): EdgeAuthConfig {
  return {
    redis,
    jwtSecret: process.env.EDGE_JWT_SECRET || 'default-secret-change-in-production',
    allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
    rateLimit: {
      requests: parseInt(process.env.EDGE_RATE_LIMIT_REQUESTS || '100'),
      window: process.env.EDGE_RATE_LIMIT_WINDOW || '1h'
    },
    cacheTtl: parseInt(process.env.EDGE_CACHE_TTL || '3600')
  };
}