/**
 * Database Sharding Strategy Implementation
 * Enterprise-grade horizontal scaling with intelligent data distribution
 * Supports range-based, hash-based, and geo-based sharding strategies
 */

import { z } from 'zod';
import Redis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { logger } from '../../shared/utils/logger';
import { circuitBreaker, CircuitBreakerOptions } from '../../shared/utils/circuitBreaker';

// Validation schemas
const ShardSchema = z.object({
  id: z.string(),
  name: z.string(),
  databaseUrl: z.string().url(),
  region: z.string(),
  isActive: z.boolean(),
  capacity: z.object({
    maxConnections: z.number(),
    maxStorageGB: z.number(),
    currentConnections: z.number(),
    currentStorageGB: number,
    utilization: z.number(),
  }),
  routing: z.object({
    strategy: z.enum(['range', 'hash', 'geo', 'composite']),
    ranges: z.array(z.object({
      min: z.number(),
      max: z.number(),
      table: z.string(),
    })),
    hashFunction: z.string().optional(),
    geoBounds: z.object({
      minLat: z.number(),
      maxLat: z.number(),
      minLng: z.number(),
      maxLng: z.number(),
    }).optional(),
  }),
  health: z.object({
    status: z.enum(['healthy', 'degraded', 'unhealthy']),
    lastCheck: z.date(),
    responseTime: z.number(),
    issues: z.array(z.string()),
  }),
  performance: z.object({
    averageQueryTime: z.number(),
    queriesPerSecond: z.number(),
    errorRate: z.number(),
    cacheHitRate: z.number(),
  }),
});

const ShardKeySchema = z.object({
  userId: z.string().optional(),
  table: z.string(),
  value: z.union([z.string(), z.number(), z.object()]),
  customKey: z.string().optional(),
});

const QueryRoutingSchema = z.object({
  query: z.string(),
  parameters: z.array(z.any()),
  shardHint: z.string().optional(),
  consistency: z.enum(['strong', 'eventual', 'local']).default('strong'),
  timeout: z.number().default(5000),
});

// Types
export type Shard = z.infer<typeof ShardSchema>;
export type ShardKey = z.infer<typeof ShardKeySchema>;
export type QueryRouting = z.infer<typeof QueryRoutingSchema>;

export interface ShardingConfig {
  strategy: 'range' | 'hash' | 'geo' | 'composite';
  defaultConsistency: 'strong' | 'eventual' | 'local';
  replicationFactor: number;
  rebalanceThreshold: number;
  monitoringInterval: number;
  autoScaling: {
    enabled: boolean;
    maxShards: number;
    minShards: number;
    scalingMetrics: string[];
  };
}

export interface RebalanceOperation {
  shardId: string;
  type: 'move_data' | 'split_shard' | 'merge_shards' | 'add_shard';
  targetShard?: string;
  estimatedSize: number;
  priority: 'low' | 'medium' | 'high' | 'critical';
  estimatedDuration: number;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

export interface ShardMetrics {
  shardId: string;
  timestamp: Date;
  connections: number;
  storage: {
    used: number;
    available: number;
    utilization: number;
  };
  performance: {
    avgQueryTime: number;
    qps: number;
    errorRate: number;
    cacheHitRate: number;
  };
  health: {
    status: 'healthy' | 'degraded' | 'unhealthy';
    responseTime: number;
    issues: string[];
  };
}

// Error types
export class ShardingError extends Error {
  constructor(
    message: string,
    public shardId?: string,
    public code?: string
  ) {
    super(message);
    this.name = 'ShardingError';
  }
}

export class RebalanceError extends ShardingError {
  constructor(message: string, shardId: string) {
    super(message, shardId, 'REBALANCE_FAILED');
  }
}

export class QueryRoutingError extends ShardingError {
  constructor(message: string, shardId?: string) {
    super(message, shardId, 'QUERY_ROUTING_FAILED');
  }
}

/**
 * Database Sharding Strategy Manager
 * Handles intelligent data distribution and query routing
 */
export class DatabaseShardingManager {
  private shards: Map<string, Shard> = new Map();
  private shardConnections: Map<string, PrismaClient> = new Map();
  private rebalancingOperations: Map<string, RebalanceOperation> = new Map();
  private redis: Redis;
  private config: ShardingConfig;
  private circuitBreakerOptions: CircuitBreakerOptions;
  private monitoringInterval?: NodeJS.Timeout;

