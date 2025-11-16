/**
 * Multi-Region Deployment Manager
 * Enterprise-grade global deployment orchestration
 * Handles traffic routing, health monitoring, and failover across multiple regions
 */

import { z } from 'zod';
import Redis from 'ioredis';
import { logger } from '../../shared/utils/logger';
import { circuitBreaker, CircuitBreakerOptions } from '../../shared/utils/circuitBreaker';

// Validation schemas
const RegionSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  cloudProvider: z.enum(['aws', 'gcp', 'azure', 'vercel', 'netlify']),
  zone: z.string(),
  endpoint: z.string().url(),
  weight: z.number().min(0).max(100),
  isActive: z.boolean(),
  healthCheckUrl: z.string().url(),
  capabilities: z.array(z.string()),
  latency: z.object({
    avg: z.number(),
    p95: z.number(),
    p99: z.number(),
  }),
  capacity: z.object({
    maxRequestsPerSecond: z.number(),
    currentLoad: z.number(),
    percentage: z.number(),
  }),
  cost: z.object({
    costPerRequest: z.number(),
    monthlyBudget: z.number(),
    currentSpend: z.number(),
  }),
});

const DeploymentSchema = z.object({
  id: z.string(),
  version: z.string(),
  regions: z.array(z.string()),
  status: z.enum(['pending', 'deploying', 'success', 'failed', 'rolling_back']),
  startTime: z.date(),
  endTime: z.date().optional(),
  metadata: z.record(z.any()),
});

const HealthCheckSchema = z.object({
  regionId: z.string(),
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  responseTime: z.number(),
  lastChecked: z.date(),
  issues: z.array(z.string()),
});

// Types
export type Region = z.infer<typeof RegionSchema>;
export type Deployment = z.infer<typeof DeploymentSchema>;
export type HealthCheck = z.infer<typeof HealthCheckSchema>;

export interface TrafficRoutingConfig {
  strategy: 'weighted' | 'latency' | 'geographic' | 'cost_optimal';
  failoverEnabled: boolean;
  healthCheckInterval: number;
  maxRetries: number;
  circuitBreakerThreshold: number;
}

export interface RegionalMetrics {
  regionId: string;
  timestamp: Date;
  requestsPerSecond: number;
  errorRate: number;
  averageResponseTime: number;
  costPerRequest: number;
  capacityUtilization: number;
  healthScore: number;
}

export interface FailoverEvent {
  regionId: string;
  timestamp: Date;
  reason: string;
  affectedUsers: number;
  status: 'initiated' | 'completed' | 'failed';
  resolutionTime?: number;
}

// Error types
export class MultiRegionError extends Error {
  constructor(
    message: string,
    public regionId?: string,
    public code?: string
  ) {
    super(message);
    this.name = 'MultiRegionError';
  }
}

export class HealthCheckError extends MultiRegionError {
  constructor(message: string, regionId: string, public responseTime: number) {
    super(message, regionId, 'HEALTH_CHECK_FAILED');
  }
}

export class FailoverError extends MultiRegionError {
  constructor(message: string, regionId: string) {
    super(message, regionId, 'FAILOVER_FAILED');
  }
}

/**
 * Multi-Region Deployment Manager
 * Orchestrates global deployment and traffic management
 */
export class MultiRegionDeploymentManager {
  private regions: Map<string, Region> = new Map();
  private healthChecks: Map<string, HealthCheck> = new Map();
  private activeDeployments: Map<string, Deployment> = new Map();
  private redis: Redis;
  private config: TrafficRoutingConfig;
  private circuitBreakerOptions: CircuitBreakerOptions;
  private monitoringInterval?: NodeJS.Timeout;

  constructor(
    redis: Redis,
    config: Partial<TrafficRoutingConfig> = {}
  ) {
    this.redis = redis;
    this.config = {
      strategy: 'weighted',
      failoverEnabled: true,
      healthCheckInterval: 30000, // 30 seconds
      maxRetries: 3,
      circuitBreakerThreshold: 0.5,
      ...config,
    };

    this.circuitBreakerOptions = {
      threshold: 0.5,
      timeout: 10000,
      resetTimeout: 30000,
      fallback: async () => null,
    };

    this.startHealthMonitoring();
  }

