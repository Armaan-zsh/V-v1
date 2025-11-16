import { Redis } from '@upstash/redis';
import { env } from '../../shared/config/env';

let redisInstance: Redis | null = null;

export function getRedisInstance(): Redis {
  if (!redisInstance) {
    if (!env.REDIS_URL) {
      throw new Error('REDIS_URL environment variable is not set');
    }
    
    redisInstance = new Redis({
      url: env.REDIS_URL,
      token: env.REDIS_TOKEN,
    });
  }
  
  return redisInstance;
}

// Export default instance
export const redis = getRedisInstance();

// Redis utility functions
export class RedisUtils {
  static async get(key: string): Promise<string | null> {
    try {
      return await redis.get(key);
    } catch (error) {
      console.error(`Redis GET failed for key ${key}:`, error);
      return null;
    }
  }

  static async set(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    try {
      if (ttlSeconds) {
        await redis.setex(key, ttlSeconds, value);
      } else {
        await redis.set(key, value);
      }
      return true;
    } catch (error) {
      console.error(`Redis SET failed for key ${key}:`, error);
      return false;
    }
  }

  static async del(key: string): Promise<boolean> {
    try {
      await redis.del(key);
      return true;
    } catch (error) {
      console.error(`Redis DEL failed for key ${key}:`, error);
      return false;
    }
  }

  static async exists(key: string): Promise<boolean> {
    try {
      const result = await redis.exists(key);
      return result === 1;
    } catch (error) {
      console.error(`Redis EXISTS failed for key ${key}:`, error);
      return false;
    }
  }

  static async incr(key: string): Promise<number | null> {
    try {
      return await redis.incr(key);
    } catch (error) {
      console.error(`Redis INCR failed for key ${key}:`, error);
      return null;
    }
  }

  static async incrby(key: string, increment: number): Promise<number | null> {
    try {
      return await redis.incrby(key, increment);
    } catch (error) {
      console.error(`Redis INCRBY failed for key ${key}:`, error);
      return null;
    }
  }

  static async incrbyfloat(key: string, increment: number): Promise<string | null> {
    try {
      return await redis.incrbyfloat(key, increment);
    } catch (error) {
      console.error(`Redis INCRBYFLOAT failed for key ${key}:`, error);
      return null;
    }
  }

  static async expire(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      await redis.expire(key, ttlSeconds);
      return true;
    } catch (error) {
      console.error(`Redis EXPIRE failed for key ${key}:`, error);
      return false;
    }
  }

  static async ttl(key: string): Promise<number | null> {
    try {
      return await redis.ttl(key);
    } catch (error) {
      console.error(`Redis TTL failed for key ${key}:`, error);
      return null;
    }
  }

  static async ping(): Promise<boolean> {
    try {
      const result = await redis.ping();
      return result === 'PONG';
    } catch (error) {
      console.error('Redis PING failed:', error);
      return false;
    }
  }

  static async flushdb(): Promise<boolean> {
    try {
      await redis.flushdb();
      return true;
    } catch (error) {
      console.error('Redis FLUSHDB failed:', error);
      return false;
    }
  }

  // Batch operations for better performance
  static async mget(keys: string[]): Promise<(string | null)[]> {
    try {
      return await redis.mget(...keys);
    } catch (error) {
      console.error(`Redis MGET failed for keys ${keys.join(', ')}:`, error);
      return keys.map(() => null);
    }
  }

  static async mset(pairs: Record<string, string>): Promise<boolean> {
    try {
      const entries = Object.entries(pairs);
      if (entries.length === 0) return true;
      
      await redis.mset(...entries.flat());
      return true;
    } catch (error) {
      console.error('Redis MSET failed:', error);
      return false;
    }
  }

  static async msetex(pairs: Record<string, string>, ttlSeconds: number): Promise<boolean> {
    try {
      const entries = Object.entries(pairs);
      if (entries.length === 0) return true;

      for (const [key, value] of entries) {
        await redis.setex(key, ttlSeconds, value);
      }
      return true;
    } catch (error) {
      console.error('Redis MSETEX failed:', error);
      return false;
    }
  }

  // Pub/Sub support for real-time features
  static async publish(channel: string, message: string): Promise<boolean> {
    try {
      await redis.publish(channel, message);
      return true;
    } catch (error) {
      console.error(`Redis PUBLISH failed for channel ${channel}:`, error);
      return false;
    }
  }

  static async subscribe(
    channel: string,
    callback: (message: string) => void
  ): Promise<boolean> {
    try {
      await redis.subscribe(channel, callback);
      return true;
    } catch (error) {
      console.error(`Redis SUBSCRIBE failed for channel ${channel}:`, error);
      return false;
    }
  }
}

// Health check for Redis
export async function checkRedisHealth(): Promise<{
  healthy: boolean;
  latency?: number;
  error?: string;
}> {
  const startTime = Date.now();
  
  try {
    const isHealthy = await RedisUtils.ping();
    const latency = Date.now() - startTime;
    
    return {
      healthy: isHealthy,
      latency: isHealthy ? latency : undefined,
    };
  } catch (error) {
    return {
      healthy: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}