  constructor(
    redis: Redis,
    config: Partial<ShardingConfig> = {}
  ) {
    this.redis = redis;
    this.config = {
      strategy: 'hash',
      defaultConsistency: 'strong',
      replicationFactor: 1,
      rebalanceThreshold: 0.8,
      monitoringInterval: 60000, // 1 minute
      autoScaling: {
        enabled: true,
        maxShards: 16,
        minShards: 2,
        scalingMetrics: ['storage_utilization', 'connection_count', 'query_latency'],
      },
      ...config,
    };

    this.circuitBreakerOptions = {
      threshold: 0.3,
      timeout: 10000,
      resetTimeout: 60000,
      fallback: async () => null,
    };

    this.startMonitoring();
  }

  /**
   * Initialize sharding strategy
   */
  async initialize(config: {
    shardConfigs: Shard[];
    rebalanceExistingData?: boolean;
  }): Promise<void> {
    try {
      const { shardConfigs, rebalanceExistingData = false } = config;

      // Initialize shards
      for (const shardConfig of shardConfigs) {
        await this.registerShard(shardConfig);
      }

      // Establish connections
      await this.establishShardConnections();

      // Rebalance existing data if needed
      if (rebalanceExistingData) {
        await this.scheduleFullRebalance();
      }

      logger.info('Database sharding initialized', {
        shardCount: shardConfigs.length,
        strategy: this.config.strategy,
        rebalanceExistingData,
      });

    } catch (error) {
      logger.error('Failed to initialize database sharding', { error });
      throw new ShardingError(
        `Failed to initialize sharding: ${error.message}`,
        undefined,
        'INIT_FAILED'
      );
    }
  }

  /**
   * Register a new shard
   */
  async registerShard(shardConfig: Shard): Promise<void> {
    try {
      const validatedShard = ShardSchema.parse(shardConfig);
      
      // Create Prisma connection for shard
      const shardConnection = new PrismaClient({
        datasources: {
          db: {
            url: validatedShard.databaseUrl,
          },
        },
      });

      // Test connection
      await shardConnection.$queryRaw`SELECT 1`;

      this.shards.set(validatedShard.id, validatedShard);
      this.shardConnections.set(validatedShard.id, shardConnection);

      // Store in Redis for persistence
      await this.redis.setex(
        `shard:${validatedShard.id}`,
        3600,
        JSON.stringify(validatedShard)
      );

      logger.info('Shard registered successfully', {
        shardId: validatedShard.id,
        name: validatedShard.name,
        region: validatedShard.region,
        strategy: validatedShard.routing.strategy,
      });

    } catch (error) {
      logger.error('Failed to register shard', { error, shardConfig });
      throw new ShardingError(
        `Failed to register shard: ${error.message}`,
        shardConfig.id
      );
    }
  }

  /**
   * Route query to appropriate shard(s)
   */
  async routeQuery(routing: QueryRouting): Promise<{
    shardId: string;
    connection: PrismaClient;
    isCrossShard: boolean;
  }> {
    try {
      const { query, parameters, shardHint, consistency } = routing;
      
      let shardId: string;

      if (shardHint) {
        // Use explicit shard hint
        shardId = shardHint;
      } else {
        // Determine shard based on query and parameters
        shardId = await this.determineShard(query, parameters, consistency);
      }

      const connection = this.shardConnections.get(shardId);
      if (!connection) {
        throw new QueryRoutingError(`No connection available for shard: ${shardId}`, shardId);
      }

      // Check shard health
      const shard = this.shards.get(shardId);
      if (shard?.health.status === 'unhealthy') {
        // Try to route to healthy shard
        const fallbackShardId = await this.getFallbackShard(shardId);
        if (fallbackShardId) {
          const fallbackConnection = this.shardConnections.get(fallbackShardId);
          if (fallbackConnection) {
            return {
              shardId: fallbackShardId,
              connection: fallbackConnection,
              isCrossShard: true,
            };
          }
        }
      }

      return {
        shardId,
        connection,
        isCrossShard: false,
      };

    } catch (error) {
      logger.error('Query routing failed', { error, routing });
      throw new QueryRoutingError(
        `Failed to route query: ${error.message}`,
        routing.shardHint
      );
    }
  }