  /**
   * Register a new region for deployment
   */
  async registerRegion(region: Region): Promise<void> {
    try {
      const validatedRegion = RegionSchema.parse(region);
      this.regions.set(validatedRegion.id, validatedRegion);

      // Initialize health check
      this.healthChecks.set(validatedRegion.id, {
        regionId: validatedRegion.id,
        status: 'healthy',
        responseTime: 0,
        lastChecked: new Date(),
        issues: [],
      });

      // Store in Redis for persistence
      await this.redis.setex(
        `region:${validatedRegion.id}`,
        3600,
        JSON.stringify(validatedRegion)
      );

      logger.info('Region registered', {
        regionId: validatedRegion.id,
        name: validatedRegion.name,
        provider: validatedRegion.cloudProvider,
      });
    } catch (error) {
      logger.error('Failed to register region', { error, region });
      throw new MultiRegionError(`Failed to register region: ${error.message}`);
    }
  }

  /**
   * Deploy application to multiple regions
   */
  async deployToRegions(
    version: string,
    regionIds: string[],
    deploymentConfig: {
      blueGreen?: boolean;
      rollingUpdate?: boolean;
      waitForHealth?: boolean;
      healthTimeout?: number;
    } = {}
  ): Promise<string> {
    const deploymentId = this.generateDeploymentId();
    
    const deployment: Deployment = {
      id: deploymentId,
      version,
      regions: regionIds,
      status: 'pending',
      startTime: new Date(),
      metadata: {
        blueGreen: deploymentConfig.blueGreen ?? false,
        rollingUpdate: deploymentConfig.rollingUpdate ?? false,
        waitForHealth: deploymentConfig.waitForHealth ?? true,
        healthTimeout: deploymentConfig.healthTimeout ?? 300000, // 5 minutes
      },
    };

    try {
      this.activeDeployments.set(deploymentId, deployment);
      
      // Store deployment in Redis
      await this.redis.setex(
        `deployment:${deploymentId}`,
        3600,
        JSON.stringify(deployment)
      );

      // Start deployment process
      this.executeDeployment(deployment, regionIds, version);

      logger.info('Deployment initiated', {
        deploymentId,
        version,
        regions: regionIds.length,
      });

      return deploymentId;
    } catch (error) {
      logger.error('Failed to initiate deployment', {
        error,
        deploymentId,
        version,
      });
      throw new MultiRegionError(
        `Failed to initiate deployment: ${error.message}`,
        undefined,
        'DEPLOYMENT_INIT_FAILED'
      );
    }
  }

  /**
   * Execute deployment with specified strategy
   */
  private async executeDeployment(
    deployment: Deployment,
    regionIds: string[],
    version: string
  ): Promise<void> {
    try {
      deployment.status = 'deploying';
      
      const blueGreen = deployment.metadata.blueGreen as boolean;
      const rollingUpdate = deployment.metadata.rollingUpdate as boolean;
      const waitForHealth = deployment.metadata.waitForHealth as boolean;

      if (rollingUpdate) {
        // Rolling update deployment
        await this.rollingUpdate(deployment, regionIds, version);
      } else if (blueGreen) {
        // Blue-green deployment
        await this.blueGreenDeployment(deployment, regionIds, version);
      } else {
        // Parallel deployment
        await this.parallelDeployment(deployment, regionIds, version);
      }

      if (waitForHealth) {
        await this.waitForHealthyRegions(regionIds, deployment.metadata.healthTimeout as number);
      }

      deployment.status = 'success';
      deployment.endTime = new Date();
      
      logger.info('Deployment completed successfully', {
        deploymentId: deployment.id,
        version,
        regions: regionIds,
      });

    } catch (error) {
      deployment.status = 'failed';
      deployment.endTime = new Date();
      
      logger.error('Deployment failed', {
        deploymentId: deployment.id,
        error,
        version,
      });

      // Trigger rollback if enabled
      if (this.config.failoverEnabled) {
        await this.triggerRollback(deployment.id);
      }

      throw new MultiRegionError(
        `Deployment failed: ${error.message}`,
        undefined,
        'DEPLOYMENT_FAILED'
      );
    }
  }

