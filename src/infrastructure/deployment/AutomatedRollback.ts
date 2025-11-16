/**
 * Automated Rollback System
 * Enterprise-grade deployment rollback with health checks, traffic shifting,
 * and comprehensive recovery procedures
 */

import { z } from 'zod';
import Redis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { logger } from '../../shared/utils/logger';
import { circuitBreaker, CircuitBreakerOptions } from '../../shared/utils/circuitBreaker';

// Validation schemas
const RollbackPolicySchema = z.object({
  id: z.string(),
  name: z.string(),
  conditions: z.array(z.object({
    type: z.enum(['health_check', 'error_rate', 'response_time', 'user_satisfaction', 'custom_metric']),
    threshold: z.number(),
    operator: z.enum(['gt', 'lt', 'eq', 'gte', 'lte']),
    duration: z.number(), // seconds
    severity: z.enum(['low', 'medium', 'high', 'critical']),
  })),
  actions: z.array(z.object({
    type: z.enum(['immediate_rollback', 'gradual_rollback', 'traffic_shift', 'scale_down', 'notify']),
    parameters: z.record(z.any()),
    order: z.number(),
  })),
  isActive: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const DeploymentContextSchema = z.object({
  deploymentId: z.string(),
  version: z.string(),
  startTime: z.date(),
  status: z.enum(['pending', 'deploying', 'success', 'failed', 'rolling_back']),
  metadata: z.object({
    region: z.string(),
    environment: z.string(),
    strategy: z.enum(['rolling', 'blue_green', 'canary']),
    trafficPercentage: z.number(),
    healthCheckUrl: z.string().url(),
    previousVersion: z.string().optional(),
    rollbackConfig: z.any().optional(),
  }),
});

const RollbackExecutionSchema = z.object({
  id: z.string(),
  deploymentId: z.string(),
  policyId: z.string(),
  triggerReason: z.string(),
  startTime: z.date(),
  endTime: z.date().optional(),
  status: z.enum(['initiated', 'in_progress', 'success', 'failed', 'partial']),
  actionsExecuted: z.array(z.object({
    action: z.string(),
    status: z.enum(['pending', 'success', 'failed', 'skipped']),
    startTime: z.date(),
    endTime: z.date().optional(),
    result: z.object({
      success: z.boolean(),
      message: z.string(),
      data: z.any().optional(),
    }).optional(),
  })),
  timeline: z.array(z.object({
    timestamp: z.date(),
    event: z.string(),
    details: z.record(z.any()),
  })),
});

const HealthCheckResultSchema = z.object({
  timestamp: z.date(),
  service: z.string(),
  endpoint: z.string(),
  status: z.enum(['healthy', 'degraded', 'unhealthy', 'critical']),
  responseTime: z.number(),
  errorRate: z.number(),
  availability: z.number(),
  issues: z.array(z.string()),
  metadata: z.record(z.any()),
});

// Types
export type RollbackPolicy = z.infer<typeof RollbackPolicySchema>;
export type DeploymentContext = z.infer<typeof DeploymentContextSchema>;
export type RollbackExecution = z.infer<typeof RollbackExecutionSchema>;
export type HealthCheckResult = z.infer<typeof HealthCheckResultSchema>;

export interface RollbackConfig {
  enableAutomaticRollback: boolean;
  maxRollbackDuration: number; // seconds
  healthCheckInterval: number; // milliseconds
  retryAttempts: number;
  notificationChannels: {
    slack: boolean;
    email: boolean;
    webhook: boolean;
  };
  recoveryStrategies: {
    immediate: boolean;
    gradual: boolean;
    canary: boolean;
  };
}

export interface RollbackTrigger {
  type: 'automatic' | 'manual' | 'health_check' | 'metrics';
  reason: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  metadata: Record<string, any>;
  timestamp: Date;
}

export interface RecoveryMetrics {
  rollbackDuration: number;
  downtime: number;
  affectedUsers: number;
  dataLoss: boolean;
  systemRestored: boolean;
  lessonsLearned: string[];
  recommendations: string[];
}

// Error types
export class RollbackError extends Error {
  constructor(
    message: string,
    public deploymentId?: string,
    public code?: string
  ) {
    super(message);
    this.name = 'RollbackError';
  }
}

export class HealthCheckFailureError extends RollbackError {
  constructor(message: string, deploymentId: string, public healthData: HealthCheckResult) {
    super(message, deploymentId, 'HEALTH_CHECK_FAILED');
  }
}

export class RollbackTimeoutError extends RollbackError {
  constructor(message: string, deploymentId: string, public timeoutMs: number) {
    super(message, deploymentId, 'ROLLBACK_TIMEOUT');
  }
}

/**
 * Automated Rollback System Manager
 * Handles deployment rollback with intelligent health monitoring and recovery
 */
export class AutomatedRollbackSystem {
  private rollbackPolicies: Map<string, RollbackPolicy> = new Map();
  private activeDeployments: Map<string, DeploymentContext> = new Map();
  private rollbackExecutions: Map<string, RollbackExecution> = new Map();
  private healthCheckResults: Map<string, HealthCheckResult[]> = new Map();
  private redis: Redis;
  private prisma: PrismaClient;
  private config: RollbackConfig;
  private circuitBreakerOptions: CircuitBreakerOptions;
  private monitoringInterval?: NodeJS.Timeout;
  private healthCheckInterval?: NodeJS.Timeout;

  constructor(
    redis: Redis,
    prisma: PrismaClient,
    config: Partial<RollbackConfig> = {}
  ) {
    this.redis = redis;
    this.prisma = prisma;
    this.config = {
      enableAutomaticRollback: true,
      maxRollbackDuration: 300, // 5 minutes
      healthCheckInterval: 10000, // 10 seconds
      retryAttempts: 3,
      notificationChannels: {
        slack: true,
        email: true,
        webhook: false,
      },
      recoveryStrategies: {
        immediate: true,
        gradual: true,
        canary: true,
      },
      ...config,
    };

    this.circuitBreakerOptions = {
      threshold: 0.1,
      timeout: 30000,
      resetTimeout: 60000,
      fallback: async () => null,
    };

    this.initializeDefaultPolicies();
    this.startMonitoring();
  }

  /**
   * Initialize default rollback policies
   */
  private async initializeDefaultPolicies(): Promise<void> {
    const defaultPolicies: RollbackPolicy[] = [
      {
        id: 'critical_health_policy',
        name: 'Critical Health Check Failure',
        conditions: [
          {
            type: 'health_check',
            threshold: 0,
            operator: 'eq',
            duration: 30,
            severity: 'critical',
          },
        ],
        actions: [
          {
            type: 'immediate_rollback',
            parameters: {
              force: true,
              skipHealthChecks: false,
            },
            order: 1,
          },
          {
            type: 'notify',
            parameters: {
              channels: ['slack', 'email'],
              severity: 'critical',
            },
            order: 2,
          },
        ],
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'high_error_rate_policy',
        name: 'High Error Rate Detection',
        conditions: [
          {
            type: 'error_rate',
            threshold: 5.0, // 5%
            operator: 'gt',
            duration: 60,
            severity: 'high',
          },
        ],
        actions: [
          {
            type: 'gradual_rollback',
            parameters: {
              steps: 3,
              stepDuration: 60,
              trafficReduction: 25,
            },
            order: 1,
          },
          {
            type: 'traffic_shift',
            parameters: {
              targetPercentage: 0,
              duration: 120,
            },
            order: 2,
          },
        ],
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'response_time_policy',
        name: 'High Response Time',
        conditions: [
          {
            type: 'response_time',
            threshold: 5000, // 5 seconds
            operator: 'gt',
            duration: 120,
            severity: 'medium',
          },
        ],
        actions: [
          {
            type: 'traffic_shift',
            parameters: {
              targetPercentage: 50,
              duration: 180,
            },
            order: 1,
          },
          {
            type: 'scale_down',
            parameters: {
              reductionPercentage: 30,
            },
            order: 2,
          },
        ],
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    for (const policy of defaultPolicies) {
      await this.registerRollbackPolicy(policy);
    }
  }

  /**
   * Register deployment for monitoring
   */
  async registerDeployment(deployment: DeploymentContext): Promise<void> {
    try {
      const validatedDeployment = DeploymentContextSchema.parse(deployment);
      
      this.activeDeployments.set(validatedDeployment.deploymentId, validatedDeployment);

      // Store in Redis for persistence
      await this.redis.setex(
        `rollback:deployment:${validatedDeployment.deploymentId}`,
        86400,
        JSON.stringify(validatedDeployment)
      );

      // Initialize health check tracking
      this.healthCheckResults.set(validatedDeployment.deploymentId, []);

      logger.info('Deployment registered for rollback monitoring', {
        deploymentId: validatedDeployment.deploymentId,
        version: validatedDeployment.version,
        strategy: validatedDeployment.metadata.strategy,
      });

    } catch (error) {
      logger.error('Failed to register deployment', { error, deployment });
      throw new RollbackError(
        `Failed to register deployment: ${error.message}`,
        deployment.deploymentId
      );
    }
  }

  /**
   * Register rollback policy
   */
  async registerRollbackPolicy(policy: RollbackPolicy): Promise<void> {
    try {
      const validatedPolicy = RollbackPolicySchema.parse(policy);
      
      this.rollbackPolicies.set(validatedPolicy.id, validatedPolicy);

      // Store in Redis
      await this.redis.setex(
        `rollback:policy:${validatedPolicy.id}`,
        86400,
        JSON.stringify(validatedPolicy)
      );

      logger.info('Rollback policy registered', {
        policyId: validatedPolicy.id,
        name: validatedPolicy.name,
        conditions: validatedPolicy.conditions.length,
        actions: validatedPolicy.actions.length,
      });

    } catch (error) {
      logger.error('Failed to register rollback policy', { error, policy });
      throw new RollbackError(
        `Failed to register policy: ${error.message}`,
        undefined,
        'POLICY_REGISTRATION_FAILED'
      );
    }
  }

  /**
   * Monitor deployment health and trigger rollback if needed
   */
  private startMonitoring(): void {
    // Start health check monitoring
    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthChecks();
    }, this.config.healthCheckInterval);

    // Start policy evaluation monitoring
    this.monitoringInterval = setInterval(async () => {
      await this.evaluateRollbackPolicies();
    }, this.config.healthCheckInterval * 2); // Check policies every 20 seconds

    logger.info('Rollback monitoring started', {
      healthCheckInterval: this.config.healthCheckInterval,
      automaticRollback: this.config.enableAutomaticRollback,
    });
  }

  /**
   * Perform health checks on active deployments
   */
  private async performHealthChecks(): Promise<void> {
    const checkTasks = Array.from(this.activeDeployments.entries())
      .filter(([_, deployment]) => deployment.status === 'deploying' || deployment.status === 'success')
      .map(([deploymentId, deployment]) => 
        this.checkDeploymentHealth(deploymentId, deployment)
      );

    await Promise.allSettled(checkTasks);
  }

  /**
   * Check health of specific deployment
   */
  private async checkDeploymentHealth(deploymentId: string, deployment: DeploymentContext): Promise<void> {
    try {
      const healthCheckUrl = deployment.metadata.healthCheckUrl;
      if (!healthCheckUrl) {
        logger.warn('No health check URL configured', { deploymentId });
        return;
      }

      const startTime = Date.now();

      // Perform health check with circuit breaker protection
      const circuitBreakerFn = circuitBreaker(this.circuitBreakerOptions);
      
      const healthResult = await circuitBreakerFn(async () => {
        const response = await fetch(healthCheckUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'Vow-Rollback-HealthCheck/1.0',
          },
          timeout: 10000,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return response.json();
      });

      const responseTime = Date.now() - startTime;

      // Determine health status based on response
      let status: HealthCheckResult['status'] = 'healthy';
      const issues: string[] = [];

      if (!healthResult) {
        status = 'unhealthy';
        issues.push('No response from health check');
      } else {
        // Check various health indicators
        if (healthResult.errorRate && healthResult.errorRate > 10) {
          status = 'critical';
          issues.push(`High error rate: ${healthResult.errorRate}%`);
        } else if (healthResult.errorRate && healthResult.errorRate > 5) {
          status = 'degraded';
          issues.push(`Elevated error rate: ${healthResult.errorRate}%`);
        }

        if (responseTime > 10000) {
          status = status === 'healthy' ? 'degraded' : status;
          issues.push(`Slow response time: ${responseTime}ms`);
        }

        if (healthResult.availability && healthResult.availability < 95) {
          status = status === 'healthy' ? 'degraded' : status;
          issues.push(`Low availability: ${healthResult.availability}%`);
        }
      }

      const healthCheckResult: HealthCheckResult = {
        timestamp: new Date(),
        service: 'vow-api',
        endpoint: healthCheckUrl,
        status,
        responseTime,
        errorRate: healthResult?.errorRate || 0,
        availability: healthResult?.availability || 100,
        issues,
        metadata: {
          deploymentId,
          version: deployment.version,
          responseSize: healthResult ? JSON.stringify(healthResult).length : 0,
        },
      };

      // Store health check result
      const results = this.healthCheckResults.get(deploymentId) || [];
      results.push(healthCheckResult);
      
      // Keep only recent results (last 100)
      if (results.length > 100) {
        results.splice(0, results.length - 100);
      }
      
      this.healthCheckResults.set(deploymentId, results);

      // Store in Redis
      await this.redis.setex(
        `rollback:health:${deploymentId}:${healthCheckResult.timestamp.getTime()}`,
        3600,
        JSON.stringify(healthCheckResult)
      );

      // Trigger rollback if health is critical
      if (status === 'critical' && this.config.enableAutomaticRollback) {
        await this.triggerRollback(
          deploymentId,
          {
            type: 'health_check',
            reason: `Critical health check failure: ${issues.join(', ')}`,
            severity: 'critical',
            metadata: {
              healthCheckResult,
              issues,
            },
            timestamp: new Date(),
          }
        );
      }

    } catch (error) {
      logger.error('Health check failed', { deploymentId, error });
      
      // Record failed health check
      const failedHealthCheck: HealthCheckResult = {
        timestamp: new Date(),
        service: 'vow-api',
        endpoint: deployment.metadata.healthCheckUrl || 'unknown',
        status: 'unhealthy',
        responseTime: 0,
        errorRate: 100,
        availability: 0,
        issues: [`Health check error: ${error.message}`],
        metadata: {
          deploymentId,
          error: error.message,
        },
      };

      const results = this.healthCheckResults.get(deploymentId) || [];
      results.push(failedHealthCheck);
      this.healthCheckResults.set(deploymentId, results);

      // Trigger rollback for health check failures
      if (this.config.enableAutomaticRollback) {
        await this.triggerRollback(
          deploymentId,
          {
            type: 'health_check',
            reason: `Health check failed: ${error.message}`,
            severity: 'critical',
            metadata: { error: error.message },
            timestamp: new Date(),
          }
        );
      }
    }
  }

  /**
   * Evaluate rollback policies against current deployment state
   */
  private async evaluateRollbackPolicies(): Promise<void> {
    for (const [deploymentId, deployment] of this.activeDeployments) {
      if (deployment.status !== 'deploying' && deployment.status !== 'success') {
        continue; // Skip deployments that are already in failed or rollback states
      }

      try {
        const healthResults = this.healthCheckResults.get(deploymentId) || [];
        if (healthResults.length === 0) {
          continue; // No health data yet
        }

        // Check each policy against current state
        for (const [policyId, policy] of this.rollbackPolicies) {
          if (!policy.isActive) continue;

          const shouldRollback = await this.evaluatePolicy(policy, healthResults, deployment);
          
          if (shouldRollback) {
            await this.triggerRollback(deploymentId, {
              type: 'automatic',
              reason: `Rollback policy '${policy.name}' triggered`,
              severity: 'high',
              metadata: {
                policyId,
                healthResults: healthResults.slice(-5), // Last 5 results
              },
              timestamp: new Date(),
            });
            break; // Only trigger one policy at a time
          }
        }

      } catch (error) {
        logger.error('Policy evaluation failed', { deploymentId, error });
      }
    }
  }

  /**
   * Evaluate specific policy against health results
   */
  private async evaluatePolicy(
    policy: RollbackPolicy,
    healthResults: HealthCheckResult[],
    deployment: DeploymentContext
  ): Promise<boolean> {
    // Get recent results based on condition duration
    const maxDuration = Math.max(...policy.conditions.map(c => c.duration));
    const recentResults = healthResults.filter(result => 
      Date.now() - result.timestamp.getTime() <= maxDuration * 1000
    );

    if (recentResults.length === 0) {
      return false;
    }

    // Check each condition
    for (const condition of policy.conditions) {
      const conditionMet = await this.evaluateCondition(condition, recentResults, deployment);
      
      if (!conditionMet) {
        return false; // All conditions must be met
      }
    }

    return true; // All conditions met
  }

  /**
   * Evaluate specific condition
   */
  private async evaluateCondition(
    condition: RollbackPolicy['conditions'][0],
    healthResults: HealthCheckResult[],
    deployment: DeploymentContext
  ): Promise<boolean> {
    const recentResults = healthResults.slice(-condition.duration); // Last N results

    if (recentResults.length < condition.duration / 10) {
      // Not enough data points, consider condition not met
      return false;
    }

    switch (condition.type) {
      case 'health_check':
        const unhealthyCount = recentResults.filter(r => 
          r.status === 'unhealthy' || r.status === 'critical'
        ).length;
        return this.compareValues(unhealthyCount, condition.threshold, condition.operator);

      case 'error_rate':
        const avgErrorRate = recentResults.reduce((sum, r) => sum + r.errorRate, 0) / recentResults.length;
        return this.compareValues(avgErrorRate, condition.threshold, condition.operator);

      case 'response_time':
        const avgResponseTime = recentResults.reduce((sum, r) => sum + r.responseTime, 0) / recentResults.length;
        return this.compareValues(avgResponseTime, condition.threshold, condition.operator);

      case 'availability':
        const avgAvailability = recentResults.reduce((sum, r) => sum + r.availability, 0) / recentResults.length;
        return this.compareValues(avgAvailability, condition.threshold, condition.operator);

      default:
        return false;
    }
  }

  /**
   * Compare values based on operator
   */
  private compareValues(actual: number, threshold: number, operator: string): boolean {
    switch (operator) {
      case 'gt': return actual > threshold;
      case 'gte': return actual >= threshold;
      case 'lt': return actual < threshold;
      case 'lte': return actual <= threshold;
      case 'eq': return actual === threshold;
      default: return false;
    }
  }

  /**
   * Trigger rollback for deployment
   */
  async triggerRollback(deploymentId: string, trigger: RollbackTrigger): Promise<string> {
    try {
      const deployment = this.activeDeployments.get(deploymentId);
      if (!deployment) {
        throw new RollbackError(`Deployment not found: ${deploymentId}`, deploymentId);
      }

      if (deployment.status === 'rolling_back') {
        logger.info('Rollback already in progress', { deploymentId });
        return deploymentId;
      }

      // Find applicable policy
      const applicablePolicy = this.findApplicablePolicy(trigger);
      
      const rollbackExecution: RollbackExecution = {
        id: `rollback_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        deploymentId,
        policyId: applicablePolicy?.id || 'manual',
        triggerReason: trigger.reason,
        startTime: new Date(),
        status: 'initiated',
        actionsExecuted: applicablePolicy?.actions.map(action => ({
          action: action.type,
          status: 'pending',
          startTime: new Date(),
        })) || [],
        timeline: [
          {
            timestamp: new Date(),
            event: 'rollback_initiated',
            details: {
              trigger,
              policy: applicablePolicy?.name || 'Manual',
            },
          },
        ],
      };

      // Store rollback execution
      this.rollbackExecutions.set(rollbackExecution.id, rollbackExecution);
      
      // Update deployment status
      deployment.status = 'rolling_back';
      this.activeDeployments.set(deploymentId, deployment);

      // Store in Redis
      await this.redis.setex(
        `rollback:execution:${rollbackExecution.id}`,
        86400,
        JSON.stringify(rollbackExecution)
      );

      logger.warn('Rollback initiated', {
        deploymentId,
        trigger: trigger.type,
        reason: trigger.reason,
        policy: applicablePolicy?.name || 'Manual',
        severity: trigger.severity,
      });

      // Start rollback execution
      this.executeRollback(rollbackExecution, applicablePolicy);

      return rollbackExecution.id;

    } catch (error) {
      logger.error('Failed to trigger rollback', { deploymentId, error });
      throw new RollbackError(
        `Failed to trigger rollback: ${error.message}`,
        deploymentId,
        'ROLLBACK_TRIGGER_FAILED'
      );
    }
  }

  /**
   * Find applicable rollback policy for trigger
   */
  private findApplicablePolicy(trigger: RollbackTrigger): RollbackPolicy | null {
    // For now, use the policy with matching condition type
    // In production, this would be more sophisticated
    if (trigger.type === 'health_check') {
      return this.rollbackPolicies.get('critical_health_policy') || null;
    }
    
    // Return first active policy as fallback
    return Array.from(this.rollbackPolicies.values()).find(p => p.isActive) || null;
  }

  /**
   * Execute rollback with all configured actions
   */
  private async executeRollback(execution: RollbackExecution, policy?: RollbackPolicy): Promise<void> {
    try {
      execution.status = 'in_progress';
      
      if (!policy) {
        // Manual rollback with default immediate action
        await this.executeAction(execution, {
          type: 'immediate_rollback',
          parameters: {},
          order: 1,
        });
      } else {
        // Execute actions in order
        for (const action of policy.actions.sort((a, b) => a.order - b.order)) {
          await this.executeAction(execution, action);
          
          // Check if rollback was successful after each action
          if (await this.checkRollbackSuccess(execution.deploymentId)) {
            break;
          }
        }
      }

      execution.status = 'success';
      execution.endTime = new Date();

      logger.info('Rollback completed successfully', {
        executionId: execution.id,
        deploymentId: execution.deploymentId,
        duration: execution.endTime.getTime() - execution.startTime.getTime(),
      });

      await this.sendRollbackNotifications(execution, 'success');

    } catch (error) {
      execution.status = 'failed';
      execution.endTime = new Date();
      
      execution.timeline.push({
        timestamp: new Date(),
        event: 'rollback_failed',
        details: {
          error: error.message,
          stack: error.stack,
        },
      });

      logger.error('Rollback execution failed', {
        executionId: execution.id,
        deploymentId: execution.deploymentId,
        error,
      });

      await this.sendRollbackNotifications(execution, 'failed');
      
      throw new RollbackError(
        `Rollback execution failed: ${error.message}`,
        execution.deploymentId,
        'ROLLBACK_EXECUTION_FAILED'
      );
    }

    // Update execution in Redis
    await this.redis.setex(
      `rollback:execution:${execution.id}`,
      86400,
      JSON.stringify(execution)
    );
  }

  /**
   * Execute specific rollback action
   */
  private async executeAction(execution: RollbackExecution, action: RollbackPolicy['actions'][0]): Promise<void> {
    const actionIndex = execution.actionsExecuted.findIndex(a => a.action === action.type);
    if (actionIndex !== -1) {
      execution.actionsExecuted[actionIndex].startTime = new Date();
      execution.actionsExecuted[actionIndex].status = 'in_progress';
    }

    try {
      logger.info('Executing rollback action', {
        executionId: execution.id,
        deploymentId: execution.deploymentId,
        action: action.type,
        parameters: action.parameters,
      });

      execution.timeline.push({
        timestamp: new Date(),
        event: 'action_started',
        details: {
          action: action.type,
          parameters: action.parameters,
        },
      });

      switch (action.type) {
        case 'immediate_rollback':
          await this.executeImmediateRollback(execution, action.parameters);
          break;
        
        case 'gradual_rollback':
          await this.executeGradualRollback(execution, action.parameters);
          break;
        
        case 'traffic_shift':
          await this.executeTrafficShift(execution, action.parameters);
          break;
        
        case 'scale_down':
          await this.executeScaleDown(execution, action.parameters);
          break;
        
        case 'notify':
          await this.executeNotification(execution, action.parameters);
          break;
        
        default:
          throw new Error(`Unknown action type: ${action.type}`);
      }

      // Update action status
      if (actionIndex !== -1) {
        execution.actionsExecuted[actionIndex].status = 'success';
        execution.actionsExecuted[actionIndex].endTime = new Date();
        execution.actionsExecuted[actionIndex].result = {
          success: true,
          message: `${action.type} completed successfully`,
        };
      }

      execution.timeline.push({
        timestamp: new Date(),
        event: 'action_completed',
        details: {
          action: action.type,
          success: true,
        },
      });

      logger.info('Rollback action completed', {
        executionId: execution.id,
        action: action.type,
      });

    } catch (error) {
      // Update action status
      if (actionIndex !== -1) {
        execution.actionsExecuted[actionIndex].status = 'failed';
        execution.actionsExecuted[actionIndex].endTime = new Date();
        execution.actionsExecuted[actionIndex].result = {
          success: false,
          message: error.message,
        };
      }

      execution.timeline.push({
        timestamp: new Date(),
        event: 'action_failed',
        details: {
          action: action.type,
          error: error.message,
        },
      });

      logger.error('Rollback action failed', {
        executionId: execution.id,
        action: action.type,
        error,
      });

      throw error;
    }
  }

  /**
   * Execute immediate rollback
   */
  private async executeImmediateRollback(
    execution: RollbackExecution,
    parameters: any
  ): Promise<void> {
    const deployment = this.activeDeployments.get(execution.deploymentId);
    if (!deployment) {
      throw new RollbackError(`Deployment not found: ${execution.deploymentId}`, execution.deploymentId);
    }

    const force = parameters.force || false;
    const skipHealthChecks = parameters.skipHealthChecks || false;

    try {
      // Get previous version if available
      const previousVersion = deployment.metadata.previousVersion;
      if (!previousVersion && !force) {
        throw new RollbackError('No previous version available for rollback', execution.deploymentId);
      }

      // Initiate rollback deployment
      const rollbackDeployment = await this.initiateRollbackDeployment(deployment, previousVersion);

      // Wait for rollback to complete if not forced
      if (!force) {
        await this.waitForRollbackCompletion(rollbackDeployment.id, this.config.maxRollbackDuration * 1000);
      }

      logger.info('Immediate rollback completed', {
        executionId: execution.id,
        deploymentId: execution.deploymentId,
        targetVersion: previousVersion,
        forced: force,
      });

    } catch (error) {
      logger.error('Immediate rollback failed', {
        executionId: execution.id,
        error,
      });
      throw error;
    }
  }

  /**
   * Execute gradual rollback
   */
  private async executeGradualRollback(
    execution: RollbackExecution,
    parameters: any
  ): Promise<void> {
    const steps = parameters.steps || 3;
    const stepDuration = parameters.stepDuration || 60;
    const trafficReduction = parameters.trafficReduction || 25;

    const deployment = this.activeDeployments.get(execution.deploymentId);
    if (!deployment) {
      throw new RollbackError(`Deployment not found: ${execution.deploymentId}`, execution.deploymentId);
    }

    let currentTrafficPercentage = deployment.metadata.trafficPercentage || 100;

    for (let step = 1; step <= steps; step++) {
      // Reduce traffic
      currentTrafficPercentage = Math.max(0, currentTrafficPercentage - trafficReduction);
      
      await this.shiftTraffic(execution.deploymentId, currentTrafficPercentage);
      
      logger.info('Gradual rollback step completed', {
        executionId: execution.id,
        step,
        totalSteps: steps,
        trafficPercentage: currentTrafficPercentage,
      });

      // Wait before next step
      if (step < steps) {
        await new Promise(resolve => setTimeout(resolve, stepDuration * 1000));
      }
    }

    // Complete the rollback
    await this.executeImmediateRollback(execution, { force: true });

    logger.info('Gradual rollback completed', {
      executionId: execution.id,
      totalSteps: steps,
    });
  }

  /**
   * Execute traffic shift
   */
  private async executeTrafficShift(
    execution: RollbackExecution,
    parameters: any
  ): Promise<void> {
    const targetPercentage = parameters.targetPercentage || 0;
    const duration = parameters.duration || 120;

    await this.shiftTraffic(execution.deploymentId, targetPercentage);

    // Wait for traffic shift to complete
    await new Promise(resolve => setTimeout(resolve, duration * 1000));

    logger.info('Traffic shift completed', {
      executionId: execution.id,
      targetPercentage,
    });
  }

  /**
   * Execute scale down
   */
  private async executeScaleDown(
    execution: RollbackExecution,
    parameters: any
  ): Promise<void> {
    const reductionPercentage = parameters.reductionPercentage || 30;

    const deployment = this.activeDeployments.get(execution.deploymentId);
    if (!deployment) {
      throw new RollbackError(`Deployment not found: ${execution.deploymentId}`, execution.deploymentId);
    }

    try {
      // Call scaling API to reduce capacity
      const circuitBreakerFn = circuitBreaker(this.circuitBreakerOptions);
      
      await circuitBreakerFn(async () => {
        const response = await fetch(`${process.env.DEPLOYMENT_API_URL}/api/scale`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.DEPLOYMENT_TOKEN}`,
          },
          body: JSON.stringify({
            deploymentId: execution.deploymentId,
            action: 'scale_down',
            percentage: reductionPercentage,
          }),
        });

        if (!response.ok) {
          throw new Error(`Scaling failed: ${response.statusText}`);
        }

        return response.json();
      });

      logger.info('Scale down completed', {
        executionId: execution.id,
        reductionPercentage,
      });

    } catch (error) {
      logger.error('Scale down failed', { executionId: execution.id, error });
      throw error;
    }
  }

  /**
   * Execute notification
   */
  private async executeNotification(
    execution: RollbackExecution,
    parameters: any
  ): Promise<void> {
    const channels = parameters.channels || ['slack', 'email'];
    const severity = parameters.severity || 'high';

    // Send notifications to configured channels
    for (const channel of channels) {
      if (channel === 'slack' && this.config.notificationChannels.slack) {
        await this.sendSlackNotification(execution, severity);
      }
      
      if (channel === 'email' && this.config.notificationChannels.email) {
        await this.sendEmailNotification(execution, severity);
      }
    }

    logger.info('Notifications sent', {
      executionId: execution.id,
      channels,
      severity,
    });
  }

  /**
   * Check if rollback was successful
   */
  private async checkRollbackSuccess(deploymentId: string): Promise<boolean> {
    try {
      const deployment = this.activeDeployments.get(deploymentId);
      if (!deployment) {
        return false;
      }

      // Check recent health results
      const healthResults = this.healthCheckResults.get(deploymentId) || [];
      const recentResults = healthResults.slice(-10); // Last 10 checks

      if (recentResults.length === 0) {
        return false;
      }

      // Check if all recent health checks are healthy
      const allHealthy = recentResults.every(result => 
        result.status === 'healthy' || result.status === 'degraded'
      );

      // Check if error rate is acceptable
      const avgErrorRate = recentResults.reduce((sum, r) => sum + r.errorRate, 0) / recentResults.length;
      const acceptableErrorRate = avgErrorRate < 5;

      // Check if response time is acceptable
      const avgResponseTime = recentResults.reduce((sum, r) => sum + r.responseTime, 0) / recentResults.length;
      const acceptableResponseTime = avgResponseTime < 3000;

      return allHealthy && acceptableErrorRate && acceptableResponseTime;

    } catch (error) {
      logger.error('Failed to check rollback success', { deploymentId, error });
      return false;
    }
  }

  /**
   * Shift traffic to target percentage
   */
  private async shiftTraffic(deploymentId: string, targetPercentage: number): Promise<void> {
    try {
      const circuitBreakerFn = circuitBreaker(this.circuitBreakerOptions);
      
      await circuitBreakerFn(async () => {
        const response = await fetch(`${process.env.DEPLOYMENT_API_URL}/api/traffic/shift`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.DEPLOYMENT_TOKEN}`,
          },
          body: JSON.stringify({
            deploymentId,
            targetPercentage,
          }),
        });

        if (!response.ok) {
          throw new Error(`Traffic shift failed: ${response.statusText}`);
        }

        return response.json();
      });

      // Update deployment metadata
      const deployment = this.activeDeployments.get(deploymentId);
      if (deployment) {
        deployment.metadata.trafficPercentage = targetPercentage;
        this.activeDeployments.set(deploymentId, deployment);
      }

    } catch (error) {
      logger.error('Traffic shift failed', { deploymentId, targetPercentage, error });
      throw error;
    }
  }

  /**
   * Initiate rollback deployment
   */
  private async initiateRollbackDeployment(
    currentDeployment: DeploymentContext,
    targetVersion?: string
  ): Promise<DeploymentContext> {
    try {
      const circuitBreakerFn = circuitBreaker(this.circuitBreakerOptions);
      
      const rollbackDeployment = await circuitBreakerFn(async () => {
        const response = await fetch(`${process.env.DEPLOYMENT_API_URL}/api/deployments/rollback`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.DEPLOYMENT_TOKEN}`,
          },
          body: JSON.stringify({
            deploymentId: currentDeployment.deploymentId,
            targetVersion,
            strategy: 'immediate',
          }),
        });

        if (!response.ok) {
          throw new Error(`Rollback deployment failed: ${response.statusText}`);
        }

        return response.json();
      });

      const newDeployment: DeploymentContext = {
        deploymentId: rollbackDeployment.id,
        version: targetVersion || currentDeployment.metadata.previousVersion || 'previous',
        startTime: new Date(),
        status: 'deploying',
        metadata: {
          ...currentDeployment.metadata,
          previousVersion: currentDeployment.version,
          strategy: 'rollback',
          healthCheckUrl: rollbackDeployment.healthCheckUrl,
        },
      };

      // Register the rollback deployment
      await this.registerDeployment(newDeployment);

      return newDeployment;

    } catch (error) {
      logger.error('Failed to initiate rollback deployment', { currentDeployment, error });
      throw error;
    }
  }

  /**
   * Wait for rollback completion
   */
  private async waitForRollbackCompletion(deploymentId: string, timeoutMs: number): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const deployment = this.activeDeployments.get(deploymentId);
      
      if (!deployment) {
        throw new RollbackError(`Rollback deployment not found: ${deploymentId}`, deploymentId);
      }

      if (deployment.status === 'success') {
        return; // Rollback completed successfully
      }

      if (deployment.status === 'failed') {
        throw new RollbackError(`Rollback deployment failed: ${deploymentId}`, deploymentId);
      }

      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    throw new RollbackTimeoutError(
      `Rollback completion timeout after ${timeoutMs}ms`,
      deploymentId,
      timeoutMs
    );
  }

  /**
   * Send Slack notification
   */
  private async sendSlackNotification(execution: RollbackExecution, severity: string): Promise<void> {
    try {
      if (!process.env.SLACK_WEBHOOK_URL) {
        return;
      }

      const deployment = this.activeDeployments.get(execution.deploymentId);
      const message = {
        text: `🚨 Rollback ${execution.status.toUpperCase()} - Deployment ${deployment?.version || 'Unknown'}`,
        attachments: [
          {
            color: severity === 'critical' ? 'danger' : 'warning',
            fields: [
              {
                title: 'Deployment ID',
                value: execution.deploymentId,
                short: true,
              },
              {
                title: 'Trigger Reason',
                value: execution.triggerReason,
                short: true,
              },
              {
                title: 'Duration',
                value: `${Math.floor((Date.now() - execution.startTime.getTime()) / 1000)}s`,
                short: true,
              },
              {
                title: 'Status',
                value: execution.status,
                short: true,
              },
            ],
          },
        ],
      };

      await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });

    } catch (error) {
      logger.error('Failed to send Slack notification', { error, executionId: execution.id });
    }
  }

  /**
   * Send email notification
   */
  private async sendEmailNotification(execution: RollbackExecution, severity: string): Promise<void> {
    // In production, this would integrate with email service
    logger.info('Email notification would be sent', {
      executionId: execution.id,
      severity,
      to: process.env.NOTIFICATION_EMAIL || 'ops@vow.com',
    });
  }

  /**
   * Send rollback notifications
   */
  private async sendRollbackNotifications(execution: RollbackExecution, status: 'success' | 'failed'): Promise<void> {
    try {
      if (this.config.notificationChannels.slack) {
        await this.sendSlackNotification(execution, status === 'failed' ? 'critical' : 'warning');
      }
      
      if (this.config.notificationChannels.email) {
        await this.sendEmailNotification(execution, status === 'failed' ? 'critical' : 'warning');
      }

      logger.info('Rollback notifications sent', {
        executionId: execution.id,
        status,
        channels: this.config.notificationChannels,
      });

    } catch (error) {
      logger.error('Failed to send rollback notifications', { error, executionId: execution.id });
    }
  }

  /**
   * Get rollback execution status
   */
  getRollbackStatus(executionId: string): RollbackExecution | null {
    return this.rollbackExecutions.get(executionId) || null;
  }

  /**
   * Get all rollback executions
   */
  getAllRollbackExecutions(): RollbackExecution[] {
    return Array.from(this.rollbackExecutions.values());
  }

  /**
   * Get deployment health history
   */
  getDeploymentHealthHistory(deploymentId: string): HealthCheckResult[] {
    return this.healthCheckResults.get(deploymentId) || [];
  }

  /**
   * Manual rollback trigger
   */
  async manualRollback(
    deploymentId: string,
    reason: string,
    targetVersion?: string
  ): Promise<string> {
    const trigger: RollbackTrigger = {
      type: 'manual',
      reason,
      severity: 'medium',
      metadata: { targetVersion },
      timestamp: new Date(),
    };

    return this.triggerRollback(deploymentId, trigger);
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
    
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }

    logger.info('Rollback monitoring stopped');
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    this.stopMonitoring();
    
    // Clear internal state
    this.rollbackPolicies.clear();
    this.activeDeployments.clear();
    this.rollbackExecutions.clear();
    this.healthCheckResults.clear();
    
    logger.info('Automated rollback system cleaned up');
  }
}

// Export singleton instance factory
export function createAutomatedRollbackSystem(
  redis: Redis,
  prisma: PrismaClient,
  config?: Partial<RollbackConfig>
): AutomatedRollbackSystem {
  return new AutomatedRollbackSystem(redis, prisma, config);
}