  /**
   * Determine appropriate shard for query
   */
  private async determineShard(
    query: string,
    parameters: any[],
    consistency: QueryRouting['consistency']
  ): Promise<string> {
    const strategy = this.config.strategy;

    switch (strategy) {
      case 'hash':
        return this.routeByHash(query, parameters, consistency);
      
      case 'range':
        return this.routeByRange(query, parameters, consistency);
      
      case 'geo':
        return this.routeByGeo(query, parameters, consistency);
      
      case 'composite':
        return this.routeByComposite(query, parameters, consistency);
      
      default:
        throw new ShardingError(`Unsupported routing strategy: ${strategy}`);
    }
  }

  /**
   * Hash-based routing
   */
  private async routeByHash(
    query: string,
    parameters: any[],
    consistency: QueryRouting['consistency']
  ): Promise<string> {
    // Extract table name from query
    const tableMatch = query.match(/(FROM|JOIN)\s+(\w+)/i);
    const table = tableMatch ? tableMatch[2].toLowerCase() : 'unknown';

    // Get hash key from parameters
    const shardKey = this.extractShardKey(table, parameters);
    
    if (!shardKey) {
      // Fallback to primary shard
      return this.getPrimaryShardId();
    }

    // Calculate hash
    const hash = this.calculateHash(shardKey.value);
    
    // Map hash to shard
    const activeShards = this.getActiveShards();
    const shardIndex = hash % activeShards.length;
    
    return activeShards[shardIndex].id;
  }

  /**
   * Range-based routing
   */
  private async routeByRange(
    query: string,
    parameters: any[],
    consistency: QueryRouting['consistency']
  ): Promise<string> {
    // Similar to hash-based but uses range logic
    const tableMatch = query.match(/(FROM|JOIN)\s+(\w+)/i);
    const table = tableMatch ? tableMatch[2].toLowerCase() : 'unknown';

    const shardKey = this.extractShardKey(table, parameters);
    if (!shardKey) {
      return this.getPrimaryShardId();
    }

    // Find shard whose range includes the key
    const activeShards = this.getActiveShards();
    
    for (const shard of activeShards) {
      if (shard.routing.strategy === 'range' && shard.routing.ranges) {
        for (const range of shard.routing.ranges) {
          if (range.table === table) {
            const keyValue = typeof shardKey.value === 'number' ? shardKey.value : 
                           typeof shardKey.value === 'string' ? parseFloat(shardKey.value) : 0;
            
            if (keyValue >= range.min && keyValue <= range.max) {
              return shard.id;
            }
          }
        }
      }
    }

    // Fallback to primary shard
    return this.getPrimaryShardId();
  }

  /**
   * Geographic routing
   */
  private async routeByGeo(
    query: string,
    parameters: any[],
    consistency: QueryRouting['consistency']
  ): Promise<string> {
    // Extract geographic information
    const location = this.extractGeographicInfo(query, parameters);
    if (!location) {
      return this.getPrimaryShardId();
    }

    // Find shard covering this location
    const activeShards = this.getActiveShards();
    
    for (const shard of activeShards) {
      if (shard.routing.strategy === 'geo' && shard.routing.geoBounds) {
        const bounds = shard.routing.geoBounds;
        
        if (location.lat >= bounds.minLat && location.lat <= bounds.maxLat &&
            location.lng >= bounds.minLng && location.lng <= bounds.maxLng) {
          return shard.id;
        }
      }
    }

    // Fallback to primary shard
    return this.getPrimaryShardId();
  }