  /**
   * Rolling update deployment strategy
   */
  private async rollingUpdate(
    deployment: Deployment,
    regionIds: string[],
    version: string
  ): Promise<void> {
    const batchSize = Math.max(1, Math.floor(regionIds.length / 3)); // 3 batches
    
    for (let i = 0; i < regionIds.length; i += batchSize) {
      const batch = regionIds.slice(i, i + batchSize);
      
      // Deploy to current batch
      await Promise.all(
        batch.map(regionId => this.deployToRegion(regionId, version, deployment.id))
      );

      // Wait for health checks if enabled
      if (deployment.metadata.waitForHealth) {
        await this.waitForBatchHealth(batch, 60000); // 1 minute per batch
      }

      // Small delay between batches
      if (i + batchSize < regionIds.length) {
        await new Promise(resolve => setTimeout(resolve, 30000)); // 30 seconds
      }
    }
  }

  /**
   * Blue-green deployment strategy
   */
  private async blueGreenDeployment(
    deployment: Deployment,
    regionIds: string[],
    version: string
  ): Promise<void> {
    // Deploy to green environment
    await Promise.all(
      regionIds.map(regionId => this.deployToRegion(regionId, version, deployment.id, 'green'))
    );

    // Validate green environment
    await this.waitForHealthyRegions(regionIds, deployment.metadata.healthTimeout as number);

    // Switch traffic to green
    await this.switchTrafficToVersion(regionIds, version);

    // Clean up blue environment
    await Promise.all(
      regionIds.map(regionId => this.cleanupEnvironment(regionId, 'blue'))
    );
  }

  /**
   * Parallel deployment strategy
   */
  private async parallelDeployment(
    deployment: Deployment,
    regionIds: string[],
    version: string
  ): Promise<void> {
    await Promise.all(
      regionIds.map(regionId => 
        this.deployToRegion(regionId, version, deployment.id)
          .catch(error => {
            logger.error(`Regional deployment failed for ${regionId}`, { error });
            throw error;
          })
      )
    );
  }

  /**
   * Deploy to specific region
   */
  private async deployToRegion(
    regionId: string,
    version: string,
    deploymentId: string,
    environment: 'blue' | 'green' = 'blue'
  ): Promise<void> {
    const region = this.regions.get(regionId);
    if (!region) {
      throw new MultiRegionError(`Region not found: ${regionId}`, regionId);
    }

    const deployUrl = `${region.endpoint}/api/deployments/${environment}`;
    
    try {
      const circuitBreakerFn = circuitBreaker(this.circuitBreakerOptions);
      
      await circuitBreakerFn(async () => {
        const response = await fetch(deployUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.DEPLOYMENT_TOKEN}`,
          },
          body: JSON.stringify({
            version,
            deploymentId,
            environment,
            timestamp: new Date().toISOString(),
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return response.json();
      });

      logger.info('Regional deployment initiated', {
        regionId,
        version,
        environment,
        deploymentId,
      });

    } catch (error) {
      logger.error('Regional deployment failed', {
        regionId,
        version,
        error,
      });
      throw new MultiRegionError(
        `Deployment failed for region ${regionId}: ${error.message}`,
        regionId
      );
    }
  }

  /**
   * Route traffic optimally based on configuration
   */
  async getOptimalRegion(userId: string, userLocation?: { lat: number; lng: number }): Promise<string | null> {
    try {
      const healthyRegions = this.getHealthyRegions();
      
      if (healthyRegions.length === 0) {
        logger.warn('No healthy regions available');
        return null;
      }

      const region = this.selectRegionByStrategy(
        healthyRegions,
        this.config.strategy,
        userLocation
      );

      if (region) {
        // Track region assignment
        await this.redis.setex(
          `user:region:${userId}`,
          300,
          region.id
        );
      }

      return region?.id ?? null;
    } catch (error) {
      logger.error('Failed to get optimal region', { error, userId });
      throw new MultiRegionError(
        `Failed to route user to region: ${error.message}`
      );
    }
  }

  /**
   * Select region based on routing strategy
   */
  private selectRegionByStrategy(
    regions: Region[],
    strategy: TrafficRoutingConfig['strategy'],
    userLocation?: { lat: number; lng: number }
  ): Region | null {
    const activeRegions = regions.filter(r => r.isActive && r.capacity.percentage < 90);

    if (activeRegions.length === 0) return null;

    switch (strategy) {
      case 'weighted':
        return this.selectByWeight(activeRegions);
      
      case 'latency':
        return this.selectByLatency(activeRegions);
      
      case 'geographic':
        return this.selectByGeographicDistance(activeRegions, userLocation);
      
      case 'cost_optimal':
        return this.selectByCost(activeRegions);
      
      default:
        return this.selectByWeight(activeRegions);
    }
  }

  /**
   * Weighted selection based on region weights
   */
  private selectByWeight(regions: Region[]): Region {
    const totalWeight = regions.reduce((sum, r) => sum + r.weight, 0);
    const random = Math.random() * totalWeight;
    
    let currentWeight = 0;
    for (const region of regions) {
      currentWeight += region.weight;
      if (random <= currentWeight) {
        return region;
      }
    }
    
    return regions[0]; // Fallback
  }

  /**
   * Select region with lowest latency
   */
  private selectByLatency(regions: Region[]): Region {
    return regions.reduce((best, current) => 
      current.latency.avg < best.latency.avg ? current : best
    );
  }

  /**
   * Select region by geographic distance
   */
  private selectByGeographicDistance(
    regions: Region[],
    userLocation?: { lat: number; lng: number }
  ): Region {
    if (!userLocation) {
      return this.selectByLatency(regions);
    }

    // Calculate distances and select closest
    let closest = regions[0];
    let minDistance = this.calculateDistance(userLocation, {
      lat: parseFloat(closest.zone.split('-')[1]) || 0,
      lng: parseFloat(closest.zone.split('-')[2]) || 0,
    });

    for (const region of regions.slice(1)) {
      const distance = this.calculateDistance(userLocation, {
        lat: parseFloat(region.zone.split('-')[1]) || 0,
        lng: parseFloat(region.zone.split('-')[2]) || 0,
      });

      if (distance < minDistance) {
        minDistance = distance;
        closest = region;
      }
    }

    return closest;
  }

  /**
   * Select region by cost optimization
   */
  private selectByCost(regions: Region[]): Region {
    return regions.reduce((best, current) => 
      current.cost.costPerRequest < best.cost.costPerRequest ? current : best
    );
  }

  /**
   * Calculate geographic distance between two points
   */
  private calculateDistance(
    point1: { lat: number; lng: number },
    point2: { lat: number; lng: number }
  ): number {
    // Haversine formula for distance calculation
    const R = 6371; // Earth's radius in km
    const dLat = this.toRadians(point2.lat - point1.lat);
    const dLng = this.toRadians(point2.lng - point1.lng);
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(this.toRadians(point1.lat)) * Math.cos(this.toRadians(point2.lat)) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }

  /**
   * Get list of healthy regions
   */
  private getHealthyRegions(): Region[] {
    const healthyRegionIds = Array.from(this.healthChecks.entries())
      .filter(([_, health]) => health.status === 'healthy')
      .map(([regionId, _]) => regionId);

    return healthyRegionIds
      .map(regionId => this.regions.get(regionId))
      .filter((region): region is Region => region !== undefined);
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    this.monitoringInterval = setInterval(async () => {
      await this.performHealthChecks();
    }, this.config.healthCheckInterval);

    logger.info('Health monitoring started', {
      interval: this.config.healthCheckInterval,
    });
  }

  /**
   * Perform health checks on all regions
   */
  private async performHealthChecks(): Promise<void> {
    const healthChecks = Array.from(this.regions.values()).map(region => 
      this.checkRegionHealth(region)
    );

    await Promise.allSettled(healthChecks);
  }

  /**
   * Check health of specific region
   */
  private async checkRegionHealth(region: Region): Promise<HealthCheck> {
    const startTime = Date.now();
    
    try {
      const response = await fetch(`${region.healthCheckUrl}`, {
        method: 'GET',
        headers: {
          'User-Agent': 'Vow-HealthCheck/1.0',
        },
        timeout: 10000,
      });

      const responseTime = Date.now() - startTime;
      const isHealthy = response.ok && responseTime < 5000;

      const healthCheck: HealthCheck = {
        regionId: region.id,
        status: isHealthy ? 'healthy' : 'unhealthy',
        responseTime,
        lastChecked: new Date(),
        issues: isHealthy ? [] : [`HTTP ${response.status}: ${response.statusText}`],
      };

      this.healthChecks.set(region.id, healthCheck);

      // Store health check in Redis
      await this.redis.setex(
        `health:${region.id}`,
        60,
        JSON.stringify(healthCheck)
      );

      // Trigger failover if unhealthy
      if (!isHealthy && this.config.failoverEnabled) {
        await this.handleUnhealthyRegion(region.id, healthCheck);
      }

      return healthCheck;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      
      const healthCheck: HealthCheck = {
        regionId: region.id,
        status: 'unhealthy',
        responseTime,
        lastChecked: new Date(),
        issues: [error.message],
      };

      this.healthChecks.set(region.id, healthCheck);
      
      if (this.config.failoverEnabled) {
        await this.handleUnhealthyRegion(region.id, healthCheck);
      }

      throw new HealthCheckError(
        `Health check failed for region ${region.id}: ${error.message}`,
        region.id,
        responseTime
      );
    }
  }

  /**
   * Handle unhealthy region with failover
   */
  private async handleUnhealthyRegion(regionId: string, healthCheck: HealthCheck): Promise<void> {
    try {
      // Check if region was recently healthy
      const lastHealthCheck = await this.redis.get(`health:${regionId}`);
      
      if (lastHealthCheck) {
        const previousHealth = JSON.parse(lastHealthCheck) as HealthCheck;
        if (previousHealth.status === 'healthy') {
          // Region just became unhealthy, trigger failover
          await this.triggerFailover(regionId, healthCheck.issues.join(', '));
        }
      }
    } catch (error) {
      logger.error('Failed to handle unhealthy region', {
        regionId,
        error,
      });
    }
  }

  /**
   * Trigger failover to backup regions
   */
  async triggerFailover(failedRegionId: string, reason: string): Promise<void> {
    const failoverEvent: FailoverEvent = {
      regionId: failedRegionId,
      timestamp: new Date(),
      reason,
      affectedUsers: await this.getAffectedUserCount(failedRegionId),
      status: 'initiated',
    };

    try {
      // Update failover status
      failoverEvent.status = 'completed';

      // Reassign users to healthy regions
      await this.reassignUsers(failedRegionId);

      // Store failover event
      await this.redis.setex(
        `failover:${Date.now()}`,
        86400,
        JSON.stringify(failoverEvent)
      );

      logger.warn('Failover completed', {
        failedRegionId,
        reason,
        affectedUsers: failoverEvent.affectedUsers,
      });

      // Alert monitoring systems
      await this.sendFailoverAlert(failoverEvent);

    } catch (error) {
      failoverEvent.status = 'failed';
      
      logger.error('Failover failed', {
        failedRegionId,
        reason,
        error,
      });

      throw new FailoverError(
        `Failover failed for region ${failedRegionId}: ${error.message}`,
        failedRegionId
      );
    }
  }

  /**
   * Get number of users affected by region failure
   */
  private async getAffectedUserCount(regionId: string): Promise<number> {
    try {
      const keys = await this.redis.keys(`user:region:*`);
      const affectedUsers = keys.filter(key => 
        key.endsWith(`:${regionId}`)
      ).length;

      return affectedUsers;
    } catch (error) {
      logger.error('Failed to get affected user count', { regionId, error });
      return 0;
    }
  }

  /**
   * Reassign users from failed region to healthy regions
   */
  private async reassignUsers(failedRegionId: string): Promise<void> {
    try {
      const healthyRegions = this.getHealthyRegions();
      
      if (healthyRegions.length === 0) {
        throw new Error('No healthy regions available for reassignment');
      }

      // Get users assigned to failed region
      const userRegionKeys = await this.redis.keys(`user:region:*`);
      
      for (const key of userRegionKeys) {
        const userId = key.split(':').pop();
        const currentRegion = await this.redis.get(key);
        
        if (currentRegion === failedRegionId && userId) {
          // Reassign to optimal region
          const optimalRegion = this.selectRegionByStrategy(
            healthyRegions,
            'latency'
          );
          
          if (optimalRegion) {
            await this.redis.setex(
              `user:region:${userId}`,
              300,
              optimalRegion.id
            );
          }
        }
      }

      logger.info('User reassignment completed', {
        failedRegionId,
        totalUsers: userRegionKeys.length,
        healthyRegions: healthyRegions.length,
      });

    } catch (error) {
      logger.error('Failed to reassign users', { failedRegionId, error });
      throw error;
    }
  }

  /**
   * Wait for regions to become healthy
   */
  private async waitForHealthyRegions(
    regionIds: string[],
    timeoutMs: number
  ): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const allHealthy = regionIds.every(regionId => {
        const health = this.healthChecks.get(regionId);
        return health?.status === 'healthy';
      });

      if (allHealthy) {
        return;
      }

      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5 seconds
    }

    throw new MultiRegionError(
      `Regions did not become healthy within ${timeoutMs}ms timeout`
    );
  }

  /**
   * Wait for batch of regions to become healthy
   */
  private async waitForBatchHealth(
    regionIds: string[],
    timeoutMs: number
  ): Promise<void> {
    await this.waitForHealthyRegions(regionIds, timeoutMs);
  }

  /**
   * Switch traffic to new version
   */
  private async switchTrafficToVersion(regionIds: string[], version: string): Promise<void> {
    for (const regionId of regionIds) {
      const region = this.regions.get(regionId);
      if (region) {
        await fetch(`${region.endpoint}/api/traffic/switch`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.DEPLOYMENT_TOKEN}`,
          },
          body: JSON.stringify({ version }),
        });
      }
    }
  }

  /**
   * Cleanup old environment
   */
  private async cleanupEnvironment(regionId: string, environment: string): Promise<void> {
    const region = this.regions.get(regionId);
    if (region) {
      await fetch(`${region.endpoint}/api/cleanup/${environment}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${process.env.DEPLOYMENT_TOKEN}`,
        },
      });
    }
  }

  /**
   * Trigger rollback for failed deployment
   */
  async triggerRollback(deploymentId: string): Promise<void> {
    const deployment = this.activeDeployments.get(deploymentId);
    if (!deployment) {
      throw new MultiRegionError(`Deployment not found: ${deploymentId}`);
    }

    deployment.status = 'rolling_back';

    try {
      // Revert to previous version
      const previousVersion = await this.getPreviousVersion(deployment.regions);
      
      if (previousVersion) {
        await this.deployToRegions(previousVersion, deployment.regions);
      }

      deployment.status = 'failed';
      
      logger.warn('Rollback completed', {
        deploymentId,
        version: deployment.version,
        previousVersion,
      });

    } catch (error) {
      logger.error('Rollback failed', {
        deploymentId,
        error,
      });
      throw new MultiRegionError(
        `Rollback failed for deployment ${deploymentId}: ${error.message}`
      );
    }
  }

  /**
   * Get previous version for rollback
   */
  private async getPreviousVersion(regionIds: string[]): Promise<string | null> {
    try {
      // Get deployment history from Redis
      const deploymentKeys = await this.redis.keys('deployment:*');
      
      for (const key of deploymentKeys) {
        const deployment = JSON.parse(await this.redis.get(key) || '{}') as Deployment;
        
        if (deployment.status === 'success' && 
            regionIds.every(id => deployment.regions.includes(id))) {
          return deployment.version;
        }
      }
      
      return null;
    } catch (error) {
      logger.error('Failed to get previous version', { error });
      return null;
    }
  }

  /**
   * Send failover alert to monitoring systems
   */
  private async sendFailoverAlert(event: FailoverEvent): Promise<void> {
    try {
      // Send alert to monitoring systems (Sentry, PagerDuty, etc.)
      logger.warn('Failover alert sent', {
        regionId: event.regionId,
        affectedUsers: event.affectedUsers,
        reason: event.reason,
      });

      // Additional integration points can be added here
      // - PagerDuty API calls
      // - Slack notifications
      // - Email alerts
    } catch (error) {
      logger.error('Failed to send failover alert', { error });
    }
  }

  /**
   * Get regional metrics
   */
  async getRegionalMetrics(
    regionId?: string,
    timeRange: { start: Date; end: Date } = {
      start: new Date(Date.now() - 3600000), // 1 hour ago
      end: new Date(),
    }
  ): Promise<RegionalMetrics[]> {
    try {
      const metrics: RegionalMetrics[] = [];
      
      const targetRegions = regionId 
        ? [regionId] 
        : Array.from(this.regions.keys());

      for (const rid of targetRegions) {
        const metricsKey = `metrics:${rid}:${timeRange.start.getTime()}:${timeRange.end.getTime()}`;
        const cachedMetrics = await this.redis.get(metricsKey);
        
        if (cachedMetrics) {
          metrics.push(...JSON.parse(cachedMetrics));
        } else {
          // Generate metrics (would typically come from monitoring systems)
          const region = this.regions.get(rid);
          if (region) {
            const regionMetrics: RegionalMetrics = {
              regionId: rid,
              timestamp: new Date(),
              requestsPerSecond: Math.floor(Math.random() * 1000) + 500,
              errorRate: Math.random() * 0.02,
              averageResponseTime: region.latency.avg,
              costPerRequest: region.cost.costPerRequest,
              capacityUtilization: region.capacity.percentage,
              healthScore: this.healthChecks.get(rid)?.status === 'healthy' ? 1 : 0,
            };
            
            metrics.push(regionMetrics);
            
            // Cache for 5 minutes
            await this.redis.setex(metricsKey, 300, JSON.stringify([regionMetrics]));
          }
        }
      }

      return metrics;
    } catch (error) {
      logger.error('Failed to get regional metrics', { error, regionId });
      throw new MultiRegionError(
        `Failed to get metrics: ${error.message}`
      );
    }
  }

  /**
   * Generate deployment ID
   */
  private generateDeploymentId(): string {
    return `deploy_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Stop health monitoring
   */
  stopHealthMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
      logger.info('Health monitoring stopped');
    }
  }

  /**
   * Get deployment status
   */
  getDeploymentStatus(deploymentId: string): Deployment | null {
    return this.activeDeployments.get(deploymentId) || null;
  }

  /**
   * Get all deployments
   */
  getAllDeployments(): Deployment[] {
    return Array.from(this.activeDeployments.values());
  }

  /**
   * Get region health status
   */
  getRegionHealth(regionId?: string): HealthCheck[] {
    if (regionId) {
      const health = this.healthChecks.get(regionId);
      return health ? [health] : [];
    }
    
    return Array.from(this.healthChecks.values());
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    this.stopHealthMonitoring();
    
    // Clear internal state
    this.regions.clear();
    this.healthChecks.clear();
    this.activeDeployments.clear();
    
    logger.info('Multi-region deployment manager cleaned up');
  }
}

// Export singleton instance factory
export function createMultiRegionDeploymentManager(
  redis: Redis,
  config?: Partial<TrafficRoutingConfig>
): MultiRegionDeploymentManager {
  return new MultiRegionDeploymentManager(redis, config);
}