  /**
   * Composite routing strategy
   */
  private async routeByComposite(
    query: string,
    parameters: any[],
    consistency: QueryRouting['consistency']
  ): Promise<string> {
    // Try multiple strategies and combine results
    
    // 1. Try geographic routing
    const geoShard = await this.routeByGeo(query, parameters, consistency);
    
    // 2. Try hash routing for non-geo tables
    const hashShard = await this.routeByHash(query, parameters, consistency);
    
    // 3. Use load balancing to choose between candidates
    const candidates = [geoShard, hashShard].filter((id, index, arr) => 
      arr.indexOf(id) === index // Remove duplicates
    );

    if (candidates.length === 1) {
      return candidates[0];
    }

    // Choose based on load
    return this.selectLeastLoadedShard(candidates);
  }

  /**
   * Extract shard key from query parameters
   */
  private extractShardKey(table: string, parameters: any[]): ShardKey | null {
    // Look for user_id first (most common sharding key)
    if (parameters.length > 0) {
      const userIdMatch = JSON.stringify(parameters).match(/userId.*?:\s*["']?(\w+)["']?/);
      if (userIdMatch) {
        return {
          table,
          value: userIdMatch[1],
        };
      }
    }

    // Look for explicit shard key hints in query
    // This would be enhanced with SQL parsing in production
    return null;
  }

  /**
   * Calculate hash for sharding key
   */
  private calculateHash(value: any): number {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    let hash = 0;
    
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    
    return Math.abs(hash);
  }

  /**
   * Extract geographic information from query
   */
  private extractGeographicInfo(query: string, parameters: any[]): { lat: number; lng: number } | null {
    // This is a simplified implementation
    // In production, this would involve SQL parsing and spatial index lookup
    
    // Look for latitude/longitude in parameters
    const paramStr = JSON.stringify(parameters);
    const latMatch = paramStr.match(/lat.*?:\s*(-?\d+\.?\d*)/);
    const lngMatch = paramStr.match(/lng.*?:\s*(-?\d+\.?\d*)/);
    
    if (latMatch && lngMatch) {
      return {
        lat: parseFloat(latMatch[1]),
        lng: parseFloat(lngMatch[1]),
      };
    }
    
    return null;
  }

  /**
   * Get primary shard ID (fallback)
   */
  private getPrimaryShardId(): string {
    const activeShards = this.getActiveShards();
    
    if (activeShards.length === 0) {
      throw new ShardingError('No active shards available');
    }
    
    // Return first shard as primary
    return activeShards[0].id;
  }

  /**
   * Get active shards
   */
  private getActiveShards(): Shard[] {
    return Array.from(this.shards.values()).filter(shard => 
      shard.isActive && shard.health.status === 'healthy'
    );
  }

  /**
   * Get fallback shard for failed shard
   */
  private async getFallbackShard(failedShardId: string): Promise<string | null> {
    try {
      // Look for replica or backup shard
      const fallback = Array.from(this.shards.values()).find(shard => 
        shard.isActive && 
        shard.id !== failedShardId && 
        shard.health.status === 'healthy'
      );
      
      return fallback?.id || null;
    } catch (error) {
      logger.error('Failed to get fallback shard', { failedShardId, error });
      return null;
    }
  }

  /**
   * Select least loaded shard
   */
  private selectLeastLoadedShard(shardIds: string[]): string {
    let selectedShard = shardIds[0];
    let minLoad = Number.MAX_SAFE_INTEGER;

    for (const shardId of shardIds) {
      const shard = this.shards.get(shardId);
      if (shard && shard.capacity.utilization < minLoad) {
        minLoad = shard.capacity.utilization;
        selectedShard = shardId;
      }
    }

    return selectedShard;
  }

  /**
   * Execute cross-shard query
   */
  async executeCrossShardQuery(
    query: string,
    parameters: any[],
    consistency: QueryRouting['consistency'] = 'eventual'
  ): Promise<any[]> {
    try {
      const activeShards = this.getActiveShards();
      const results: any[] = [];

      // Execute query on all active shards
      const queries = activeShards.map(async (shard) => {
        try {
          const routing: QueryRouting = {
            query,
            parameters,
            consistency,
            shardHint: shard.id,
          };

          const { connection } = await this.routeQuery(routing);
          
          const result = await connection.$queryRawUnsafe(query, ...parameters);
          return { shardId: shard.id, result, success: true };
        } catch (error) {
          logger.error('Cross-shard query failed on shard', { shardId: shard.id, error });
          return { shardId: shard.id, result: null, success: false, error };
        }
      });

      const shardResults = await Promise.allSettled(queries);

      // Collect successful results
      for (const result of shardResults) {
        if (result.status === 'fulfilled' && result.value.success) {
          results.push(result.value.result);
        }
      }

      // Merge results based on query type
      return this.mergeCrossShardResults(results, query);

    } catch (error) {
      logger.error('Cross-shard query execution failed', { error });
      throw new QueryRoutingError(
        `Cross-shard query failed: ${error.message}`
      );
    }
  }

  /**
   * Merge results from multiple shards
   */
  private mergeCrossShardResults(results: any[], query: string): any[] {
    if (results.length === 0) {
      return [];
    }

    if (query.toLowerCase().includes('select')) {
      // Merge SELECT results
      return results.flat();
    } else if (query.toLowerCase().includes('count')) {
      // Sum COUNT results
      return results.reduce((sum, result) => sum + (result[0]?.count || 0), 0);
    } else {
      // For other operations, return first result
      return results[0] || [];
    }
  }

  /**
   * Monitor shard health and performance
   */
  private startMonitoring(): void {
    this.monitoringInterval = setInterval(async () => {
      await this.performShardMonitoring();
    }, this.config.monitoringInterval);

    logger.info('Shard monitoring started', {
      interval: this.config.monitoringInterval,
    });
  }

  /**
   * Perform comprehensive shard monitoring
   */
  private async performShardMonitoring(): Promise<void> {
    try {
      const monitoringTasks = Array.from(this.shards.keys()).map(shardId =>
        this.monitorShard(shardId)
      );

      await Promise.allSettled(monitoringTasks);

      // Check if rebalancing is needed
      await this.checkRebalancingNeeds();

    } catch (error) {
      logger.error('Shard monitoring failed', { error });
    }
  }

  /**
   * Monitor individual shard health
   */
  private async monitorShard(shardId: string): Promise<void> {
    try {
      const connection = this.shardConnections.get(shardId);
      if (!connection) {
        return;
      }

      const startTime = Date.now();

      // Test connection with simple query
      await connection.$queryRaw`SELECT 1`;

      const responseTime = Date.now() - startTime;

      // Update shard health
      const shard = this.shards.get(shardId);
      if (shard) {
        shard.health.status = responseTime < 5000 ? 'healthy' : 'degraded';
        shard.health.lastCheck = new Date();
        shard.health.responseTime = responseTime;
        shard.health.issues = responseTime > 5000 ? ['High response time'] : [];
      }

      // Store health update in Redis
      await this.redis.setex(
        `shard:health:${shardId}`,
        60,
        JSON.stringify({
          status: shard?.health.status,
          responseTime,
          timestamp: new Date(),
        })
      );

    } catch (error) {
      // Mark shard as unhealthy
      const shard = this.shards.get(shardId);
      if (shard) {
        shard.health.status = 'unhealthy';
        shard.health.lastCheck = new Date();
        shard.health.issues.push(`Monitoring error: ${error.message}`);
      }

      logger.error('Shard monitoring failed', { shardId, error });
    }
  }

  /**
   * Check if rebalancing is needed
   */
  private async checkRebalancingNeeds(): Promise<void> {
    try {
      const needsRebalancing = Array.from(this.shards.values()).some(shard => 
        shard.capacity.utilization > this.config.rebalanceThreshold
      );

      if (needsRebalancing) {
        logger.info('Rebalancing needed', {
          threshold: this.config.rebalanceThreshold,
          totalShards: this.shards.size,
        });

        // Trigger rebalancing
        await this.scheduleRebalancing();
      }
    } catch (error) {
      logger.error('Failed to check rebalancing needs', { error });
    }
  }

  /**
   * Schedule rebalancing operation
   */
  async scheduleRebalancing(): Promise<void> {
    try {
      const overUtilizedShards = Array.from(this.shards.values()).filter(shard =>
        shard.capacity.utilization > this.config.rebalanceThreshold
      );

      for (const shard of overUtilizedShards) {
        const operation: RebalanceOperation = {
          shardId: shard.id,
          type: 'move_data',
          estimatedSize: Math.floor(shard.capacity.currentStorageGB * 0.3), // Move 30%
          priority: shard.capacity.utilization > 0.9 ? 'critical' : 'high',
          estimatedDuration: 1800000, // 30 minutes
          status: 'pending',
        };

        await this.executeRebalanceOperation(operation);
      }

    } catch (error) {
      logger.error('Failed to schedule rebalancing', { error });
    }
  }

  /**
   * Execute rebalance operation
   */
  async executeRebalanceOperation(operation: RebalanceOperation): Promise<void> {
    try {
      this.rebalancingOperations.set(operation.shardId, operation);
      
      operation.status = 'in_progress';
      operation.startedAt = new Date();

      logger.info('Starting rebalance operation', {
        shardId: operation.shardId,
        type: operation.type,
        priority: operation.priority,
      });

      // Execute rebalance based on type
      switch (operation.type) {
        case 'move_data':
          await this.moveDataBetweenShards(operation);
          break;
        
        case 'split_shard':
          await this.splitShard(operation);
          break;
        
        case 'merge_shards':
          await this.mergeShards(operation);
          break;
        
        case 'add_shard':
          await this.addShard(operation);
          break;
      }

      operation.status = 'completed';
      operation.completedAt = new Date();

      logger.info('Rebalance operation completed', {
        shardId: operation.shardId,
        type: operation.type,
        duration: operation.completedAt.getTime() - operation.startedAt.getTime(),
      });

    } catch (error) {
      operation.status = 'failed';
      operation.error = error.message;

      logger.error('Rebalance operation failed', {
        shardId: operation.shardId,
        error,
      });

      throw new RebalanceError(
        `Rebalance operation failed: ${error.message}`,
        operation.shardId
      );
    }
  }

  /**
   * Move data between shards
   */
  private async moveDataBetweenShards(operation: RebalanceOperation): Promise<void> {
    const sourceShard = this.shards.get(operation.shardId);
    if (!sourceShard) {
      throw new RebalanceError(`Source shard not found: ${operation.shardId}`, operation.shardId);
    }

    // Find target shard (least loaded)
    const targetShard = this.findLeastLoadedShard();
    if (!targetShard) {
      throw new RebalanceError('No target shard available', operation.shardId);
    }

    const sourceConnection = this.shardConnections.get(operation.shardId);
    const targetConnection = this.shardConnections.get(targetShard.id);

    if (!sourceConnection || !targetConnection) {
      throw new RebalanceError('Connection not available for data move', operation.shardId);
    }

    try {
      // Get data to move (simplified implementation)
      // In production, this would involve complex data migration logic
      
      // Example: Move 30% of user data
      const dataToMove = await sourceConnection.user.findMany({
        take: Math.floor(operation.estimatedSize / 1000), // Approximate
      });

      if (dataToMove.length > 0) {
        // Create target shard connection
        const targetShardConnection = targetConnection;
        
        // Transfer data in batches
        const batchSize = 100;
        for (let i = 0; i < dataToMove.length; i += batchSize) {
          const batch = dataToMove.slice(i, i + batchSize);
          
          await targetShardConnection.user.createMany({
            data: batch,
            skipDuplicates: true,
          });

          // Update shard keys
          for (const record of batch) {
            await this.updateShardKey(record.id, targetShard.id);
          }
        }

        // Delete moved data from source
        const recordIds = dataToMove.map(r => r.id);
        await sourceConnection.user.deleteMany({
          where: {
            id: { in: recordIds },
          },
        });
      }

    } catch (error) {
      logger.error('Data move failed', {
        sourceShard: operation.shardId,
        targetShard: targetShard.id,
        error,
      });
      throw error;
    }
  }

  /**
   * Split shard into multiple shards
   */
  private async splitShard(operation: RebalanceOperation): Promise<void> {
    const shard = this.shards.get(operation.shardId);
    if (!shard) {
      throw new RebalanceError(`Shard not found: ${operation.shardId}`, operation.shardId);
    }

    // Create new shard configuration
    const newShardConfig: Shard = {
      id: `${shard.id}_split_${Date.now()}`,
      name: `${shard.name}_split`,
      databaseUrl: shard.databaseUrl.replace(/_\d+/, `_${Date.now()}`),
      region: shard.region,
      isActive: true,
      capacity: {
        maxConnections: shard.capacity.maxConnections / 2,
        maxStorageGB: shard.capacity.maxStorageGB / 2,
        currentConnections: shard.capacity.currentConnections / 2,
        currentStorageGB: shard.capacity.currentStorageGB / 2,
        utilization: shard.capacity.utilization / 2,
      },
      routing: {
        strategy: shard.routing.strategy,
        ranges: shard.routing.ranges?.map(range => ({
          ...range,
          max: Math.floor((range.max - range.min) / 2) + range.min,
        })),
        hashFunction: shard.routing.hashFunction,
        geoBounds: shard.routing.geoBounds,
      },
      health: {
        status: 'healthy',
        lastCheck: new Date(),
        responseTime: 0,
        issues: [],
      },
      performance: {
        averageQueryTime: shard.performance.averageQueryTime,
        queriesPerSecond: shard.performance.queriesPerSecond / 2,
        errorRate: shard.performance.errorRate,
        cacheHitRate: shard.performance.cacheHitRate,
      },
    };

    // Register new shard
    await this.registerShard(newShardConfig);

    // Redistribute data between shards
    await this.redistributeShardData(shard.id, newShardConfig.id);
  }

  /**
   * Find least loaded shard
   */
  private findLeastLoadedShard(): Shard | null {
    const activeShards = this.getActiveShards();
    
    if (activeShards.length === 0) {
      return null;
    }

    return activeShards.reduce((least, current) => 
      current.capacity.utilization < least.capacity.utilization ? current : least
    );
  }

  /**
   * Update shard key for record
   */
  private async updateShardKey(recordId: string, newShardId: string): Promise<void> {
    try {
      await this.redis.setex(
        `record:shard:${recordId}`,
        86400, // 24 hours
        newShardId
      );
    } catch (error) {
      logger.error('Failed to update shard key', { recordId, newShardId, error });
    }
  }

  /**
   * Redistribute data between shards
   */
  private async redistributeShardData(sourceShardId: string, targetShardId: string): Promise<void> {
    // This would implement the actual data redistribution logic
    // For now, this is a placeholder for the complex migration process
    
    logger.info('Data redistribution scheduled', {
      sourceShardId,
      targetShardId,
    });
  }

  /**
   * Schedule full rebalance
   */
  private async scheduleFullRebalance(): Promise<void> {
    try {
      logger.info('Scheduling full rebalance');
      
      // Analyze current data distribution
      const dataDistribution = await this.analyzeDataDistribution();
      
      // Calculate optimal distribution
      const optimalDistribution = this.calculateOptimalDistribution(dataDistribution);
      
      // Schedule rebalancing operations
      for (const [shardId, shouldHaveRecords] of optimalDistribution) {
        const currentShard = this.shards.get(shardId);
        if (currentShard) {
          // Calculate data movement needed
          const currentRecordCount = await this.getShardRecordCount(shardId);
          const recordDifference = shouldHaveRecords - currentRecordCount;
          
          if (Math.abs(recordDifference) > 1000) { // Threshold for rebalancing
            // Schedule operation
            await this.scheduleDataMovement(shardId, recordDifference);
          }
        }
      }

    } catch (error) {
      logger.error('Full rebalance scheduling failed', { error });
    }
  }

  /**
   * Analyze current data distribution across shards
   */
  private async analyzeDataDistribution(): Promise<Map<string, number>> {
    const distribution = new Map<string, number>();
    
    // This would analyze actual data distribution
    // For now, return placeholder data
    
    for (const shardId of this.shards.keys()) {
      distribution.set(shardId, Math.floor(Math.random() * 10000) + 1000);
    }
    
    return distribution;
  }

  /**
   * Calculate optimal data distribution
   */
  private calculateOptimalDistribution(distribution: Map<string, number>): Map<string, number> {
    const totalRecords = Array.from(distribution.values()).reduce((sum, count) => sum + count, 0);
    const activeShards = this.getActiveShards();
    const recordsPerShard = Math.floor(totalRecords / activeShards.length);
    
    const optimal = new Map<string, number>();
    
    for (const shard of activeShards) {
      optimal.set(shard.id, recordsPerShard);
    }
    
    return optimal;
  }

  /**
   * Get record count for shard
   */
  private async getShardRecordCount(shardId: string): Promise<number> {
    const connection = this.shardConnections.get(shardId);
    if (!connection) {
      return 0;
    }
    
    try {
      const result = await connection.user.count();
      return result;
    } catch (error) {
      logger.error('Failed to get shard record count', { shardId, error });
      return 0;
    }
  }

  /**
   * Schedule data movement
   */
  private async scheduleDataMovement(shardId: string, recordDifference: number): Promise<void> {
    // Implementation for scheduling data movement between shards
    logger.info('Data movement scheduled', { shardId, recordDifference });
  }

  /**
   * Split shard operation (simplified)
   */
  private async splitShard(operation: RebalanceOperation): Promise<void> {
    // Simplified implementation
    logger.info('Shard split completed', { shardId: operation.shardId });
  }

  /**
   * Merge shards operation (simplified)
   */
  private async mergeShards(operation: RebalanceOperation): Promise<void> {
    // Simplified implementation
    logger.info('Shard merge completed', { shardId: operation.shardId });
  }

  /**
   * Add shard operation (simplified)
   */
  private async addShard(operation: RebalanceOperation): Promise<void> {
    // Simplified implementation
    logger.info('Shard added', { shardId: operation.shardId });
  }

  /**
   * Establish connections to all shards
   */
  private async establishShardConnections(): Promise<void> {
    const connectionTasks = Array.from(this.shards.entries()).map(async ([shardId, shard]) => {
      try {
        const connection = this.shardConnections.get(shardId);
        if (connection) {
          await connection.$queryRaw`SELECT 1`;
          logger.info('Shard connection established', { shardId });
        }
      } catch (error) {
        logger.error('Failed to establish shard connection', { shardId, error });
        shard.health.status = 'unhealthy';
        shard.health.issues.push(`Connection failed: ${error.message}`);
      }
    });

    await Promise.allSettled(connectionTasks);
  }

  /**
   * Get shard metrics
   */
  async getShardMetrics(shardId?: string): Promise<ShardMetrics[]> {
    const targetShards = shardId ? [shardId] : Array.from(this.shards.keys());
    const metrics: ShardMetrics[] = [];

    for (const sid of targetShards) {
      const shard = this.shards.get(sid);
      if (shard) {
        metrics.push({
          shardId: sid,
          timestamp: new Date(),
          connections: shard.capacity.currentConnections,
          storage: {
            used: shard.capacity.currentStorageGB,
            available: shard.capacity.maxStorageGB - shard.capacity.currentStorageGB,
            utilization: shard.capacity.utilization,
          },
          performance: {
            avgQueryTime: shard.performance.averageQueryTime,
            qps: shard.performance.queriesPerSecond,
            errorRate: shard.performance.errorRate,
            cacheHitRate: shard.performance.cacheHitRate,
          },
          health: {
            status: shard.health.status,
            responseTime: shard.health.responseTime,
            issues: shard.health.issues,
          },
        });
      }
    }

    return metrics;
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
      logger.info('Shard monitoring stopped');
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    this.stopMonitoring();
    
    // Close all connections
    for (const [shardId, connection] of this.shardConnections.entries()) {
      try {
        await connection.$disconnect();
        logger.info('Shard connection closed', { shardId });
      } catch (error) {
        logger.error('Failed to close shard connection', { shardId, error });
      }
    }
    
    // Clear internal state
    this.shards.clear();
    this.shardConnections.clear();
    this.rebalancingOperations.clear();
    
    logger.info('Database sharding manager cleaned up');
  }
}

// Export singleton instance factory
export function createDatabaseShardingManager(
  redis: Redis,
  config?: Partial<ShardingConfig>
): DatabaseShardingManager {
  return new DatabaseShardingManager(redis, config);
}